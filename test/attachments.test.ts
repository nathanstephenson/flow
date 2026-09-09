import assert from "node:assert/strict";
import { describe, it, beforeEach, afterEach } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { reduceAll } from "../src/client/reduce.ts";
import { CommandRefused, SessionHost } from "../src/daemon/host.ts";
import { TranscriptStore } from "../src/daemon/store.ts";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BASE64_BYTES,
  mediaTypeOf,
  type IncomingAttachment,
} from "../src/protocol/attachments.ts";
import type { AgentEvent } from "../src/protocol/events.ts";

/**
 * Attachments, from the command that carries their bytes to the transcript that names them.
 *
 * The through-line every test here defends: **bytes go on the command, ids go in the transcript.**
 * A Presentation Transcript is read in full on every load and replayed on every Revive (ADR 0001),
 * so base64 on one of its lines is not a size problem that shows up later — it is a record that
 * stops being readable at all.
 */

const png: IncomingAttachment = { mediaType: "image/png", data: "iVBORw0KGgoAAAANSUhEUg==" };
const jpeg: IncomingAttachment = { mediaType: "image/jpeg", data: "/9j/4AAQSkZJRgABAQ==" };

describe("attachments", () => {
  let root: string;
  let store: TranscriptStore;
  let backend: FakeBackend;
  let host: SessionHost;
  let sessionId: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "flow-"));
    store = new TranscriptStore(root);
    backend = new FakeBackend();
    host = new SessionHost({ store });
    host.registerBackend(backend);
    // fake-1 is the model that declares acceptsImages; fake-2 is the one that does not.
    sessionId = await host.create({ scope: "/tmp/scope", backend: "fake", modelId: "fake-1" });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const events = (): AgentEvent[] => host.logFor(sessionId).since(0).map((entry) => entry.event);
  const userMessages = () => events().filter((event) => event.type === "user_message");
  const attachmentFiles = () => {
    const dir = store.attachmentsDir(sessionId);
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  };

  it("writes the bytes down and puts only ids in the transcript", async () => {
    await host.send(sessionId, "what is this?", "now", [png]);

    const [message] = userMessages();
    assert.equal(message?.type === "user_message" && message.text, "what is this?");
    const ids = message?.type === "user_message" ? (message.attachments ?? []) : [];
    assert.equal(ids.length, 1);

    // The load-bearing assertion: no line of the transcript contains the base64.
    const serialised = JSON.stringify(events());
    assert.ok(!serialised.includes(png.data), "a transcript must never carry an attachment's bytes");

    assert.deepEqual(attachmentFiles(), ids);
  });

  it("names the media type in the id, so nothing has to carry it twice", async () => {
    await host.send(sessionId, "two", "now", [png, jpeg]);

    const [message] = userMessages();
    const ids = message?.type === "user_message" ? (message.attachments ?? []) : [];
    assert.deepEqual(ids.map(mediaTypeOf), ["image/png", "image/jpeg"]);
  });

  it("hands the backend base64 for the turn it dispatches", async () => {
    await host.send(sessionId, "what is this?", "now", [png]);

    assert.deepEqual(backend.latest.prompts, ["what is this?"]);
    assert.deepEqual(backend.latest.promptedAttachments[0], [{ mediaType: "image/png", data: png.data }]);
  });

  it("omits attachments entirely from an ordinary turn", async () => {
    await host.send(sessionId, "hello", "now");

    const [message] = userMessages();
    assert.equal(message?.type === "user_message" && "attachments" in message, false);
    assert.deepEqual(backend.latest.promptedAttachments[0], []);
    assert.deepEqual(attachmentFiles(), []);
  });

  /*
   * Written at send rather than at dispatch, which is what makes a queued message durable the moment
   * it is accepted. Holding the bytes in memory instead would mean a message that waits out a long
   * turn is one crash away from losing the picture but keeping the words.
   */
  it("writes a queued message's bytes before the turn it waits for has ended", async () => {
    await host.send(sessionId, "first", "now");
    await host.send(sessionId, "second", "after_turn", [png]);

    assert.deepEqual(backend.latest.prompts, ["first"], "the second must still be queued");
    assert.equal(attachmentFiles().length, 1, "its bytes must already be on disk");

    backend.latest.completeTurn();
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(backend.latest.prompts, ["first", "second"]);
    assert.deepEqual(backend.latest.promptedAttachments[1], [{ mediaType: "image/png", data: png.data }]);
  });

  /*
   * The queue's own event stays text-only. It is a transcript event, replayed forever, and widening
   * its shape so a client could preview a queued image would change a record already written.
   */
  it("keeps queue_changed carrying texts alone", async () => {
    await host.send(sessionId, "first", "now");
    await host.send(sessionId, "second", "after_turn", [png]);

    const changed = events().filter((event) => event.type === "queue_changed");
    assert.deepEqual(changed.at(-1)?.type === "queue_changed" ? changed.at(-1)?.pending : [], ["second"]);
  });

  it("survives a restart, because the ids and the files both outlive the host", async () => {
    await host.send(sessionId, "what is this?", "now", [png]);
    await host.shutdown();

    const revived = new SessionHost({ store });
    revived.registerBackend(new FakeBackend());
    await revived.load();

    const entries = reduceAll(revived.logFor(sessionId).since(0)).entries;
    const user = entries.find((entry) => entry.kind === "user");
    assert.equal(user?.kind === "user" && user.attachments?.length, 1);
    const id = user?.kind === "user" ? (user.attachments?.[0] ?? "") : "";
    assert.ok(store.readAttachment(sessionId, id), "the bytes must still be readable");
  });

  it("takes the attachments with it when the session is deleted", async () => {
    await host.send(sessionId, "what is this?", "now", [png]);
    assert.equal(attachmentFiles().length, 1);

    store.deleteSession(sessionId);
    assert.equal(existsSync(store.attachmentsDir(sessionId)), false);
  });

  describe("what it refuses", () => {
    const refuses = async (attachments: IncomingAttachment[], expected: RegExp): Promise<void> => {
      await assert.rejects(
        () => host.send(sessionId, "here", "now", attachments),
        (error: unknown) => error instanceof CommandRefused && expected.test(error.message),
      );
      // Nothing may be written for a send that was never carried out.
      assert.deepEqual(attachmentFiles(), []);
      assert.deepEqual(backend.latest.prompts, []);
    };

    it("refuses a media type it cannot serve", async () => {
      await refuses([{ mediaType: "application/pdf" as never, data: "x" }], /not an attachable media type/);
    });

    it("refuses one over the size cap", async () => {
      await refuses([{ mediaType: "image/png", data: "a".repeat(MAX_ATTACHMENT_BASE64_BYTES + 1) }], /base64 bytes/);
    });

    it("refuses more than one message may carry", async () => {
      const many = Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 1 }, () => png);
      await refuses(many, /At most/);
    });

    /*
     * The one negative the host can actually make. It cannot always name the model in force —
     * `modelId` is absent whenever nobody overrode the default — so this fires only when it can, and
     * the composer carries the positive check.
     */
    it("refuses a model that declares it cannot be shown one", async () => {
      await host.setModel(sessionId, "fake-2");
      await refuses([png], /cannot be shown an attachment/);
    });

    it("allows one through when the model in force cannot be identified", async () => {
      const anonymous = await host.create({ scope: "/tmp/scope", backend: "fake" });
      await host.send(anonymous, "here", "now", [png]);
      assert.equal(readdirSync(store.attachmentsDir(anonymous)).length, 1);
    });

    it("refuses one when this Session Host keeps no state at all", async () => {
      const stateless = new SessionHost();
      stateless.registerBackend(new FakeBackend());
      const id = await stateless.create({ scope: "/tmp/scope", backend: "fake", modelId: "fake-1" });

      await assert.rejects(
        () => stateless.send(id, "here", "now", [png]),
        (error: unknown) => error instanceof CommandRefused && /keeps no state/.test(error.message),
      );
    });
  });
});
