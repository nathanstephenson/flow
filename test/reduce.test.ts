import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { initialState, reduceAll } from "../src/client/reduce.ts";
import { SessionLog } from "../src/daemon/log.ts";
import type { AgentEvent } from "../src/protocol/events.ts";

const CAPS = { providers: ["fake"], models: [], compaction: false, fork: false };

function transcript(...events: AgentEvent[]): SessionLog {
  const log = new SessionLog("s1");
  // Fixed timestamp: the reducer must not depend on wall-clock.
  for (const event of events) log.append(event, "2026-01-01T00:00:00.000Z");
  return log;
}

const SAMPLE: AgentEvent[] = [
  { type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS },
  { type: "user_message", id: "u1", text: "hello" },
  { type: "turn_started", turnId: "t1" },
  { type: "message", id: "m1", text: "par", final: false },
  { type: "tool_started", callId: "c1", name: "Read", input: { path: "a.ts" } },
  { type: "message", id: "m1", text: "partial then whole", final: true },
  { type: "tool_ended", callId: "c1", result: "contents", isError: false },
  { type: "context_usage", used: 1200, window: 200000 },
  { type: "turn_ended", turnId: "t1", reason: "complete" },
];

describe("reduce", () => {
  it("upserts snapshots by id rather than appending each update", () => {
    const state = reduceAll(transcript(...SAMPLE).since(0));
    const assistant = state.entries.filter((entry) => entry.kind === "assistant");
    assert.equal(assistant.length, 1, "two message events with one id must collapse to one entry");
    assert.equal(assistant[0]?.kind === "assistant" ? assistant[0].text : "", "partial then whole");
  });

  it("is deterministic across replays", () => {
    const log = transcript(...SAMPLE);
    assert.deepEqual(reduceAll(log.since(0)), reduceAll(log.since(0)));
  });

  it("converges whether a client streams from the start or joins late", () => {
    const log = transcript(...SAMPLE);
    const all = reduceAll(log.since(0));

    const split = 4;
    const caughtUp = reduceAll(log.since(split), reduceAll(log.since(0).slice(0, split)));

    assert.deepEqual(caughtUp, all, "since(N) replay must land in the same state");
  });

  it("tracks tool lifecycle and marks errors", () => {
    const state = reduceAll(
      transcript(
        { type: "tool_started", callId: "c1", name: "Bash", input: "ls" },
        { type: "tool_ended", callId: "c1", result: "boom", isError: true },
      ).since(0),
    );
    const tool = state.entries.find((entry) => entry.kind === "tool");
    assert.equal(tool?.kind === "tool" ? tool.status : "", "error");
  });

  it("keeps queue depth in view state", () => {
    const state = reduceAll(transcript({ type: "queue_changed", pending: ["a", "b"] }).since(0));
    assert.deepEqual(state.queue, ["a", "b"]);
  });

  it("does not mutate the state it is given", () => {
    const start = initialState();
    const frozen = JSON.stringify(start);
    reduceAll(transcript(...SAMPLE).since(0), start);
    assert.equal(JSON.stringify(start), frozen);
  });

  it("tracks lastSeq so a client knows where to resume", () => {
    const state = reduceAll(transcript(...SAMPLE).since(0));
    assert.equal(state.lastSeq, SAMPLE.length);
  });
});
