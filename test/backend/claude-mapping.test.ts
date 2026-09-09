import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  addSpend,
  briefOf,
  describeCompaction,
  describeContextUsage,
  describeSpend,
  isAsyncLaunch,
} from "../../src/backend/claude/index.ts";
import { StreamedMessage, StreamedMessages, type ContentBlock } from "../../src/backend/claude/streamed-message.ts";
import { contextUsageLabel } from "../../src/client/context-usage.ts";
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

/**
 * What the CLI's context accounting becomes on the wire.
 *
 * The regression this guards is the old mapping's `window: 0`, which is the sentinel for "spend but
 * no budget" — so the meter fell back to a bare token count and drew no bar at all.
 */
describe("the Conversation Context reading the Claude adapter reports", () => {
  it("reports the CLI's occupancy rather than one turn's spend", () => {
    // `totalTokens` counts the cache reads that are most of a Claude Code session; the turn `usage`
    // this replaced counted only `input_tokens + output_tokens`.
    assert.deepEqual(describeContextUsage({ totalTokens: 41_000, maxTokens: 200_000 }), {
      used: 41_000,
      window: 200_000,
    });
  });

  it("uses the nominal model window as the denominator", () => {
    // Measured at exactly 200000 on a 200K model, and it is what the CLI divides by for its own
    // `percentage` — not `autoCompactThreshold`, which is lower and would overstate the fill.
    const response = { totalTokens: 13_325, maxTokens: 200_000, autoCompactThreshold: 167_000 };
    assert.equal(describeContextUsage(response).window, 200_000);
  });

  it("yields a percentage rather than the bare-token sentinel", () => {
    const usage = describeContextUsage({ totalTokens: 41_000, maxTokens: 200_000 });
    assert.equal(contextUsageLabel(usage), "context 21%");
  });
});

/**
 * Two producers streaming into one turn: the Agent Session's own model and a Subagent it spawned.
 *
 * The SDK attributes assistant, user and partial messages with `parent_tool_use_id`, so a Subagent's
 * deltas interleave with its parent's. One StreamedMessage serving both would let the Subagent's
 * `message_start` take the id the parent's Entry is on screen under — the stranded caret again.
 */
describe("a Subagent streaming beside its parent", () => {
  it("keeps the two messages apart instead of one stealing the other's id", () => {
    const streams = new StreamedMessages();
    const events = [
      streams.for("").text(0, "Spawning a "),
      // The Subagent opens mid-parent-message. This is the interleaving that used to clear `parts`.
      streams.for("call_1").text(0, "Reading "),
      streams.for("").text(0, "subagent."),
      streams.for("call_1").text(0, "the file."),
      ...streams.finish("call_1", "msg_child", [textBlock("Reading the file.")]),
      ...streams.finish("", "msg_parent", [textBlock("Spawning a subagent.")]),
    ];

    const entries = transcript(events);
    assert.deepEqual(stranded(entries), [], "no Entry may be left mid-stream once both have finished");
    const assistants = entries.filter((entry) => entry.kind === "assistant");
    assert.equal(assistants.length, 2, `expected two Entries, got ${JSON.stringify(entries)}`);
    assert.deepEqual(
      assistants.map((entry) => (entry.kind === "assistant" ? entry.text : "")),
      ["Spawning a subagent.", "Reading the file."],
      "neither producer's text may be discarded by the other's message_start",
    );
  });

  it("forgets a producer once its message has finished", () => {
    const streams = new StreamedMessages();
    streams.for("call_1").text(0, "first");
    streams.finish("call_1", "msg_a", [textBlock("first")]);

    // A second Subagent reusing the callId must start clean, not inherit the first one's parts.
    const reused = streams.for("call_1");
    reused.start("msg_b");
    const entries = transcript([reused.text(0, "second"), ...streams.finish("call_1", "msg_b", [textBlock("second")])]);
    const assistants = entries.filter((entry) => entry.kind === "assistant");
    assert.equal(assistants.length, 1);
    assert.equal(assistants[0]?.kind === "assistant" && assistants[0].text, "second");
  });
});

/**
 * Spend, as distinct from occupancy. `modelUsage` is cumulative for the session and keyed by model,
 * and a Subagent runs under its own model entry — so its tokens are already counted here, which is
 * the only place they appear at all. getContextUsage reports the parent's occupancy, and a
 * Subagent's conversation never occupies it.
 */
describe("everything billed for an Agent Session", () => {
  const model = (over: Record<string, number | string> = {}) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    costUSD: 0,
    ...over,
  });

  it("counts a Subagent's model beside the parent's, costliest first", () => {
    const spend = describeSpend({
      modelUsage: {
        "claude-haiku-4-5-20251001": model({ inputTokens: 897, outputTokens: 10, costUSD: 0.000947, canonicalModel: "claude-haiku-4-5" }),
        "claude-opus-5[1m]": model({ inputTokens: 10, outputTokens: 434, cacheReadInputTokens: 94_457, costUSD: 0.2346, canonicalModel: "claude-opus-5" }),
      },
    });
    assert.equal(spend?.tokens, 897 + 10 + 10 + 434 + 94_457);
    assert.equal(spend?.cached, 94_457, "the cache share is reported apart from the total");
    assert.deepEqual(spend?.models.map((m) => m.id), ["claude-opus-5", "claude-haiku-4-5"]);
  });

  it("names a model as a reader would, not by the version it arrived at it by", () => {
    const spend = describeSpend({
      modelUsage: { "claude-haiku-4-5-20251001": model({ inputTokens: 5, canonicalModel: "claude-haiku-4-5" }) },
    });
    assert.equal(spend?.models[0]?.id, "claude-haiku-4-5");
  });

  it("adds two versioned keys of one model together", () => {
    // Two dated keys of the same canonical model must not read as two models on the breakdown.
    const spend = describeSpend({
      modelUsage: {
        "claude-opus-5-20260101": model({ inputTokens: 100, costUSD: 1, canonicalModel: "claude-opus-5" }),
        "claude-opus-5[1m]": model({ inputTokens: 50, costUSD: 2, canonicalModel: "claude-opus-5" }),
      },
    });
    assert.equal(spend?.models.length, 1);
    assert.equal(spend?.models[0]?.tokens, 150);
    assert.equal(spend?.models[0]?.costUSD, 3);
  });

  it("falls back to the reported key when no canonical name is given", () => {
    const spend = describeSpend({ modelUsage: { "some-model": model({ inputTokens: 5 }) } });
    assert.equal(spend?.models[0]?.id, "some-model");
  });

  it("says nothing when the backend reports no per-model usage", () => {
    // Undefined rather than zero: a zero would render as "Spent 0 tokens", which reads as free.
    assert.equal(describeSpend({}), undefined);
  });
});

/**
 * The brief read off a real `Agent` call. The shape is what the CLI actually sends: `subagent_type`
 * is the declared identity, `description` the one-line brief, and `prompt` the full instruction —
 * which is deliberately not carried, being far too long for a transcript row.
 */
describe("what the Agent tool says a Subagent is", () => {
  it("names it by its subagent type", () => {
    assert.deepEqual(
      briefOf({
        description: "Read package.json name",
        prompt: "Read package.json in the current working directory and report...",
        subagent_type: "Explore",
        run_in_background: false,
      }),
      { name: "Explore", description: "Read package.json name" },
    );
  });

  it("falls back to the tool's own name, so a client always has something to print", () => {
    assert.deepEqual(briefOf({ prompt: "do a thing" }), { name: "Agent" });
  });

  it("does not fall over on an input that is not an object", () => {
    assert.deepEqual(briefOf(undefined), { name: "Agent" });
    assert.deepEqual(briefOf("nonsense"), { name: "Agent" });
  });

  it("omits a description that is not a string rather than printing one", () => {
    assert.deepEqual(briefOf({ subagent_type: "Explore", description: 42 }), { name: "Explore" });
  });
});

/**
 * Telling a launch receipt from an answer, which is the whole of what went wrong before ADR 0016: a
 * backgrounded Subagent's `tool_result` arrives at once, and reading it as a result closed the card
 * on a Subagent that had not started and released the turn while it ran.
 *
 * Asserted against `tool_use_result` — the structured `AgentOutput` the SDK asks callers to render
 * from — rather than the result text, which is prose written for the model and free to change.
 */
describe("whether an Agent tool result is a launch or an answer", () => {
  it("reads a backgrounded launch as a launch", () => {
    assert.equal(
      isAsyncLaunch({
        status: "async_launched",
        isAsync: true,
        agentId: "agent_1",
        description: "read a.ts",
        prompt: "Read a.ts and report",
        outputFile: "/tmp/agent_1.output",
        canReadOutputFile: true,
      }),
      true,
    );
  });

  it("reads a remote launch as one too, being the same promise about another machine", () => {
    assert.equal(isAsyncLaunch({ status: "remote_launched", agentId: "agent_1" }), true);
  });

  it("reads a finished Subagent as an answer", () => {
    assert.equal(
      isAsyncLaunch({ status: "completed", agentId: "agent_1", content: [{ type: "text", text: "a.ts holds..." }] }),
      false,
      "a foreground Subagent must still close on its tool_result",
    );
  });

  it("reads an ordinary tool, which has no status at all, as an answer", () => {
    assert.equal(isAsyncLaunch(undefined), false);
    assert.equal(isAsyncLaunch(null), false);
    assert.equal(isAsyncLaunch("contents of a.ts"), false);
    assert.equal(isAsyncLaunch({ ok: true }), false);
  });
});

/**
 * Spend is cumulative for the Agent Session, not the Backend Session. A backend counts only its own
 * `query()` run, and a Revive opens a fresh one whose counters start at zero — so the two readings
 * are added, never replaced. Without this the meter drops back to whatever the newest Backend
 * Session has spent, which reads as the bill resetting itself.
 */
describe("spend carried across a Revive", () => {
  const before = {
    tokens: 100,
    cached: 60,
    costUSD: 1,
    models: [{ id: "claude-opus-5", tokens: 100, cached: 60, costUSD: 1 }],
  };

  it("adds the new Backend Session's reading to what came before", () => {
    const after = {
      tokens: 30,
      cached: 10,
      costUSD: 0.5,
      models: [{ id: "claude-opus-5", tokens: 30, cached: 10, costUSD: 0.5 }],
    };
    const total = addSpend(before, after);
    assert.equal(total?.tokens, 130);
    assert.equal(total?.cached, 70);
    assert.equal(total?.costUSD, 1.5);
    assert.equal(total?.models.length, 1, "one model billed twice is still one model");
    assert.equal(total?.models[0]?.tokens, 130);
  });

  it("keeps a model that only the later session used", () => {
    const after = {
      tokens: 5,
      cached: 0,
      costUSD: 0.01,
      models: [{ id: "claude-haiku-4-5", tokens: 5, cached: 0, costUSD: 0.01 }],
    };
    const total = addSpend(before, after);
    assert.deepEqual(total?.models.map((model) => model.id), ["claude-opus-5", "claude-haiku-4-5"]);
    assert.equal(total?.tokens, 105);
  });

  it("is whichever side exists when only one does", () => {
    assert.equal(addSpend(undefined, before), before, "a first Backend Session has nothing to add to");
    assert.equal(addSpend(before, undefined), before, "a Revive that has billed nothing yet still reports");
  });

  it("says nothing when neither side does", () => {
    assert.equal(addSpend(undefined, undefined), undefined);
  });
});

/**
 * The SDK's compaction boundary, and what a reader ends up seeing.
 *
 * Asserted through the reducer as well as on the event, because the marker's wording is the whole
 * feature: the number a reader is watching is about to fall, and this row is the only thing that
 * says why.
 */
describe("a compaction boundary", () => {
  it("carries both ends when the SDK reports both", () => {
    assert.deepEqual(describeCompaction({ trigger: "auto", pre_tokens: 84_000, post_tokens: 22_000 }), {
      type: "compacted",
      trigger: "auto",
      before: 84_000,
      after: 22_000,
    });
  });

  // Omitted rather than defaulted: `after: 0` would read as the conversation having been discarded.
  it("omits the far end when the SDK does not report it", () => {
    const event = describeCompaction({ trigger: "manual", pre_tokens: 84_000, post_tokens: undefined });
    assert.deepEqual(event, { type: "compacted", trigger: "manual", before: 84_000 });
    assert.ok(!("after" in event));
  });

  it("reaches the transcript as a marker, not a notice", () => {
    const entries = transcript([describeCompaction({ trigger: "auto", pre_tokens: 84_000, post_tokens: 22_000 })]);

    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, "marker");
    assert.equal(entries[0]?.kind === "marker" && entries[0].marker, "compacted");
  });

  // Automatic is the case that needs naming, because it is the one nobody asked for.
  it("says so when nobody asked for it", () => {
    const said = (trigger: "auto" | "manual", post: number | undefined) => {
      const [entry] = transcript([describeCompaction({ trigger, pre_tokens: 84_000, post_tokens: post })]);
      return entry?.kind === "marker" ? entry.text : "";
    };

    assert.equal(said("auto", 22_000), "Compacted automatically, 84k → 22k tokens");
    assert.equal(said("manual", 22_000), "Compacted, 84k → 22k tokens");
    assert.equal(said("auto", undefined), "Compacted automatically, from 84k tokens");
  });
});
