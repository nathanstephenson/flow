import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { StreamedMessage, type ContentBlock } from "../../src/backend/claude/streamed-message.ts";
import { reduceAll, type Entry } from "../../src/client/reduce.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

/**
 * One assistant message, from its first delta to its finished copy.
 *
 * These assert against the **Presentation Transcript the reducer builds**, not against event shapes,
 * because the bug they exist for was only ever visible there: an id that changed between the stream
 * and the finish made `upsert` append instead of replace, and the transcript kept the message twice —
 * the partial, caret still blinking, above an identical finished copy.
 */

const transcript = (events: BackendEvent[]): Entry[] =>
  reduceAll(events.map((event, index) => ({ seq: index + 1, sessionId: "s1", at: "", event }))).entries;

const textBlock = (text: string): ContentBlock => ({ type: "text", text });
const thinkingBlock = (thinking: string): ContentBlock => ({ type: "thinking", thinking });

/** No Entry may be left mid-stream once the message has finished. A caret that never stops is the bug. */
const stranded = (entries: Entry[]): Entry[] =>
  entries.filter((entry) => (entry.kind === "assistant" || entry.kind === "thinking") && !entry.final);

describe("a streamed assistant message and its finished copy", () => {
  it("is one Entry even when message_start carried no id of its own", () => {
    // The regression. `message_start` without an id used to mint a random one, which could never
    // equal the id the finished message reports — so the reducer appended and the answer appeared
    // twice, the first copy with its caret still blinking.
    const streamed = new StreamedMessage();
    streamed.start(undefined);
    const events = [
      streamed.text(0, "De-dup is "),
      streamed.text(0, "two layers."),
      ...streamed.finish("msg_real", [textBlock("De-dup is two layers.")]),
    ];

    const entries = transcript(events);
    assert.equal(entries.length, 1, `expected one Entry, got ${JSON.stringify(entries)}`);
    assert.equal(entries[0]?.kind, "assistant");
    assert.equal(entries[0]?.kind === "assistant" && entries[0].text, "De-dup is two layers.");
    assert.deepEqual(stranded(entries), []);
  });

  it("is one Entry when message_start and the finished message agree", () => {
    const streamed = new StreamedMessage();
    streamed.start("msg_1");
    const entries = transcript([streamed.text(0, "hi"), ...streamed.finish("msg_1", [textBlock("hi there")])]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind === "assistant" && entries[0].text, "hi there");
    assert.deepEqual(stranded(entries), []);
  });

  it("is one Entry when deltas arrive with no message_start at all", () => {
    // The other half of the same hole: a constant placeholder id for the un-started case could not
    // match the finished message either.
    const streamed = new StreamedMessage();
    const entries = transcript([streamed.text(0, "orphan"), ...streamed.finish("msg_2", [textBlock("orphaned")])]);

    assert.equal(entries.length, 1);
    assert.deepEqual(stranded(entries), []);
  });

  it("finishes the reasoning too, so its caret stops and the clamp can engage", () => {
    // ThinkingEntryView clamps on `final`. Reasoning was never finalised at all, so it never did.
    const streamed = new StreamedMessage();
    streamed.start("msg_3");
    const entries = transcript([
      streamed.thinking(0, "weighing it"),
      streamed.text(1, "the answer"),
      ...streamed.finish("msg_3", [thinkingBlock("weighing it"), textBlock("the answer")]),
    ]);

    const thinking = entries.find((entry) => entry.kind === "thinking");
    assert.equal(thinking?.kind === "thinking" && thinking.final, true);
    assert.deepEqual(stranded(entries), []);
  });

  it("keeps reasoning out of the streamed answer", () => {
    // Both halves share one index space, and joining all of it appended a message's own reasoning to
    // its visible text — reasoning that rehearses the reply reads as the reply saying itself twice.
    const streamed = new StreamedMessage();
    streamed.start("msg_4");
    streamed.thinking(0, "I should say hello");
    const event = streamed.text(1, "hello");

    assert.equal(event.type === "message" && event.text, "hello");
  });

  it("joins reasoning across blocks rather than replacing it with the last one", () => {
    const streamed = new StreamedMessage();
    streamed.start("msg_5");
    streamed.thinking(0, "first. ");
    const event = streamed.thinking(1, "second.");

    assert.equal(event.type === "thinking" && event.text, "first. second.");
  });

  it("falls back to the reported id when nothing streamed", () => {
    // The non-streaming path: no deltas, so there is no Entry on screen to land on and the SDK's own
    // id is the right one.
    const streamed = new StreamedMessage();
    const [message] = streamed.finish("msg_6", [textBlock("whole thing")]);

    assert.equal(message?.type === "message" && message.id, "msg_6");
    assert.equal(message?.type === "message" && message.final, true);
  });

  it("starts a fresh Entry for the next message in the same turn", () => {
    // A turn is often text, then a tool call, then more text. Those are two Entries, not one.
    const streamed = new StreamedMessage();
    streamed.start("msg_7");
    const first = [streamed.text(0, "first"), ...streamed.finish("msg_7", [textBlock("first")])];
    streamed.start("msg_8");
    const second = [streamed.text(0, "second"), ...streamed.finish("msg_8", [textBlock("second")])];

    const entries = transcript([...first, ...second]);
    assert.equal(entries.length, 2);
    assert.deepEqual(stranded(entries), []);
  });
});
