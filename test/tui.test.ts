import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { PassThrough } from "node:stream";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { connect } from "../src/client/connection.ts";
import { initialState, reduceAll } from "../src/client/reduce.ts";
import { sessionLabel } from "../src/client/session-label.ts";
import { SessionLog } from "../src/daemon/log.ts";
import { effortChoices, modelChoices } from "../src/client/model-choices.ts";
import { renderFrame, type UiState } from "../src/tui/render.ts";
import { KEY } from "../src/tui/keys.ts";
import { runTui } from "../src/tui/app.ts";
import type { Capabilities } from "../src/protocol/events.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, repository } from "./git-fixture.ts";

const CAPABILITIES: Capabilities = {
  providers: ["anthropic", "openai"],
  models: [
    { id: "claude-opus-5", provider: "anthropic", label: "Opus 5", effortLevels: ["low", "high", "max"] },
    { id: "gpt-x", provider: "openai", label: "GPT X" },
    { id: "claude-sonnet-5", provider: "anthropic", label: "Sonnet 5" },
  ],
  compaction: true,
  fork: false,
  subagents: false,
};

function baseUi(overrides: Partial<UiState> = {}): UiState {
  return {
    sessions: [
      { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "First", updatedAt: "", lastSeq: 0 },
    ],
    selected: "s1",
    view: { ...initialState(), capabilities: CAPABILITIES },
    input: "",
    overlay: { kind: "none" },
    ...overrides,
  };
}

describe("TUI rendering", () => {
  it("groups models by provider", () => {
    const choices = modelChoices(CAPABILITIES);
    assert.deepEqual(
      choices.map((choice) => `${choice.provider}/${choice.model.id}`),
      ["anthropic/claude-opus-5", "anthropic/claude-sonnet-5", "openai/gpt-x"],
    );
  });

  it("groups Settled Agent Sessions under their own divider, with last-updated badges", () => {
    const now = Date.parse("2026-09-01T12:00:00.000Z");
    const at = (ms: number): string => new Date(now - ms).toISOString();
    const ui = baseUi({
      overlay: { kind: "sessions", index: 0 },
      now,
      sessions: [
        { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "Live one", updatedAt: at(30_000), lastSeq: 0 },
        { id: "s2", scope: "/tmp", backend: "fake", status: "dormant", title: "Older", updatedAt: at(3 * 3_600_000), lastSeq: 0 },
        { id: "s3", scope: "/tmp", backend: "fake", status: "settled", title: "Filed away", updatedAt: at(5 * 60_000), lastSeq: 0 },
      ],
    });

    const frame = renderFrame(ui, { columns: 80, rows: 14 }).join("\n");
    assert.match(frame, /just now.*Live one/);
    assert.match(frame, /3h.*Older/);
    // The divider sits above the Settled group and below the live ones.
    const dividerAt = frame.indexOf("── settled ──");
    assert.ok(dividerAt > frame.indexOf("Live one"), "divider comes after the live sessions");
    assert.ok(dividerAt < frame.indexOf("Filed away"), "divider comes before the settled ones");
  });

  it("names an Agent Session by its id while it has no title yet", () => {
    // The title is derived from the first message, so an Agent Session nobody has written to has
    // none — and an empty string renders as nothing at all.
    assert.equal(sessionLabel({ id: "s1", title: "" }), "s1");
    const ui = baseUi({
      overlay: { kind: "sessions", index: 0 },
      sessions: [
        { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "", updatedAt: "", lastSeq: 0 },
      ],
    });
    const frame = renderFrame(ui, { columns: 80, rows: 12 });
    assert.match(frame[0] ?? "", /fake · s1/, "the header must name the Agent Session");
    assert.match(frame.join("\n"), /idle {5}fake {4}.*s1/, "so must the list row");
  });

  it("renders a structural marker as a rule rather than as one more notice line", () => {
    const log = new SessionLog("s1");
    log.append({ type: "session_dormant", reason: "host shutdown" }, "2026-01-01T00:00:00Z");
    log.append({ type: "notice", level: "warn", text: "just a message" }, "2026-01-01T00:00:00Z");
    const frame = renderFrame(baseUi({ view: reduceAll(log.since(0)) }), { columns: 60, rows: 12 }).join("\n");
    assert.match(frame, /── Dormant: host shutdown ─+/);
    assert.match(frame, /! just a message/);
  });

  /*
   * A terminal cannot show the image, so it says one is there. The alternative — printing nothing —
   * makes a wordless paste look like an empty message the model then answered out of nowhere.
   */
  it("says an attachment was sent, since it cannot show one", () => {
    const log = new SessionLog("s1");
    log.append({ type: "user_message", id: "u1", text: "what is this?", attachments: ["a.png"] }, "2026-01-01T00:00:00Z");
    log.append({ type: "user_message", id: "u2", text: "and these?", attachments: ["b.png", "c.jpg"] }, "2026-01-01T00:00:00Z");
    log.append({ type: "user_message", id: "u3", text: "plain" }, "2026-01-01T00:00:00Z");

    const frame = renderFrame(baseUi({ view: reduceAll(log.since(0)) }), { columns: 60, rows: 14 }).join("\n");
    assert.match(frame, /> what is this\?\n\s+\[1 image\]/);
    assert.match(frame, /> and these\?\n\s+\[2 images\]/);
    assert.doesNotMatch(frame, /> plain\n\s+\[\d/);
  });

  it("renders exactly the terminal height, whatever the content", () => {
    const log = new SessionLog("s1");
    for (let index = 0; index < 50; index += 1) {
      log.append({ type: "message", id: `m${index}`, text: `line ${index}`, final: true }, "2026-01-01T00:00:00Z");
    }
    const ui = baseUi({ view: reduceAll(log.since(0)) });
    for (const rows of [6, 12, 24, 60]) {
      assert.equal(renderFrame(ui, { columns: 60, rows }).length, rows);
    }
  });

  it("never emits a line wider than the terminal", () => {
    const log = new SessionLog("s1");
    log.append({ type: "message", id: "m1", text: "x".repeat(500), final: true }, "2026-01-01T00:00:00Z");
    const frame = renderFrame(baseUi({ view: reduceAll(log.since(0)) }), { columns: 40, rows: 12 });
    for (const line of frame) assert.ok(line.length <= 40, `line too wide: ${line.length}`);
  });

  it("shows the newest output rather than the oldest", () => {
    const log = new SessionLog("s1");
    for (let index = 0; index < 40; index += 1) {
      log.append({ type: "message", id: `m${index}`, text: `line ${index}`, final: true }, "2026-01-01T00:00:00Z");
    }
    const frame = renderFrame(baseUi({ view: reduceAll(log.since(0)) }), { columns: 60, rows: 12 }).join("\n");
    assert.match(frame, /line 39/);
    assert.doesNotMatch(frame, /line 0\b/);
  });

  it("surfaces queue depth, so a queued message is not silently swallowed", () => {
    const ui = baseUi({ view: { ...initialState(), queue: ["a", "b"] } });
    assert.match(renderFrame(ui, { columns: 80, rows: 10 }).join("\n"), /2 queued/);
  });

  it("offers the Effort levels of the model in force, not of the session", () => {
    const view = { ...initialState(), capabilities: CAPABILITIES };
    assert.deepEqual(effortChoices({ ...view, model: { id: "claude-opus-5" } }), ["low", "high", "max"]);
    assert.deepEqual(effortChoices({ ...view, model: { id: "gpt-x" } }), [], "a model without one offers nothing");
  });

  it("marks the Effort in force in the picker, and says so when there is none", () => {
    const view = { ...initialState(), capabilities: CAPABILITIES };
    const chosen = renderFrame(
      baseUi({ view: { ...view, model: { id: "claude-opus-5" }, effort: "high" }, overlay: { kind: "effort", index: 0 } }),
      { columns: 60, rows: 12 },
    ).join("\n");
    assert.match(chosen, /high {2}\(in force\)/);

    const none = renderFrame(
      baseUi({ view: { ...view, model: { id: "gpt-x" } }, overlay: { kind: "effort", index: 0 } }),
      { columns: 60, rows: 12 },
    ).join("\n");
    assert.match(none, /no effort control/);
  });

  it("names the branch beside the identity, not beside the turn", () => {
    const [header] = renderFrame(
      baseUi({ view: { ...initialState(), capabilities: CAPABILITIES, branch: { name: "feature/login" } } }),
      { columns: 80, rows: 10 },
    );
    assert.match(header ?? "", /fake · First · feature\/login/);
  });

  it("names a Worktree Scope, so a reader knows edits are not landing in the Project", () => {
    const [header] = renderFrame(
      baseUi({
        view: {
          ...initialState(),
          capabilities: CAPABILITIES,
          branch: { name: "goodharness/main-2026-09-04" },
          worktree: true,
        },
      }),
      { columns: 120, rows: 10 },
    );
    assert.match(header ?? "", /goodharness\/main-2026-09-04 · Worktree/);
  });

  // The default case is not worth a line's width in a client with one header line, and the web
  // client spends a whole strip on it. Both take the word from scopeKindLabel either way.
  it("spends no width saying a Scope is the Project's own checkout", () => {
    const [header] = renderFrame(
      baseUi({ view: { ...initialState(), capabilities: CAPABILITIES, branch: { name: "main" } } }),
      { columns: 120, rows: 10 },
    );
    assert.match(header ?? "", / · main/);
    assert.doesNotMatch(header ?? "", /checkout/);
  });

  it("says nothing about a branch when the Scope is not a repository", () => {
    const [header] = renderFrame(baseUi(), { columns: 80, rows: 10 });
    assert.doesNotMatch(header ?? "", /branch/);
  });

  it("marks the branch in force in the picker", () => {
    const frame = renderFrame(
      baseUi({
        overlay: { kind: "branches", index: 0, purpose: "switch", branches: ["main", "feature"], head: "main" },
      }),
      { columns: 80, rows: 10 },
    );
    assert.match(frame.join("\n"), /> main {2}\(in force\)/);
    assert.doesNotMatch(frame.join("\n"), /feature {2}\(in force\)/);
  });

  // One list, two jobs: the rows are identical, so the title is what says which is happening.
  it("says which job the branch list is doing", () => {
    const cutting = renderFrame(
      baseUi({ overlay: { kind: "branches", index: 0, purpose: "cut", branches: ["main"] } }),
      { columns: 80, rows: 10 },
    );
    assert.match(cutting.join("\n"), /cut a worktree from/);

    const switching = renderFrame(
      baseUi({ overlay: { kind: "branches", index: 0, purpose: "switch", branches: ["main"] } }),
      { columns: 80, rows: 10 },
    );
    assert.match(switching.join("\n"), /enter to switch/);
  });

  it("says so rather than rendering an empty list where there are no branches", () => {
    const frame = renderFrame(
      baseUi({ overlay: { kind: "branches", index: 0, purpose: "switch", branches: [] } }),
      { columns: 80, rows: 10 },
    );
    assert.match(frame.join("\n"), /no branches here/);
  });

  it("keeps the selected model in view in a long list", () => {
    const many: Capabilities = {
      ...CAPABILITIES,
      models: Array.from({ length: 300 }, (_, index) => ({
        id: `m${index}`,
        provider: `p${Math.floor(index / 50)}`,
        label: `Model ${index}`,
      })),
    };
    const ui = baseUi({
      view: { ...initialState(), capabilities: many },
      overlay: { kind: "models", index: 250 },
    });
    assert.match(renderFrame(ui, { columns: 60, rows: 16 }).join("\n"), /Model 250/);
  });
});

/**
 * The TUI against a repository Scope.
 *
 * Its own suite because the one above runs on `/tmp/scope`, which is not a repository — and that is
 * worth keeping, since it is the case where every control here has to be absent rather than broken.
 */
describe("TUI branches over the wire", () => {
  let root: string;
  let repo: string;
  let running: RunningServer;
  let backend: FakeBackend;
  let host: SessionHost;
  let stdin: PassThrough;
  let output: string[];
  let finished: Promise<void>;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "goodharness-tui-git-"));
    repo = repository(root, "api", ["feature"]);
    // A commit on `feature` so `--sort=-committerdate` has a defined answer: without it both
    // branches share one commit date and the list order — and so which row `up` reaches — is
    // whatever git felt like. `feature` first, `main` second.
    git(repo, "switch", "--quiet", "feature");
    writeFileSync(join(repo, "later.txt"), "newer\n");
    git(repo, "add", ".");
    git(repo, "commit", "--quiet", "-m", "later");
    git(repo, "switch", "--quiet", "main");
    backend = new FakeBackend();
    host = new SessionHost({ store: new TranscriptStore(root) });
    host.registerBackend(backend);
    running = await serve({ host, token: "test-token" });

    stdin = new PassThrough();
    Object.assign(stdin, { setRawMode: () => undefined, isTTY: true });
    output = [];
    const stdout = Object.assign(new PassThrough(), {
      columns: 100,
      rows: 24,
      write: (chunk: string) => {
        output.push(chunk);
        return true;
      },
    });

    finished = runTui({
      connection: connect({ url: running.url, token: "test-token" }),
      scope: repo,
      backend: "fake",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    await waitFor(() => backend.sessions.length === 1);
  });

  afterEach(async () => {
    stdin.write(KEY.ctrlC);
    await finished;
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("lists the branches on ^G and switches on enter", async () => {
    await waitFor(() => output.join("").includes("main"));

    stdin.write(KEY.ctrlG);
    await waitFor(() => output.join("").includes("enter to switch, esc to close"));
    // The cursor opens on the branch in force — `main`, second in a most-recent-first list — so one
    // step up reaches `feature`.
    stdin.write(KEY.up);
    stdin.write(KEY.enter);

    // Waiting on what the host reports, not on git's HEAD: the checkout lands before `switchBranch`
    // has read back where it ended up, so HEAD moves a subprocess earlier than the record does.
    await waitFor(() => host.list()[0]?.branch?.name === "feature");
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "feature");
  });

  it("starts an Agent Session in a worktree from the sessions list", async () => {
    stdin.write(KEY.ctrlS);
    await waitFor(() => output.join("").includes("w for new in a worktree"));
    stdin.write("w");
    await waitFor(() => output.join("").includes("cut a worktree from"));
    stdin.write(KEY.enter);

    // Waiting on the branch, not on the session count: an Agent Session is in `list()` from the
    // moment it is registered, which is before `create` has read back where its Scope sits.
    await waitFor(() => host.list().some((session) => session.worktree === true && session.branch !== undefined));
    const cut = host.list().find((session) => session.worktree === true);
    assert.ok(cut, "the new Agent Session is bound to a worktree");
    assert.notEqual(cut.scope, repo);
    assert.match(cut.branch?.name ?? "", /^goodharness\//);
  });

  // The refusal has to reach the reader, or a switch that did not happen looks like one that did.
  it("shows the host's refusal when a turn is in flight", async () => {
    stdin.write("get to work");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);

    stdin.write(KEY.ctrlG);
    await waitFor(() => output.join("").includes("enter to switch, esc to close"));
    stdin.write(KEY.up);
    stdin.write(KEY.enter);

    await waitFor(() => output.join("").includes("is running"));
    assert.equal(git(repo, "symbolic-ref", "--short", "HEAD").trim(), "main");
  });
});

describe("TUI over the wire", () => {
  let running: RunningServer;
  let backend: FakeBackend;
  let stdin: PassThrough;
  let output: string[];
  let finished: Promise<void>;

  beforeEach(async () => {
    backend = new FakeBackend();
    const host = new SessionHost();
    host.registerBackend(backend);
    running = await serve({ host, token: "test-token" });

    stdin = new PassThrough();
    Object.assign(stdin, { setRawMode: () => undefined, isTTY: true });
    output = [];
    const stdout = Object.assign(new PassThrough(), {
      columns: 80,
      rows: 24,
      write: (chunk: string) => {
        output.push(chunk);
        return true;
      },
    });

    finished = runTui({
      connection: connect({ url: running.url, token: "test-token" }),
      scope: "/tmp/scope",
      backend: "fake",
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });
    await waitFor(() => backend.sessions.length === 1);
  });

  afterEach(async () => {
    stdin.write(KEY.ctrlC);
    await finished;
    await running.close();
  });

  it("creates a session and sends what was typed", async () => {
    stdin.write("hello");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);
    assert.deepEqual(backend.latest.prompts, ["hello"]);
  });

  it("renders assistant output arriving over SSE", async () => {
    stdin.write("hi");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);

    backend.latest.say("the answer");
    backend.latest.completeTurn();
    await waitFor(() => output.join("").includes("the answer"));
  });

  it("queues a message typed while the agent is working", async () => {
    stdin.write("first");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);

    stdin.write("second");
    stdin.write(KEY.enter);
    await waitFor(() => output.join("").includes("1 queued"));
    assert.deepEqual(backend.latest.prompts, ["first"], "typing must not interrupt a running turn");

    backend.latest.completeTurn();
    await waitFor(() => backend.latest.prompts.length === 2);
    assert.deepEqual(backend.latest.prompts, ["first", "second"]);
  });

  it("aborts the running turn on escape", async () => {
    stdin.write("work");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);

    stdin.write(KEY.escape);
    await waitFor(() => output.join("").includes("idle"));
  });

  it("sets Effort from the picker", async () => {
    stdin.write(KEY.ctrlE);
    /*
     * Wait for the *picker* to know the levels, not for the backend to have them.
     *
     * Capabilities reach the TUI late and over SSE — `query()` emits nothing until the input stream
     * yields, so an adapter announces them on the way up rather than at create (see the README).
     * Waiting on `backend.latest.capabilities` therefore proves nothing about this client: until the
     * `capabilities_changed` entry has been reduced, render.ts draws "no effort control", and the
     * two keystrokes below land on an empty list and are silently dropped. That is what made this
     * test fail intermittently, and more often once the embedded manifest grew and slowed startup.
     */
    await waitFor(() => (output.at(-1) ?? "").includes("effort  (enter to set"));

    stdin.write(KEY.down);
    stdin.write(KEY.enter);
    // fake-1 offers low/medium/high; the cursor starts on the level in force and steps down.
    await waitFor(() => backend.latest.effort !== undefined);
    assert.equal(backend.latest.effort, "medium");
  });

  it("settles from the session list without opening the session", async () => {
    const settled = backend.latest;
    stdin.write(KEY.ctrlS);
    await waitFor(() => output.join("").includes("s to settle"));

    stdin.write("s");
    /*
     * Wait on the frame, not on `disposed`.
     *
     * `disposed` flips when the Session Host tears the Backend Session down, which happens *before*
     * `session_settled` has crossed the stream, been reduced and been drawn. Waiting on it and then
     * asserting against `output.at(-1)` races the render, which is what made this test fail roughly
     * one full-suite run in three — the same lesson the effort test above already records.
     */
    await waitFor(() => /settled/.test(output.at(-1) ?? ""));

    assert.equal(settled.disposed, true, "settling disposes the Backend Session");
    // The list stays up: settling is filing something away, not picking what to work on next.
    assert.match(output.at(-1) ?? "", /sessions {2}\(enter to switch/, "the session list is still open");
  });

  it("edits the input line with backspace", async () => {
    stdin.write("helXo");
    stdin.write(KEY.backspace);
    stdin.write(KEY.backspace);
    stdin.write("lo");
    stdin.write(KEY.enter);
    await waitFor(() => backend.latest.prompts.length === 1);
    assert.deepEqual(backend.latest.prompts, ["hello"]);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
