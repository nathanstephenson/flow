import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";
import { FakeBackend, type FakeWorkflowSubagent } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { tourInput, tourText } from "../src/daemon/tour.ts";
import type { Gh } from "../src/daemon/github.ts";
import type { TourView } from "../src/protocol/git.ts";

const github: Gh = async (_scope, args) => {
  if (args[0] === "auth") return "";
  if (args[0] === "repo") return JSON.stringify({ id: "R_repo", defaultBranchRef: { name: "main" }, isFork: false });
  return "[]";
};

const spend = { tokens: 10, cached: 0, costUSD: 0.01, models: [] };

let root: string;
let repo: string;
let environment: NodeJS.ProcessEnv;
let host: SessionHost;
let backend: FakeBackend;

beforeEach(() => {
  environment = { ...process.env };
  root = mkdtempSync(join(tmpdir(), "flow-tour-"));
  repo = repository(root, "repo");
  git(repo, "remote", "add", "origin", "git@github.com:test/repo.git");
  git(repo, "switch", "--quiet", "-c", "feature/tour");
  writeFileSync(join(repo, "search.txt"), "search\n");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Add search");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "gh"), `#!/bin/sh\ncase "$1 $2" in\n'auth status') exit 0;;\n'repo view') echo '{"id":"R_repo","defaultBranchRef":{"name":"main"},"isFork":false}';;\n*) echo '[]';;\nesac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  process.env.PATH = `${bin}:${environment.PATH}`;
  host = new SessionHost();
  backend = new FakeBackend();
  host.registerBackend(backend);
});

afterEach(async () => {
  await host.shutdown();
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});

async function until<T>(read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 3_000;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const subagent = (index = 0): Promise<FakeWorkflowSubagent> => until(() => backend.sessions.flatMap((session) => session.workflowSubagents)[index]);
const settled = (id: string): Promise<TourView> => until(() => { const view = host.tour(id); return view.state === "running" ? undefined : view; });

describe("Tour", () => {
  it("gives the branch, base, commits and diff as input", async () => {
    const made = await tourInput(repo, github);
    assert.equal(made.branch, "feature/tour");
    assert.equal(made.repo, "test/repo");
    assert.equal(made.head, git(repo, "rev-parse", "HEAD").trim());
    assert.match(made.input, /^Branch: feature\/tour\nBase: main\n/);
    assert.match(made.input, /Add search/);
    assert.match(made.input, /\+search/);
  });

  it("reads the tour from JSON and falls back to raw text", () => {
    assert.equal(tourText(JSON.stringify({ tour: "# Tour" })), "# Tour");
    assert.equal(tourText("# Raw"), "# Raw");
  });

  it("runs on the Agent Session's model, answers prompts, records Spend and keeps the result", async () => {
    const id = await host.create({ scope: repo, effort: "high" });
    assert.deepEqual(host.tour(id), { state: "idle" });
    assert.equal(host.startTour(id).state, "running");
    const tour = await subagent();
    assert.equal(tour.options.modelId, "fake-1");
    assert.equal(tour.options.effort, "high");
    assert.equal(tour.options.permissionMode, "ask");
    assert.match(String(tour.options.input), /\+search/);
    const read = tour.requestPermission("Read");
    const bash = tour.requestPermission("Bash");
    const ask = tour.ask([{ question: "Which?", header: "Pick", options: [], multiSelect: false }]);
    tour.emit({ type: "spend", spend });
    await until(() => tour.decisions.length === 2 && tour.answers.length === 1 ? true : undefined);
    assert.deepEqual(tour.decisions, [{ callId: read, decision: "allow" }, { callId: bash, decision: "deny" }]);
    assert.deepEqual(tour.answers, [{ askId: ask, answers: [["No human is available. Continue without an answer."]] }]);
    assert.ok(host.logFor(id).since(0).some(({ event }) => event.type === "workflow_spend" && event.executionId.startsWith("tour:")));
    tour.complete({ tour: "# Tour" });
    assert.deepEqual(await settled(id), { state: "done", text: "# Tour", branch: "feature/tour", head: git(repo, "rev-parse", "HEAD").trim(), repo: "test/repo" });
  });

  it("uses the Tour Model when one is chosen", async () => {
    await host.shutdown();
    host = new SessionHost({ tourModel: (name) => name === "fake" ? { modelId: "fake-2", effort: "low" } : undefined });
    host.registerBackend(backend);
    const id = await host.create({ scope: repo });
    host.startTour(id);
    const tour = await subagent();
    assert.equal(tour.options.modelId, "fake-2");
    assert.equal(tour.options.effort, "low");
  });

  it("fails without a remote", async () => {
    git(repo, "remote", "remove", "origin");
    const id = await host.create({ scope: repo });
    host.startTour(id);
    const view = await settled(id);
    assert.equal(view.state, "failed");
    assert.match(view.state === "failed" ? view.problem : "", /No remote/);
  });

  it("runs while a turn is in flight", async () => {
    const id = await host.create({ scope: repo });
    await host.send(id, "work", "now");
    host.startTour(id);
    (await subagent()).completeText("# Raw");
    assert.equal((await settled(id)).state, "done");
  });

  it("revives a Dormant Agent Session", async () => {
    const id = await host.create({ scope: repo });
    await host.shutdown();
    assert.equal(host.list().find((session) => session.id === id)?.status, "dormant");
    host.startTour(id);
    (await subagent()).complete({ tour: "# Tour" });
    assert.equal((await settled(id)).state, "done");
    assert.equal(host.list().find((session) => session.id === id)?.status, "idle");
  });

  it("cancels, runs again and ignores a late result", async () => {
    const id = await host.create({ scope: repo });
    host.startTour(id);
    const first = await subagent();
    host.startTour(id);
    const second = await subagent(1);
    first.complete({ tour: "late" });
    second.complete({ tour: "new" });
    const view = await settled(id);
    assert.equal(view.state === "done" ? view.text : view.state, "new");
    host.startTour(id);
    await subagent(2);
    assert.deepEqual(host.cancelTour(id), { state: "idle" });
    assert.deepEqual(host.tour(id), { state: "idle" });
  });

  for (const operation of ["dispose", "settle"] as const) {
    it(`returns to idle on ${operation}`, async () => {
      const id = await host.create({ scope: repo });
      host.startTour(id);
      await subagent();
      await host[operation](id);
      assert.deepEqual(host.tour(id), { state: "idle" });
    });
  }
});
