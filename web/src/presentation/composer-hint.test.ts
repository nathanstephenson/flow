import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { answeringPlaceholder, composerPlaceholder, sendLabel } from "./composer-hint.ts";
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
    assert.equal(composerPlaceholder(chrome({ status: "dormant" })), "Send a message to revive this Agent Session");
    assert.equal(composerPlaceholder(chrome({ status: "settled" })), "Send a message to revive this Agent Session");
    assert.match(sendLabel(chrome({ status: "dormant" })), /^Revive this Agent Session and send$/);
  });

  it("says nothing about the Steering Queue while the agent works", () => {
    assert.equal(composerPlaceholder(chrome({ status: "running" })), "Message…");
    assert.equal(composerPlaceholder(chrome({ status: "running", queueDepth: 2 })), "Message…");
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
    assert.equal(composerPlaceholder({ ...compacting, queueDepth: 2 }), "Compacting the Conversation Context…");
  });

  // A compaction Revives first (ADR 0003), so this is the state a session is really in when someone
  // compacts one they have just come back to — and "Send a message to revive this Agent Session" is stale by then.
  it("says it is compacting even from a status that would otherwise offer a Revive", () => {
    assert.match(
      composerPlaceholder(chrome({ status: "dormant", compacting: true })),
      /Compacting the Conversation Context/,
    );
  });

  it("says nothing about the queue depth", () => {
    assert.equal(composerPlaceholder(chrome({ queueDepth: 3 })), "Message…");
    assert.equal(sendLabel(chrome({ queueDepth: 3 })), "Send this message");
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

describe("what the composer says while a decision is open", () => {
  it("names the question and the way to answer it", () => {
    assert.equal(answeringPlaceholder({ index: 0, count: 1, multiSelect: false }), "Choose an answer above, or type your own");
    assert.equal(answeringPlaceholder({ index: 0, count: 3, multiSelect: false }), "Question 1 of 3: choose an answer above, or type your own");
    assert.equal(answeringPlaceholder({ index: 0, count: 1, multiSelect: true }), "Press Space to choose all that apply, or type your own");
    assert.equal(answeringPlaceholder({ index: 1, count: 3, multiSelect: true }), "Question 2 of 3: press Space to choose all that apply, or type your own");
  });

  it("asks whether a tool may run", () => {
    const authorising = { tool: "Bash" } as Chrome["authorising"];
    assert.equal(composerPlaceholder(chrome({ authorising })), "Allow Bash to run? Choose above, or press Esc to refuse");
  });
});
