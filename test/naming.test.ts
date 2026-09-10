import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { nameFrom, nameInput, summariseToName } from "../src/daemon/summariser.ts";
import type { LoggedEvent } from "../src/protocol/events.ts";

/**
 * Naming an Agent Session with the Summary Model (ADR 0020).
 *
 * The two halves are tested apart, because they fail differently. `nameFrom` is where the feature
 * is actually decided and needs no model at all; the host half is about what may overwrite what,
 * and when, and what happens when the answer never comes.
 */

describe("the name inside a model's answer", () => {
  it("takes a plain answer", () => {
    assert.equal(nameFrom("Add retry to the uploader"), "Add retry to the uploader");
  });

  it("strips the decoration a model adds despite being told not to", () => {
    assert.equal(nameFrom('"Add retry to the uploader"'), "Add retry to the uploader");
    assert.equal(nameFrom("Title: Add retry to the uploader"), "Add retry to the uploader");
    assert.equal(nameFrom("**Add retry to the uploader**"), "Add retry to the uploader");
    assert.equal(nameFrom("Add retry to the uploader."), "Add retry to the uploader");
  });

  it("takes the last line, because a preamble comes first", () => {
    assert.equal(nameFrom("Sure! Here is a name:\n\nAdd retry to the uploader"), "Add retry to the uploader");
  });

  it("refuses an answer outside three to seven words", () => {
    assert.equal(nameFrom("Uploader retry"), undefined);
    assert.equal(nameFrom("Add some retry logic to the file uploader module"), undefined);
  });

  it("refuses rather than truncating an over-long one", () => {
    // A name cut mid-phrase reads as a bug, and is worse than the first line of what the human
    // actually typed — which is what refusing falls back to. The rule is one-sided on purpose.
    assert.equal(nameFrom("Add retryyyyyyyyyy".repeat(6)), undefined);
  });

  it("refuses nothing, and refuses something that is not prose", () => {
    assert.equal(nameFrom(""), undefined);
    assert.equal(nameFrom("   \n  "), undefined);
    assert.equal(nameFrom("Add retry to uploader"), undefined);
  });
});

describe("a transcript as something to name", () => {
  const logged = (event: LoggedEvent["event"]): LoggedEvent => ({
    seq: 1,
    sessionId: "s",
    at: "2026-01-01T00:00:00.000Z",
    event,
  });

  it("takes what was said, from both sides, and leaves out the tool calls", () => {
    const input = nameInput([
      logged({ type: "user_message", id: "u1", text: "Fix the uploader" }),
      logged({ type: "tool_started", callId: "c1", name: "Read", input: {} }),
      logged({ type: "message", id: "m1", text: "Looking now", final: true }),
    ]);

    assert.match(input, /Human: Fix the uploader/);
    assert.match(input, /Assistant: Looking now/);
    assert.doesNotMatch(input, /Read/);
  });

  it("leaves out a Subagent's words and a partial", () => {
    const input = nameInput([
      logged({ type: "message", id: "m1", text: "Half a sen", final: false }),
      logged({ type: "message", id: "m2", text: "Sub said this", final: true, producer: { subagentId: "a" } }),
    ]);

    // A partial is a prefix of the snapshot that follows it, so taking both puts one sentence in
    // twice; a Subagent is not answering the question that was asked (ADR 0015).
    assert.equal(input, "");
  });
});

describe("a Summary Model that will not answer", () => {
  it("gives up, disposes, and reports nothing", async () => {
    const backend = new FakeBackend();

    // The fake never ends a turn by itself unless told to, which is exactly the hang this timeout
    // exists for.
    const name = await summariseToName({
      backend,
      modelId: "fake-1",
      text: "Fix the uploader",
      timeoutMs: 20,
    });

    assert.equal(name, undefined);
    assert.equal(backend.latest.disposed, true);
  });

  it("reports nothing when the backend will not start at all", async () => {
    const broken = {
      name: "broken",
      create: async () => {
        throw new Error("not logged in");
      },
    };

    assert.equal(await summariseToName({ backend: broken, modelId: "x", text: "hi" }), undefined);
  });
});

describe("naming an Agent Session", () => {
  let root: string;
  let work: string;
  let host: SessionHost;
  let backend: FakeBackend;
  let summary: FakeBackend;
  /** Mutable, so a test can move, clear or switch off the Summary Model as the Settings page would. */
  let summaryModel: { backend: string; modelId: string; automatic: boolean } | undefined;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-state-"));
    work = mkdtempSync(join(tmpdir(), "flow-work-"));
    backend = new FakeBackend();
    summary = new FakeBackend();
    summary.autoReply = "Add retry to the uploader";
    summaryModel = { backend: "summary", modelId: "fake-2", automatic: true };
    host = new SessionHost({
      store: new TranscriptStore(root),
      // Read through on every call, never captured: ADR 0009's rule, and what lets a test move the
      // Setting mid-flight exactly as the Settings page does.
      summaryModel: () => summaryModel,
    });
    host.registerBackend(backend);
    host.registerBackend({ ...summary, name: "summary", create: (options) => summary.create(options) });
    await host.load();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
  });

  const titleOf = (id: string) => host.list().find((entry) => entry.id === id)?.title;

  /** The naming is `void`ed at dispatch, so it lands a turn of the event loop later. */
  const settled = async () => {
    for (let tick = 0; tick < 20; tick += 1) await new Promise((resolve) => setImmediate(resolve));
  };

  it("shows the first line at once and settles into a name", async () => {
    const id = await host.create({ scope: work, backend: "fake" });

    await host.send(id, "please fix the uploader, it keeps dying on big files", "after_turn");
    // Synchronously, before any model has been asked anything: no empty state and no spinner.
    assert.equal(titleOf(id), "please fix the uploader, it keeps dying on big files");

    await settled();
    assert.equal(titleOf(id), "Add retry to the uploader");
  });

  it("asks in a session with no tools, and disposes of it", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    // `sessions[0]`, not `latest`: the newest session is the *replacement* spare, warmed for next
    // time and deliberately still alive. The one that did the naming is the one warmed at create.
    const used = summary.sessions[0];
    assert.equal(used?.toolless, true);
    assert.equal(used?.disposed, true);
  });

  it("names from the spare warmed at create, and warms exactly one replacement", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    // Booted before anybody typed: the whole point, and the reason a name arrives in six seconds
    // rather than forty against a real backend.
    assert.equal(summary.sessions.length, 1);
    assert.equal(summary.sessions[0]?.prompts.length, 0);

    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    assert.equal(summary.sessions.length, 2, "one naming, one replacement — never a third");
    assert.equal(summary.sessions[0]?.prompts.length, 1);
    assert.equal(summary.sessions[1]?.prompts.length, 0);
    assert.equal(summary.sessions[1]?.disposed, false);
  });

  it("boots one spare however many Agent Sessions are created", async () => {
    await host.create({ scope: work, backend: "fake" });
    await host.create({ scope: work, backend: "fake" });
    await host.create({ scope: work, backend: "fake" });

    // The slot is written in the same tick the boot starts. Were it written after the await, each
    // create would see an empty slot and spawn its own CLI.
    assert.equal(summary.sessions.length, 1);
  });

  it("never hands one Backend Session to two namings", async () => {
    const first = await host.create({ scope: work, backend: "fake" });
    const second = await host.create({ scope: work, backend: "fake" });

    await Promise.all([
      host.send(first, "fix the uploader", "after_turn"),
      host.send(second, "fix the downloader", "after_turn"),
    ]);
    await settled();

    // The claim is synchronous. If it were not, both namings would prompt the one spare and could
    // take each other's answers.
    assert.deepEqual(
      summary.sessions.map((session) => session.prompts.length).filter((count) => count > 1),
      [],
    );
  });

  it("names only the first message", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();
    backend.latest.completeTurn();

    summary.autoReply = "Something else entirely now";
    await host.send(id, "and now the downloader", "after_turn");
    await settled();

    // A summary may only ever replace a first-line title, so no *established* name changes under
    // its reader.
    assert.equal(titleOf(id), "Add retry to the uploader");
  });

  it("keeps the first line when the model answers junk", async () => {
    summary.autoReply = "Uploader";
    const id = await host.create({ scope: work, backend: "fake" });

    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    assert.equal(titleOf(id), "fix the uploader");
  });

  it("does not break creating or dispatching when the Summary Model is unreachable", async () => {
    summaryModel = { backend: "nonesuch", modelId: "x", automatic: true };

    // `backendFor` throws for a name it does not know, and warming happens inside `create`. A typo
    // in the Settings must cost a worse *name*, never the Agent Session itself.
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    assert.equal(titleOf(id), "fix the uploader");
    assert.equal(host.logFor(id).since(0).some((entry) => entry.event.type === "user_message"), true);
    assert.equal(summary.sessions.length, 0);
  });

  it("survives a Summary Model backend that will not boot", async () => {
    const rejections: unknown[] = [];
    const capture = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", capture);
    try {
      host.registerBackend({
        name: "broken",
        create: async () => {
          throw new Error("not logged in");
        },
      });
      summaryModel = { backend: "broken", modelId: "x", automatic: true };

      const id = await host.create({ scope: work, backend: "fake" });
      await host.send(id, "fix the uploader", "after_turn");
      await settled();

      // The boot promise is stored already-caught. Attaching the handler at the later `await`
      // would be too late: the rejection is unhandled at the tick it rejects, and Node throws.
      assert.deepEqual(rejections, []);
      assert.equal(titleOf(id), "fix the uploader");
    } finally {
      process.off("unhandledRejection", capture);
    }
  });

  it("drops the spare when the Summary Model moves, and names with the new one", async () => {
    await host.create({ scope: work, backend: "fake" });
    const stale = summary.sessions[0];
    assert.equal(stale?.modelId, "fake-2");

    summaryModel = { backend: "summary", modelId: "fake-1", automatic: true };
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    assert.equal(stale?.disposed, true, "a spare warmed for a model nobody wants any more");
    const used = summary.sessions.find((session) => session.prompts.length > 0);
    assert.equal(used?.modelId, "fake-1");
  });

  it("keeps the first line when automatic naming is switched off", async () => {
    summaryModel = { backend: "summary", modelId: "fake-2", automatic: false };

    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    assert.equal(titleOf(id), "fix the uploader");
    // Nothing warmed either: a daemon nobody is renaming in should hold no idle process.
    assert.equal(summary.sessions.length, 0);
  });

  it("still names on request when automatic naming is off", async () => {
    summaryModel = { backend: "summary", modelId: "fake-2", automatic: false };
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    // The whole reason this is a switch rather than clearing the Summary Model.
    assert.equal(await host.execute({ type: "rename", sessionId: id }), "Add retry to the uploader");
    assert.equal(titleOf(id), "Add retry to the uploader");
  });

  it("warms a replacement after a rename, so the second one is not cold either", async () => {
    summaryModel = { backend: "summary", modelId: "fake-2", automatic: false };
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();
    await host.execute({ type: "rename", sessionId: id });

    // One session for the rename, one warmed behind it. And creating another Agent Session must
    // not dispose that one — with automatic off, `create` leaves the spare alone.
    assert.equal(summary.sessions.length, 2);
    await host.create({ scope: work, backend: "fake" });
    assert.equal(summary.sessions[1]?.disposed, false);
  });

  it("drops the spare when the Summary Model is cleared, and boots nothing more", async () => {
    await host.create({ scope: work, backend: "fake" });
    const held = summary.sessions[0];

    // Nothing tells us the Settings moved (ADR 0009), so clearing is noticed at the next
    // read-through. Without this, an idle CLI would outlive its own configuration.
    summaryModel = undefined;
    await host.create({ scope: work, backend: "fake" });

    assert.equal(held?.disposed, true);
    assert.equal(summary.sessions.length, 1);
  });

  it("does not hand out a spare that died while it was idle", async () => {
    await host.create({ scope: work, backend: "fake" });
    const dead = summary.sessions[0];
    dead?.fail();

    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    // A corpse is worse than no spare: it would burn the whole timeout, where the cold path at
    // least has a live process.
    assert.equal(dead?.prompts.length, 0);
    assert.equal(titleOf(id), "Add retry to the uploader");
  });

  it("disposes the spare on shutdown and warms no replacement after it", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await host.shutdown();
    await settled();

    // The one-shot CLI runner shuts down while a `void`ed naming is still in flight. A replacement
    // warmed in that window is a child process with nothing left to dispose it.
    assert.deepEqual(
      summary.sessions.filter((session) => !session.disposed).map((session) => session.modelId),
      [],
    );
  });

  it("disposes a spare that was still booting when the host shut down", async () => {
    summary.holdCreate = true;
    await host.create({ scope: work, backend: "fake" });

    // Shutdown does not wait for the boot — waiting would stall a one-shot run for as long as a
    // cold Claude session takes to start.
    await host.shutdown();
    summary.releaseCreate();
    await settled();

    // The second half of the `closed` check. A boot that lands after dispose is a session no field
    // points at, and nothing would ever come back for it.
    assert.equal(summary.sessions.length, 1);
    assert.equal(summary.sessions[0]?.disposed, true);
  });

  it("writes nothing onto an Agent Session that ended while it was thinking", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await host.dispose(id);

    await settled();

    assert.equal(titleOf(id), "fix the uploader");
  });

  it("names again on request, and answers the new name", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    summary.autoReply = "Rewrite the upload retry";
    assert.equal(await host.execute({ type: "rename", sessionId: id }), "Rewrite the upload retry");
    assert.equal(titleOf(id), "Rewrite the upload retry");
  });

  it("does not Revive a Dormant Agent Session to name it", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();
    backend.latest.completeTurn();
    await host.shutdown();

    const sessionsBefore = backend.sessions.length;
    summary.autoReply = "Rewrite the upload retry";
    await host.execute({ type: "rename", sessionId: id });

    // ADR 0003: a rename reads the Presentation Transcript, not the Conversation Context, so there
    // is nothing a Backend Session would have to be running to answer.
    assert.equal(backend.sessions.length, sessionsBefore);
    assert.equal(host.list().find((entry) => entry.id === id)?.status, "dormant");
    assert.equal(titleOf(id), "Rewrite the upload retry");
  });

  it("refuses, readably, when there is no Summary Model or nothing to name", async () => {
    const bare = new SessionHost({ store: new TranscriptStore(root) });
    bare.registerBackend(backend);
    const unnamed = await bare.create({ scope: work, backend: "fake" });
    await assert.rejects(bare.execute({ type: "rename", sessionId: unnamed }), /Summary Model/);

    const id = await host.create({ scope: work, backend: "fake" });
    await assert.rejects(host.execute({ type: "rename", sessionId: id }), /nothing to name/);
  });

  it("refuses when the model answers junk, rather than going quiet", async () => {
    const id = await host.create({ scope: work, backend: "fake" });
    await host.send(id, "fix the uploader", "after_turn");
    await settled();

    // The automatic half is silent and the human half is not: somebody clicked this and is waiting.
    summary.autoReply = "No";
    await assert.rejects(host.execute({ type: "rename", sessionId: id }), /Could not name/);
    assert.equal(titleOf(id), "Add retry to the uploader");
  });
});
