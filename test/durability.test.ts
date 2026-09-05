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
    root = mkdtempSync(join(tmpdir(), "goodharness-"));
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

  it("closes a Delegation torn by an unclean shutdown", async () => {
    // The case nothing in memory can cover: the Delegation was open when the process vanished, so
    // the only record it existed is the transcript. Left alone, a Revive shows a subagent running
    // forever with a spinner nothing will stop.
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.beginDelegation("explorer", "read package.json");

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const delegation = state.entries.find((entry) => entry.kind === "delegation");
    assert.equal(delegation?.kind === "delegation" && delegation.status, "aborted");
    assert.equal(state.entries.filter((entry) => entry.kind === "delegation").length, 1);
  });

  it("leaves a Delegation that finished before the crash alone", async () => {
    const first = await freshHost();
    const id = await first.host.create({ scope: "/tmp/scope", backend: "fake" });
    await first.host.send(id, "hello", "now");
    first.backend.latest.beginDelegation("explorer").finish("complete");

    const second = await freshHost();
    const state = reduceAll(second.host.logFor(id).since(0));
    const delegation = state.entries.find((entry) => entry.kind === "delegation");
    assert.equal(delegation?.kind === "delegation" && delegation.status, "complete");
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
});
