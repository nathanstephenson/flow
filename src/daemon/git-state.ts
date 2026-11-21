import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { head, run, GIT_READ_TIMEOUT_MS } from "./git.ts";
import { gh, type Gh } from "./github.ts";
import { resolvePullRequest, resolveRepository, type Repository } from "./repository.ts";
import type { GitState, PullRequestSummary } from "../protocol/git.ts";
import type { SessionLifecycle } from "../protocol/commands.ts";

export type LocalGitState = Omit<GitState, "pr">;
export type PolledSession = { scope: string; lifecycle: SessionLifecycle; watched: boolean };

const READ_INTERVAL_MS = 3_000;
const WATCHED_POLL_MS = 30_000;
const UNWATCHED_POLL_MS = 5 * 60_000;
const pathOffsets: Record<string, number> = { "1": 8, "2": 9, u: 10, "?": 1 };

export async function readLocal(scope: string): Promise<LocalGitState | undefined> {
  const status = await run(scope, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"], GIT_READ_TIMEOUT_MS);
  if (!status.ok) return undefined;
  const records = status.value.split("\0");
  const revision = createHash("sha256").update(status.value);
  const state = { changed: 0, ahead: 0, behind: 0, upstream: false };
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
    if (counts) Object.assign(state, { upstream: true, ahead: Number(counts[1]), behind: Number(counts[2]) });
    const offset = pathOffsets[record[0] ?? ""];
    if (offset === undefined || record[1] !== " ") continue;
    state.changed += 1;
    const stat = await lstat(resolve(scope, record.split(" ").slice(offset).join(" "))).catch(() => undefined);
    revision.update(`\0${stat?.mtimeMs}\0${stat?.size}`);
    if (record[0] === "2") index += 1;
  }
  return { revision: revision.digest("hex").slice(0, 16), ...state };
}

type Entry = { local: LocalGitState | undefined; pr: PullRequestSummary | undefined; lastRead: number; generation: number; trailing: ReturnType<typeof setTimeout> | undefined };
type Group = { scopes: string[]; repository: Repository; branch: string; watched: boolean };

export class GitStates {
  private readonly entries = new Map<string, Entry>();
  private readonly polledAt = new Map<string, number>();

  private readonly github: Gh;
  private readonly read: (scope: string) => Promise<LocalGitState | undefined>;

  constructor(github: Gh = gh, read = readLocal) {
    this.github = github;
    this.read = read;
  }

  private entry(scope: string): Entry {
    let entry = this.entries.get(scope);
    if (!entry) this.entries.set(scope, entry = { local: undefined, pr: undefined, lastRead: -Infinity, generation: 0, trailing: undefined });
    return entry;
  }

  async refresh(scope: string): Promise<void> {
    const entry = this.entry(scope);
    entry.lastRead = Date.now();
    const generation = (entry.generation += 1);
    const local = await this.read(scope);
    if (generation === entry.generation) entry.local = local;
  }

  touch(scope: string): void {
    const entry = this.entry(scope);
    if (entry.trailing) return;
    const wait = entry.lastRead + READ_INTERVAL_MS - Date.now();
    if (wait <= 0) {
      void this.refresh(scope);
      return;
    }
    entry.trailing = setTimeout(() => {
      entry.trailing = undefined;
      void this.refresh(scope);
    }, wait);
    entry.trailing.unref();
  }

  summary(scope: string): GitState | undefined {
    const entry = this.entries.get(scope);
    if (!entry?.local) return undefined;
    return { ...entry.local, ...(entry.pr ? { pr: entry.pr } : {}) };
  }

  async poll(sessions: PolledSession[]): Promise<void> {
    const now = Date.now();
    const groups = new Map<string, Group>();
    for (const session of sessions) {
      if (session.lifecycle !== "live" && session.lifecycle !== "dormant") continue;
      if (!this.entries.get(session.scope)?.local) await this.refresh(session.scope);
      const branch = await head(session.scope);
      if (!branch.ok || branch.value.detached) continue;
      const repository = await resolveRepository(session.scope, branch.value.name, this.github).catch(() => undefined);
      if (!repository) continue;
      const key = `${repository.base.repo}\0${repository.head.repo}\0${branch.value.name}`;
      const group = groups.get(key) ?? { scopes: [], repository, branch: branch.value.name, watched: false };
      if (!group.scopes.includes(session.scope)) group.scopes.push(session.scope);
      group.watched ||= session.watched;
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      if (now - (this.polledAt.get(key) ?? -Infinity) < (group.watched ? WATCHED_POLL_MS : UNWATCHED_POLL_MS)) continue;
      this.polledAt.set(key, now);
      const found = await resolvePullRequest(group.scopes[0]!, group.repository, group.branch, this.github).then(pr => ({ pr }), () => undefined);
      if (!found) continue;
      const pr = found.pr && { number: found.pr.number, url: found.pr.url, state: found.pr.state, isDraft: found.pr.isDraft, checks: found.pr.checks, reviewDecision: found.pr.reviewDecision, unresolvedThreads: found.pr.unresolvedThreads };
      for (const scope of group.scopes) this.entry(scope).pr = pr;
    }
  }
}
