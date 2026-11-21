import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { head, isRepository, run, GIT_READ_TIMEOUT_MS } from "./git.ts";
import { gh, type Gh } from "./github.ts";
import { releaseRepositories, resolvePullRequest, resolveRepository, type Repository } from "./repository.ts";
import type { GitState, PullRequestSummary } from "../protocol/git.ts";
import type { SessionLifecycle } from "../protocol/commands.ts";

export type LocalGitState = Omit<GitState, "pr"> & { branch: string | undefined };
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
  const state = { changed: 0, ahead: 0, behind: 0, upstream: false, branch: undefined as string | undefined };
  for (let index = 0; index < records.length; index++) {
    const record = records[index]!;
    const counts = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
    if (counts) Object.assign(state, { upstream: true, ahead: Number(counts[1]), behind: Number(counts[2]) });
    const branch = /^# branch\.head (.+)$/.exec(record)?.[1];
    if (branch && branch !== "(detached)") state.branch = branch;
    const offset = pathOffsets[record[0] ?? ""];
    if (offset === undefined || record[1] !== " ") continue;
    state.changed += 1;
    const stat = await lstat(resolve(scope, record.split(" ").slice(offset).join(" "))).catch(() => undefined);
    revision.update(`\0${stat?.mtimeMs}\0${stat?.size}`);
    if (record[0] === "2") index += 1;
  }
  return { revision: revision.digest("hex").slice(0, 16), ...state };
}

type Entry = { local: LocalGitState | undefined; pr: PullRequestSummary | undefined; prBase: string | undefined; prBranch: string | undefined; lastRead: number; generation: number; trailing: ReturnType<typeof setTimeout> | undefined };
type Group = { scopes: string[]; repository: Repository; branch: string; watched: boolean; forced: boolean };

export class GitStates {
  private readonly entries = new Map<string, Entry>();
  private readonly polledAt = new Map<string, number>();
  private readonly results = new Map<string, PullRequestSummary | undefined>();
  private readonly bases = new Map<string, string | undefined>();

  private readonly github: Gh;
  private readonly read: (scope: string) => Promise<LocalGitState | undefined>;

  constructor(github: Gh = gh, read = readLocal) {
    this.github = github;
    this.read = read;
  }

  private entry(scope: string): Entry {
    let entry = this.entries.get(scope);
    if (!entry) this.entries.set(scope, entry = { local: undefined, pr: undefined, prBase: undefined, prBranch: undefined, lastRead: -Infinity, generation: 0, trailing: undefined });
    return entry;
  }

  async refresh(scope: string): Promise<void> {
    const entry = this.entry(scope);
    entry.lastRead = Date.now();
    const generation = (entry.generation += 1);
    const local = await this.read(scope);
    if (generation !== entry.generation) return;
    entry.local = local;
    if (local?.branch !== entry.prBranch) entry.pr = undefined;
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
    const { revision, changed, ahead, behind, upstream } = entry.local;
    return { revision, changed, ahead, behind, upstream, ...(entry.pr ? { pr: entry.pr } : {}) };
  }

  pullRequestBase(scope: string, branch: string): string | undefined {
    const entry = this.entries.get(scope);
    return entry?.pr && entry.prBranch === branch ? entry.prBase : undefined;
  }

  async poll(sessions: PolledSession[], forced?: string): Promise<void> {
    const now = Date.now();
    const scopes = new Map<string, boolean>();
    for (const session of sessions) {
      if (session.lifecycle === "live" || session.lifecycle === "dormant") scopes.set(session.scope, scopes.get(session.scope) || session.watched);
    }
    const groups = new Map<string, Group>();
    for (const [scope, watched] of scopes) {
      if (!isRepository(scope)) continue;
      if (!this.entries.get(scope)?.local) await this.refresh(scope);
      const entry = this.entry(scope);
      const branch = await head(scope);
      const name = branch.ok && !branch.value.detached ? branch.value.name : undefined;
      const repository = name === undefined ? undefined : await resolveRepository(scope, name, this.github).catch(() => undefined);
      if (!name || !repository) {
        entry.pr = undefined;
        continue;
      }
      const key = `${repository.base.repo}\0${repository.head.repo}\0${name}`;
      const group = groups.get(key) ?? { scopes: [], repository, branch: name, watched: false, forced: false };
      group.scopes.push(scope);
      group.watched ||= watched;
      group.forced ||= scope === forced;
      groups.set(key, group);
    }
    for (const key of this.polledAt.keys()) if (!groups.has(key)) this.polledAt.delete(key);
    for (const key of this.results.keys()) if (!groups.has(key)) this.results.delete(key);
    for (const [key, group] of groups) {
      const due = group.forced || now - (this.polledAt.get(key) ?? -Infinity) >= (group.watched ? WATCHED_POLL_MS : UNWATCHED_POLL_MS);
      if (due) {
        this.polledAt.set(key, now);
        const found = await resolvePullRequest(group.scopes[0]!, group.repository, group.branch, this.github).then(pr => ({ pr }), () => undefined);
        if (found) {
          this.bases.set(key, found.pr?.state === "OPEN" ? found.pr.baseBranch : undefined);
          this.results.set(key, found.pr && { number: found.pr.number, url: found.pr.url, state: found.pr.state, isDraft: found.pr.isDraft, checks: found.pr.checks, reviewDecision: found.pr.reviewDecision, unresolvedThreads: found.pr.unresolvedThreads, updatedAt: found.pr.updatedAt });
        }
      }
      if (!this.results.has(key)) continue;
      for (const scope of group.scopes) Object.assign(this.entry(scope), { pr: this.results.get(key), prBase: this.bases.get(key), prBranch: group.branch });
    }
    this.release(new Set(sessions.map(session => session.scope)));
  }

  private release(kept: Set<string>): void {
    for (const [scope, entry] of this.entries) {
      if (kept.has(scope)) continue;
      clearTimeout(entry.trailing);
      this.entries.delete(scope);
    }
    releaseRepositories(kept);
  }
}
