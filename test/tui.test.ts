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
  enquiries: true,
  permissions: true,
};

function baseUi(overrides: Partial<UiState> = {}): UiState {
  return {
    sessions: [
      { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "First", yourTurnAt: "", activeSubagents: 0, lastSeq: 0 },
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
        { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "Live one", yourTurnAt: at(30_000), activeSubagents: 0, lastSeq: 0 },
        { id: "s2", scope: "/tmp", backend: "fake", status: "dormant", title: "Older", yourTurnAt: at(3 * 3_600_000), activeSubagents: 0, lastSeq: 0 },
        { id: "s3", scope: "/tmp", backend: "fake", status: "settled", title: "Filed away", yourTurnAt: at(5 * 60_000), activeSubagents: 0, lastSeq: 0 },
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
        { id: "s1", scope: "/tmp", backend: "fake", status: "idle", title: "", yourTurnAt: "", activeSubagents: 0, lastSeq: 0 },
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
          branch: { name: "flow/main-2026-09-04" },
          worktree: true,
        },
      }),
      { columns: 120, rows: 10 },
    );
    assert.match(header ?? "", /flow\/main-2026-09-04 · Worktree/);
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
    root = mkdtempSync(join(tmpdir(), "flow-tui-git-"));
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
    running = await serve({ host, token: "test-token", assets: {} });

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
    assert.match(cut.branch?.name ?? "", /^flow\//);
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
    running = await serve({ host, token: "test-token", assets: {} });

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

describe("the TUI's Enquiry picker", () => {
  const QUESTIONS = [
    {
      header: "Library",
      question: "Which library should the rewrite use?",
      multiSelect: false,
      options: [{ label: "zod", description: "big" }, { label: "valibot", description: "small" }],
    },
    {
      header: "Features",
      question: "Which features?",
      multiSelect: true,
      options: [{ label: "Caching" }, { label: "Retries" }],
    },
  ];

  const asking = (input = "", index = 0, cursor = 0, chosen: string[][] = [[], []]) =>
    baseUi({
      input,
      view: {
        ...baseUi().view,
        asking: { askId: "a1", questions: QUESTIONS },
      },
      answering: { index, cursor, chosen },
    });

  it("draws the Question, its Options and a visible number column", () => {
    const frame = renderFrame(asking(), { columns: 70, rows: 16 }).join("\n");

    assert.match(frame, /Which library should the rewrite use\?/);
    // The numbers are the one thing an arrow-driven list cannot do, and are what "numbered picker"
    // means: a row can be addressed without being travelled to.
    assert.match(frame, /> 1 zod/);
    assert.match(frame, /  2 valibot/);
    assert.match(frame, /\(1 of 2\)/);
  });

  it("shows checkboxes and the cursor only where they mean something", () => {
    const multi = renderFrame(asking("", 1, 1, [[], ["Caching"]]), { columns: 70, rows: 16 }).join("\n");

    assert.match(multi, /\(choose any\)/);
    assert.match(multi, /1 \[x\] Caching/);
    assert.match(multi, /> 2 \[ \] Retries/);
    // A single-select always has exactly one answer, so an empty box beside every row would offer a
    // choice that is not on offer.
    assert.doesNotMatch(renderFrame(asking(), { columns: 70, rows: 16 }).join("\n"), /\[ \]/);
  });

  it("gives the row under the cursor its whole description, and marks the others as clipped", () => {
    /*
     * The defect this closes: an Option's description is the deciding information, and the model
     * writes it long with the trade-off at the end — so clipping every row to a terminal's width
     * reliably cut off the half that decides it, silently and mid-word.
     */
    const long = [
      {
        header: "Library",
        question: "Which library?",
        multiSelect: false,
        options: [
          { label: "zod", description: "Most widely adopted TypeScript schema library. Large ecosystem, great inference, heavier bundle." },
          { label: "valibot", description: "Modular, tree-shakeable alternative with a much smaller bundle. Smaller ecosystem and fewer integrations." },
        ],
      },
    ];
    const ui = baseUi({
      view: { ...baseUi().view, asking: { askId: "a1", questions: long } },
      answering: { index: 0, cursor: 0, chosen: [[]] },
    });

    const frame = renderFrame(ui, { columns: 80, rows: 18 }).join("\n");

    assert.match(frame, /heavier bundle\./, "the option being considered keeps its trade-off");
    // The others stay one scannable line — but say they were cut, because a sentence stopping
    // mid-word is otherwise indistinguishable from one the model wrote that way.
    assert.match(frame, /2 valibot .*…$/m);
  });

  it("adds the typed answer as a row of its own, last", () => {
    const frame = renderFrame(asking("neither, actually"), { columns: 70, rows: 16 }).join("\n");

    assert.match(frame, /3 neither, actually/);
    assert.match(frame, /your own answer/);
  });

  it("says the box cannot send, with the sigil and the hints", () => {
    const frame = renderFrame(asking("typed"), { columns: 70, rows: 16 });
    const prompt = frame.at(-1) ?? "";
    const status = frame.at(-2) ?? "";

    // `?` rather than `>`: a `>` over a box that cannot send a message tells exactly the lie the web
    // client's placeholder is careful to refuse.
    assert.match(prompt, /^\? typed/);
    assert.match(status, /enter answer/);
    assert.doesNotMatch(status, /\^K compact/, "a Command cannot run behind a blocked turn");
  });

  it("prompts for an answer rather than showing an empty box", () => {
    assert.match(renderFrame(asking(), { columns: 70, rows: 16 }).at(-1) ?? "", /type your own answer/);
  });

  it("keeps the transcript on screen and the frame the right height", () => {
    // An Overlay hides the transcript because it is a different task; here the message that
    // motivated the question is the last thing on screen and is why the question makes sense.
    for (const rows of [10, 16, 24]) {
      assert.equal(renderFrame(asking(), { columns: 70, rows }).length, rows);
    }
  });

  it("draws nothing at all when nothing is being asked", () => {
    const frame = renderFrame(baseUi({ input: "hi" }), { columns: 70, rows: 16 });
    assert.match(frame.at(-1) ?? "", /^> hi/);
    assert.doesNotMatch(frame.join("\n"), /choose any/);
  });
});

describe("the TUI's Permission Prompt picker", () => {
  const authorising = (cursor = 0) =>
    baseUi({
      view: {
        ...baseUi().view,
        entries: [
          {
            kind: "tool" as const,
            id: "c1",
            name: "Bash",
            input: { command: "rm -rf /tmp/scratch" },
            status: "running" as const,
            authorisation: "asked" as const,
          },
        ],
        authorising: { callId: "c1", tool: "Bash" },
      },
      deciding: cursor,
    });

  it("names the tool and shows what the call would actually do", () => {
    const frame = renderFrame(authorising(), { columns: 70, rows: 18 }).join("\n");

    // The name alone is the withholding `tool-summary.ts` exists to stop: "authorise Bash?" is not a
    // question anybody can answer.
    assert.match(frame, /Authorise Bash\?/);
    assert.match(frame, /rm -rf \/tmp\/scratch/);
  });

  it("offers the three choices with a visible number column", () => {
    const frame = renderFrame(authorising(), { columns: 70, rows: 18 }).join("\n");

    assert.match(frame, /1 Allow once/);
    assert.match(frame, /2 Deny/);
    assert.match(frame, /3 Always allow on this machine/);
  });

  it("shows the whole of the description under the cursor", () => {
    // Unwrapped before matching: the description is wrapped across lines under the row, which is the
    // point — a truncated one would have lost the second half rather than folded it.
    const onAlways = renderFrame(authorising(2), { columns: 70, rows: 20 })
      .join(" ")
      .replace(/\s+/g, " ");

    /*
     * The row this rule exists for: "Always allow on this machine" is a sentence whose consequence
     * is in its second half, and clipping every row to the width of a terminal cuts off exactly the
     * part that should give someone pause.
     */
    assert.match(onAlways, /never ask again in any Agent Session/);
    assert.match(onAlways, /Revocable in Settings/);
  });

  it("moves the cursor without moving the choices", () => {
    const first = renderFrame(authorising(0), { columns: 70, rows: 18 }).join("\n");
    const last = renderFrame(authorising(2), { columns: 70, rows: 18 }).join("\n");

    assert.match(first, /> 1 Allow once/);
    assert.match(last, /> 3 Always allow/);
  });

  it("swaps the prompt sigil for one that is not a lie", () => {
    const frame = renderFrame(authorising(), { columns: 70, rows: 18 });

    // `!` rather than `>` or `?`: nothing can be sent, and nothing can be typed either. The
    // difference between being asked something and being asked to allow something is the whole
    // distinction between an Enquiry and this, and the sigil is the only place a terminal has to
    // say it.
    assert.match(frame.at(-1) ?? "", /^! \[1-3 to decide]/);
  });

  it("replaces the hints with the keys that work, and says Escape refuses", () => {
    const frame = renderFrame(authorising(), { columns: 90, rows: 18 });

    // Replaced rather than added to, because most of the usual hints are no longer true: nothing
    // here sends a message, and `^K` is refused.
    assert.match(frame.at(-2) ?? "", /enter decide/);
    assert.match(frame.at(-2) ?? "", /esc deny/);
    assert.doesNotMatch(frame.at(-2) ?? "", /\^S sessions/);
  });

  it("keeps the frame exactly as tall as the terminal", () => {
    // The picker takes its rows off the transcript rather than replacing it, which is what keeps the
    // message that motivated the call on screen — and the whole difference between this and an
    // Overlay.
    for (const cursor of [0, 1, 2]) {
      assert.equal(renderFrame(authorising(cursor), { columns: 70, rows: 20 }).length, 20);
    }
  });

  it("prints the decision on the tool row, and nothing on a row nobody was asked about", () => {
    const decided = baseUi({
      view: {
        ...baseUi().view,
        entries: [
          { kind: "tool" as const, id: "c1", name: "Bash", input: {}, status: "complete" as const, authorisation: "denied" as const },
          { kind: "tool" as const, id: "c2", name: "Read", input: {}, status: "complete" as const },
        ],
      },
    });
    const frame = renderFrame(decided, { columns: 70, rows: 18 }).join("\n");

    assert.match(frame, /\[complete] Bash — refused/);
    // Absent is the common case, and it must not read as a decision.
    assert.match(frame, /\[complete] Read$/m);
  });
});
