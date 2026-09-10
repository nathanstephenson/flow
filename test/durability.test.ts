import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend, type FakeSession } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { reduceAll } from "../src/client/reduce.ts";

/** Durability and revival: what survives a Session Host restart, and what it costs to resume. */
describe("durability and revive", () => {
  let root: string;
  let store: TranscriptStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "flow-"));
    store = new TranscriptStore(root);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function freshHost(): Promise<{ host: SessionHost; backend: FakeBackend }> {
    const backend = new FakeBackend();
    const host = new SessionHost({ store });
    host.registerBackend(backend);
    await host.load();
    return { host, backend };
  }

  it("replays a Presentation Transcript across a restart", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.say("hi there");
    first.backend.latest.completeTurn();
    await first.host.shutdown();

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));

    assert.equal(state.entries.find((entry) => entry.kind === "user")?.text, "hello");
    assert.equal(
      state.entries.find((entry) => entry.kind === "assistant")?.text,
      "hi there",
      "the transcript is what the human saw, and it must survive the process that showed it",
    );
  });

  it("loads previously running sessions as Dormant, spending nothing", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.completeTurn();
    await first.host.shutdown();

    const second = await freshHost();
    assert.equal(second.host.statusOf(id), "dormant");
    assert.equal(second.backend.sessions.length, 0, "loading must not start a Backend Session");
  });

  it("closes a turn torn by an unclean shutdown", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    // No completeTurn and no shutdown: the process simply vanishes mid-turn.

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    assert.equal(state.status, "dormant", "a torn turn must not leave a session looking busy");

    const ended = second.host
      .logFor(id)
      .since(0)
      .filter((entry) => entry.event.type === "turn_ended");
    assert.equal(ended.length, 1);
    assert.equal(ended[0]?.event.type === "turn_ended" ? ended[0].event.reason : "", "aborted");
  });

  it("closes a Subagent torn by an unclean shutdown", async () => {
    // The case nothing in memory can cover: the Subagent was open when the process vanished, so
    // the only record it existed is the transcript. Left alone, a Revive shows a subagent running
    // forever with a spinner nothing will stop.
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.beginSubagent("explorer", "read package.json");

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const subagent = state.entries.find((entry) => entry.kind === "subagent");
    assert.equal(subagent?.kind === "subagent" && subagent.status, "aborted");
    assert.equal(state.entries.filter((entry) => entry.kind === "subagent").length, 1);
  });

  it("closes an Enquiry torn by an unclean shutdown, and unlocks the composer with it", async () => {
    /*
     * The daemon-restart case, and the one the adapter cannot cover: nothing was in memory to
     * abandon the permission callback, and the process holding it is gone. All that is left is to
     * record that nobody will ever answer it — and, crucially, that the composer is free again. A
     * transcript replayed with a trailing `asked` would lock every client that loaded it.
     */
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.ask([
      { header: "Library", question: "Which library?", multiSelect: false, options: [{ label: "zod" }] },
    ]);

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const enquiry = state.entries.find((entry) => entry.kind === "enquiry");

    assert.equal(enquiry?.kind === "enquiry" && enquiry.status, "aborted");
    assert.equal(state.entries.filter((entry) => entry.kind === "enquiry").length, 1);
    assert.equal(state.asking, undefined, "a replayed transcript must not lock the composer");
  });

  it("leaves an Enquiry answered before the crash alone", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    const askId = first.backend.latest.ask([
      { header: "Library", question: "Which library?", multiSelect: false, options: [{ label: "zod" }] },
    ]);
    await first.host.answerEnquiry(id, askId, [["zod"]]);

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const enquiry = state.entries.find((entry) => entry.kind === "enquiry");

    assert.equal(enquiry?.kind === "enquiry" && enquiry.status, "answered", "no second terminal state");
  });

  it("closes a Permission Prompt torn by a restart, exactly once", async () => {
    /*
     * The same daemon-restart case, and here the stakes are higher than for an Enquiry. A prompt
     * left `asked` in a replayed transcript locks the composer on buttons whose promise died with
     * the process — a decision the human cannot make and cannot dismiss, over a session that has
     * already gone Dormant.
     */
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.askPermission("mcp__gdrive__trash_file", { fileId: "abc" });

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const call = state.entries.find((entry) => entry.kind === "tool");

    // Recorded as refused, because that is what it was: nobody authorised it and nothing ran.
    assert.equal(call?.kind === "tool" && call.authorisation, "denied");
    assert.equal(
      second.host.logFor(id).since(0).filter((entry) => entry.event.type === "permission").length,
      2,
      "one asked, one terminal — not two terminals",
    );
    assert.equal(state.authorising, undefined, "a replayed transcript must not lock the composer");
  });

  it("leaves a Permission Prompt decided before the crash alone", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    const callId = first.backend.latest.askPermission("Bash", { command: "gt log" });
    await first.host.answerPermission(id, callId, "allow");

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const call = state.entries.find((entry) => entry.kind === "tool");

    assert.equal(call?.kind === "tool" && call.authorisation, "allowed", "no second terminal state");
  });

  it("leaves a Subagent that finished before the crash alone", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.beginSubagent("explorer").finish("complete");

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const subagent = state.entries.find((entry) => entry.kind === "subagent");
    assert.equal(subagent?.kind === "subagent" && subagent.status, "complete");
  });

  it("carries Spend across a Revive rather than starting the bill again", async () => {
    // A backend counts only its own run, so a Revive hands the next one what came before. Restored
    // from the transcript, because on a restart nothing was ever in memory.
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    first.backend.latest.reportSpend({
      tokens: 1_000,
      cached: 400,
      costUSD: 2,
      models: [{ id: "claude-opus-5", tokens: 1_000, cached: 400, costUSD: 2 }],
    });

    const second = await freshHost();
    await second.host.revive(id);
    const handed = second.backend.latest.priorSpend;
    assert.equal(handed?.tokens, 1_000, "the reviving Backend Session must be told what came before");
    assert.equal(handed?.costUSD, 2);
  });

  it("revives on demand, continuing the same transcript behind a marker", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.completeTurn();
    await first.host.shutdown();

    const second = await freshHost();
    const before = second.host.logFor(id).lastSeq;
    await second.host.revive(id);

    assert.equal(second.backend.sessions.length, 1);
    assert.equal(second.host.statusOf(id), "idle");

    const revived = second.host
      .logFor(id)
      .since(before)
      .find((entry) => entry.event.type === "revived");
    assert.ok(revived, "revival is visible in the transcript, not silent");
    assert.equal(revived?.event.type === "revived" ? revived.event.fromSeq : -1, before);
  });

  it("hands the Backend Adapter its resume token when reviving", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.completeTurn();
    await first.host.shutdown();

    const second = await freshHost();
    await second.host.revive(id);
    assert.equal((second.backend.latest as FakeSession).resumedFrom, "fake-resume");
  });

  it("revives implicitly on the next message", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.shutdown();

    const second = await freshHost();
    await second.host.send(id, "carry on", "now");

    assert.deepEqual(second.backend.latest.prompts, ["carry on"]);
    assert.equal(second.host.statusOf(id), "running");
  });

  it("keeps sequence numbers contiguous across a restart", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.completeTurn();
    await first.host.shutdown();

    const second = await freshHost();
    await second.host.revive(id);
    await second.host.send(id, "again", "now");

    const seqs = second.host.logFor(id).since(0).map((entry) => entry.seq);
    assert.deepEqual(seqs, Array.from({ length: seqs.length }, (_, index) => index + 1));
  });

  it("survives a torn final line in the transcript file", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    await first.host.shutdown();

    const { appendFileSync } = await import("node:fs");
    appendFileSync(join(store.sessionDir(id), "transcript.jsonl"), '{"seq":99,"partial');

    const second = await freshHost();
    assert.ok(second.host.logFor(id).lastSeq > 0, "a half-written line must not lose the transcript");
  });

  it("lists Dormant sessions so a client can offer to resume them", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "a title from the first message", "now");
    await first.host.shutdown();

    const second = await freshHost();
    const summary = second.host.list().find((candidate) => candidate.id === id);
    assert.equal(summary?.status, "dormant");
    assert.equal(summary?.title, "a title from the first message");
  });

  /**
   * The lifecycle/activity split across a restart. Lifecycle is the half worth writing down, so
   * these check it survives — and that the derived half does not pretend to.
   */
  it("closes a Permission Prompt torn by a restart and loads with nothing open", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "go", "now");
    first.backend.latest.askPermission("Bash");
    assert.equal(first.host.statusOf(id), "awaiting", "precondition: blocked on a person");

    // No shutdown: the daemon died with the prompt open, which is the path `closeOpenPermissions`
    // exists for and the one no adapter can clean up after itself.
    const second = await freshHost();

    const aborted = second.host
      .logFor(id)
      .since(0)
      .map((entry) => entry.event)
      .filter((event) => event.type === "permission" && event.state === "aborted");
    assert.equal(aborted.length, 1, "the prompt must be closed exactly once");
    assert.equal(second.host.statusOf(id), "dormant", "a restart annihilates the activity, not the Lifecycle");
    assert.equal(second.host.list().find((summary) => summary.id === id)?.activeSubagents, 0);
  });

  it("closes a Background Call torn by a restart, exactly once", async () => {
    // A Background Call is a child of the CLI process, so one still open on disk is a record of
    // something that will never finish (ADR 0021). Left alone it would render on the next load as a
    // job running forever, with nothing that could ever stop it.
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "go", "now");
    first.backend.latest.backgroundCall();
    assert.equal(first.host.list().find((summary) => summary.id === id)?.activeBackgroundCalls, 1);

    // No shutdown: the daemon died with the Call open.
    const second = await freshHost();

    const aborted = second.host
      .logFor(id)
      .since(0)
      .map((entry) => entry.event)
      .filter((event) => event.type === "background_call" && event.state === "aborted");
    assert.equal(aborted.length, 1, "the Call must be closed exactly once");
    assert.equal(second.host.list().find((summary) => summary.id === id)?.activeBackgroundCalls, 0);
  });

  it("loads an Agent Session written before the lifecycle/activity split", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.settle(id);
    await first.host.shutdown();

    // Rewrite the meta as a pre-split daemon left it: `status` only, and none of the three fields
    // the split added.
    const meta = store.readMeta(id);
    assert.ok(meta);
    const { lifecycle: _l, restingAt: _y, settledAt: _s, ...legacy } = meta;
    store.writeMeta({ ...legacy, status: "settled" });

    const second = await freshHost();
    assert.equal(second.host.statusOf(id), "settled", "the deprecated mirror is the fallback");

    // And the meta is rewritten in the new shape, so the migration completes on one boot.
    const migrated = store.readMeta(id);
    assert.equal(migrated?.lifecycle, "settled");
    assert.equal(migrated?.settledAt, legacy.updatedAt, "the old updatedAt is what the clock ran from");
    assert.ok(migrated?.restingAt);
  });

  it("does not restart the retention clock when a Settled Agent Session is touched", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.settle(id);
    const settledAt = store.readMeta(id)?.settledAt;
    assert.ok(settledAt);

    await new Promise((resolve) => setTimeout(resolve, 2));
    await first.host.setModel(id, "fake-2");

    const after = store.readMeta(id);
    assert.notEqual(after?.updatedAt, settledAt, "the command did touch the Agent Session");
    assert.equal(after?.settledAt, settledAt, "but it must not grant it another retention window");
  });
});
