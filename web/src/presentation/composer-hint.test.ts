import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { composerPlaceholder, sendLabel } from "./composer-hint.ts";
import type { Chrome } from "../store/contract.ts";

const chrome = (over: Partial<Chrome>): Chrome => ({
  status: "idle",
  backend: "claude",
  scope: "/repo",
  capabilities: undefined,
  model: undefined,
  effort: undefined,
  branch: undefined,
  worktree: undefined,
  contextUsage: undefined,
  endedReason: undefined,
  queueDepth: 0,
  activeSubagents: 0,
  activeBackgroundCalls: 0,
  asking: undefined,
  authorising: undefined,
  compacting: false,
  spoken: false,
  link: "live",
  ...over,
});

describe("what the composer promises about the next message", () => {
  it("says a Dormant or Settled Agent Session will be Revived", () => {
    // ADR 0003: the next message *is* the Revive, so this is a consequence and not a prompt.
    assert.match(composerPlaceholder(chrome({ status: "dormant" })), /Revives the Agent Session/);
    assert.match(composerPlaceholder(chrome({ status: "settled" })), /Revives the Agent Session/);
    assert.match(sendLabel(chrome({ status: "dormant" })), /^Revive this Agent Session and send$/);
  });

  it("teaches the key that queues, because while running the button is Abort", () => {
    // The whole reason this sentence exists: with no Send button on screen, Enter is the only way to
    // reach the Steering Queue, and a capability reachable only by an unguessable key is not offered.
    assert.match(composerPlaceholder(chrome({ status: "running" })), /Enter queues it/);
    assert.match(composerPlaceholder(chrome({ status: "running", queueDepth: 2 })), /Enter queues it behind 2/);
  });

  /*
   * The report this exists for: "compaction doesn't seem to do anything, or at least I can't see an
   * indicator". It had one — a pulsing 6px bar — and a compaction runs for minutes producing nothing
   * to read, so the box someone just typed into has to say what is happening rather than leave them
   * to infer it from a rhythm.
   */
  it("names a compaction rather than calling it the current turn", () => {
    const compacting = chrome({ status: "running", compacting: true });

    assert.match(composerPlaceholder(compacting), /Compacting the Conversation Context/);
    assert.match(composerPlaceholder({ ...compacting, queueDepth: 2 }), /queues it behind 2/);
  });

  // A compaction Revives first (ADR 0003), so this is the state a session is really in when someone
  // compacts one they have just come back to — and "this Revives the Agent Session" is stale by then.
  it("says it is compacting even from a status that would otherwise offer a Revive", () => {
    assert.match(
      composerPlaceholder(chrome({ status: "dormant", compacting: true })),
      /Compacting the Conversation Context/,
    );
  });

  it("names the queue depth it will land behind", () => {
    assert.match(composerPlaceholder(chrome({ queueDepth: 3 })), /behind 3/);
    assert.match(sendLabel(chrome({ queueDepth: 3 })), /behind 3/);
  });

  it("states an Ended Agent Session's reason, and that it refuses a Revive", () => {
    assert.equal(
      composerPlaceholder(chrome({ status: "ended", endedReason: "disposed" })),
      "Ended: disposed. It will not Revive.",
    );
    assert.match(composerPlaceholder(chrome({ status: "ended" })), /It will not Revive\.$/);
  });

  it("says nothing beyond the prompt when there is nothing to say", () => {
    // The idle "Enter sends, Shift+Enter for a newline" boilerplate is gone: read once, noise after.
    assert.equal(composerPlaceholder(chrome({})), "Message…");
    assert.equal(sendLabel(chrome({})), "Send this message");
  });
});
