import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import { reduceAll } from "../src/client/reduce.ts";
import type { AgentEvent } from "../src/protocol/events.ts";

const ATTACHMENT = Buffer.from("png").toString("base64");

describe("Rewind and Fork", () => {
  let root: string;
  let store: TranscriptStore;
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-"));
    store = new TranscriptStore(root);
    backend = new FakeBackend({ fork: true, rewind: true, rewindFiles: true });
    host = new SessionHost({ store });
    host.registerBackend(backend);
    sessionId = await host.create({ scope: tmpdir(), backend: "fake" });
  });

  afterEach(async () => {
    await host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });

  function events(id: string): AgentEvent[] {
    return host.logFor(id).since(0).map((entry) => entry.event);
  }

  async function turn(text: string): Promise<string> {
    await host.send(sessionId, text, "now", text === "second" ? [{ mediaType: "image/png", data: ATTACHMENT }] : undefined);
    backend.latest.say(`re: ${text}`);
    backend.latest.completeTurn();
    const sent = events(sessionId).findLast((event) => event.type === "user_message");
    return sent?.type === "user_message" ? sent.id : "";
  }

  it("gives the backend the host's user message id", async () => {
    const id = await turn("first");
    assert.deepEqual(backend.latest.promptIds, [id]);
  });

  it("restarts the Backend Session before the message and answers with its words", async () => {
    await turn("first");
    const second = await turn("second");
    const before = backend.sessions.length;

    const answer = await host.rewind(sessionId, second, "conversation");

    assert.equal(answer.text, "second");
    assert.equal(answer.attachments.length, 1);
    assert.equal(backend.sessions.length, before + 1);
    assert.equal(backend.latest.resumedBefore, second);
    assert.ok(events(sessionId).some((event) => event.type === "rewound" && event.userMessageId === second && event.restore === "conversation"));
  });

  it("keeps the cut for a Revive until the next turn starts", async () => {
    const first = await turn("first");
    await host.rewind(sessionId, first, "conversation");
    assert.equal(store.readMeta(sessionId)?.rewindTo, first);

    await host.send(sessionId, "again", "now");
    assert.equal(store.readMeta(sessionId)?.rewindTo, undefined);
  });

  it("rewinds files in the live Backend Session without restarting it", async () => {
    const first = await turn("first");
    const live = backend.latest;

    await host.rewind(sessionId, first, "files");

    assert.equal(backend.latest, live);
    assert.deepEqual(live.rewoundFiles, [first]);
  });

  it("refuses while a turn is running", async () => {
    const first = await turn("first");
    await host.send(sessionId, "busy", "now");

    await assert.rejects(() => host.rewind(sessionId, first, "conversation"), /Wait for the turn/);
  });

  it("refuses a message that is not in the Agent Session", async () => {
    await assert.rejects(() => host.rewind(sessionId, "missing", "conversation"), /not in this Agent Session/);
  });

  it("marks what the Rewind took out of the Conversation Context", async () => {
    await turn("first");
    const second = await turn("second");
    await host.rewind(sessionId, second, "conversation");

    const entries = reduceAll(host.logFor(sessionId).since(0)).entries;
    const from = entries.findIndex((entry) => entry.kind === "user" && entry.id === second);
    assert.ok(entries.slice(0, from).every((entry) => !entry.rewound));
    assert.ok(entries.slice(from, -1).every((entry) => entry.rewound));
    const last = entries.at(-1);
    assert.equal(last?.kind === "marker" && last.marker, "rewound");
  });

  it("forks from before a message with a copy of the transcript before it", async () => {
    await turn("first");
    const second = await turn("second");
    await turn("third");

    const forkId = await host.fork(sessionId, second);

    const copied = events(forkId);
    assert.equal(copied[0]?.type, "session_started");
    assert.equal(copied.filter((event) => event.type === "session_started").length, 1);
    assert.deepEqual(copied.filter((event) => event.type === "user_message").map((event) => event.type === "user_message" && event.text), ["first"]);
    assert.ok(copied.some((event) => event.type === "forked" && event.fromSessionId === sessionId && event.userMessageId === second));
    assert.equal(backend.forks.length, 1);
    assert.equal(backend.latest.resumedBefore, second);
    assert.equal(store.readMeta(forkId)?.title.endsWith("(fork)"), true);
  });

  it("starts a Fork from the first message as a new conversation", async () => {
    const first = await turn("first");

    const forkId = await host.fork(sessionId, first);

    assert.equal(backend.forks.length, 0);
    assert.equal(backend.latest.resumedFrom, undefined);
    assert.equal(events(forkId).some((event) => event.type === "user_message"), false);
  });

  it("copies the Attachments the prefix refers to", async () => {
    await turn("first");
    await turn("second");
    const third = await turn("third");

    const forkId = await host.fork(sessionId, third);

    const sent = events(forkId).find((event) => event.type === "user_message" && event.attachments);
    assert.ok(sent?.type === "user_message" && sent.attachments?.[0]);
    assert.ok(store.readAttachment(forkId, sent.attachments[0]!));
  });
});
