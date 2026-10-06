import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { reduceAll, type ViewState } from "../src/client/reduce.ts";
import type { OidcGate } from "../src/daemon/auth.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { SessionLog } from "../src/daemon/log.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import type { AgentEvent, LoggedEvent } from "../src/protocol/events.ts";
import type { PresentationPage, PresentationSnapshot, PresentationState, PresentationUpdate } from "../src/protocol/presentation.ts";

const CAPS = { providers: ["fake"], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false };
const AT = "2026-01-01T00:00:00.000Z";

function metadata({ entries: _entries, lastSeq: _lastSeq, ...state }: ViewState): PresentationState {
  return state;
}

/** Thousands of raw snapshots, but only 450 reduced rows. */
function fill(log: SessionLog, count = 450): void {
  for (let index = 0; index < count; index++) {
    for (let snapshot = 0; snapshot < 4; snapshot++) {
      log.append({ type: "message", id: `m-${index}`, text: `row ${index}, snapshot ${snapshot}`, final: snapshot === 3 }, AT);
    }
  }
}

function populated(): SessionLog {
  const log = new SessionLog("s1");
  log.append({ type: "session_started", backend: "fake", scope: "/tmp", capabilities: CAPS }, AT);
  log.append({ type: "user_message", id: "u", text: "hello" }, AT);
  log.append({ type: "tool_started", callId: "tool", name: "Read", input: { path: "x" } }, AT);
  log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "running" }, AT);
  log.append({ type: "background_call", callId: "bg", tool: "Bash", state: "complete" }, AT);
  log.append({ type: "tool_started", callId: "permission", name: "Write", input: "x" }, AT);
  log.append({ type: "permission", callId: "permission", tool: "Write", state: "asked" }, AT);
  log.append({ type: "enquiry", askId: "ask", state: "asked", questions: [] }, AT);
  log.append({ type: "notice", level: "info", text: "old notice" }, AT);
  log.append({ type: "compacted", trigger: "auto", before: 1000, after: 100 }, AT);
  fill(log);
  log.append({ type: "notice", level: "info", text: "recent notice" }, AT);
  log.append({ type: "session_dormant", reason: "restart" }, AT);
  log.append({ type: "revived", fromSeq: log.lastSeq }, AT);
  log.append({ type: "turn_started", turnId: "turn" }, AT);
  return log;
}

describe("reduced Presentation Transcript", () => {
  it("lazily reduces once, then maintains the cache before notifying raw subscribers", () => {
    let reads = 0;
    const existing: LoggedEvent = {
      sessionId: "lazy", seq: 1, at: AT,
      get event(): AgentEvent { reads++; return { type: "notice", level: "info", text: "stored" }; },
    };
    const log = new SessionLog("lazy", { existing: [existing] });
    log.append({ type: "notice", level: "info", text: "unviewed" }, AT);
    assert.equal(reads, 0);
    const first = log.presentationSnapshot();
    assert.equal(reads, 1);
    const second = log.presentationSnapshot();
    assert.strictEqual(first.entries[0]?.entry, second.entries[0]?.entry);
    assert.equal(reads, 1);
    const stop = log.subscribe(() => {
      assert.equal(log.presentationPage().total, 3);
      assert.equal(log.presentationPage().seq, 3);
    });
    log.append({ type: "notice", level: "info", text: "viewed" }, AT);
    stop();
    assert.equal(reads, 1, "appending never replays old events");
  });

  it("tails reduced entries, paginates ordinals, and preserves full-replay marker IDs", () => {
    const log = populated();
    const full = reduceAll(log.since(0));
    const tail = log.presentationSnapshot();
    assert.equal(tail.entries.length, 400);
    assert.equal(tail.total, full.entries.length);
    assert.equal(tail.start, full.entries.length - 400);
    assert.equal(tail.seq, log.lastSeq);
    assert.deepEqual(tail.state, metadata(full));
    assert.deepEqual(tail.entries.map(item => item.entry), full.entries.slice(tail.start));
    assert.deepEqual(tail.entries.map(item => item.index), Array.from({ length: 400 }, (_, i) => i + tail.start));
    assert.deepEqual(tail.entries.filter(item => item.entry.kind === "marker").map(item => item.entry.id),
      full.entries.slice(tail.start).filter(item => item.kind === "marker").map(item => item.id));

    let before = tail.start;
    let older = [] as PresentationPage["entries"];
    while (before > 0) {
      const page = log.presentationPage(before, 17);
      assert.equal(page.seq, log.lastSeq);
      assert.equal(page.entries.at(-1)?.index, before - 1);
      older = [...page.entries, ...older];
      before = page.start;
    }
    assert.deepEqual([...older, ...tail.entries].map(item => item.entry), full.entries);
    assert.deepEqual(log.presentationPage(0).entries, []);
    assert.deepEqual(log.presentationPage().entries, tail.entries);
    assert.deepEqual(log.presentationSnapshot(0).entries.map(item => item.entry), full.entries);
    assert.equal(log.presentationSnapshot(tail.start - 20, 1).entries.length, 420, "reconnect limit does not truncate loaded suffix");
    assert.equal(log.presentationSnapshot(undefined, 12).entries.length, 12);
    assert.equal(log.presentationSnapshot(full.entries.length).entries.length, 0);
  });

  it("keeps a Subagent-heavy tail bounded without pretending its seq proves parent outcome coverage", () => {
    const log = new SessionLog("s1");
    log.append({ type: "message", id: "parent", text: "Parent answer", final: true }, AT);
    const outcome = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" }, AT);
    for (let index = 0; index < 450; index++) {
      log.append({ type: "message", id: `child-${index}`, text: "Subagent output", final: true, producer: { subagentId: "sub" } }, AT);
    }
    const snapshot = log.presentationSnapshot();
    assert.equal(snapshot.entries.length, 400);
    assert.ok(snapshot.seq > outcome.seq);
    assert.ok(snapshot.entries.every(item => item.entry.kind === "assistant" && item.entry.producer !== undefined));
    assert.ok(!snapshot.related.some(item => item.entry.id === "parent"));
    const older = log.presentationPage(snapshot.start);
    assert.equal(older.entries[0]?.entry.id, "parent");
    assert.equal(older.entries[0]?.outcomeSeq, outcome.seq);
    assert.ok(snapshot.entries.every(item => item.outcomeSeq === undefined), "producer rows never substitute for the parent result");
    assert.equal(older.start, 0);
    assert.equal(log.since(0).length, 452, "raw replay remains unchanged");
  });

  it("patches proof on the last parent row even when a turn ending changes no Entry identity", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "parent" }, AT);
    log.append({ type: "message", id: "parent", text: "answer", final: true }, AT);
    log.append({ type: "message", id: "child", text: "delegated", final: true, producer: { subagentId: "sub" } }, AT);
    const before = log.presentationSnapshot();
    const updates: PresentationUpdate[] = [];
    log.subscribePresentation(update => updates.push(update));
    const outcome = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" }, AT);
    const patch = updates.at(-1)!;
    assert.equal(patch.entries.length, 1);
    assert.strictEqual(patch.entries[0]?.entry, before.entries[0]?.entry);
    assert.equal(patch.entries[0]?.index, 0);
    assert.equal(patch.entries[0]?.outcomeSeq, outcome.seq);
    assert.equal(log.presentationPage().entries[0]?.outcomeSeq, outcome.seq);
    assert.equal(log.presentationSnapshot().entries[1]?.outcomeSeq, undefined);
    const replay = new SessionLog("s1", { existing: log.since(0) });
    assert.deepEqual(replay.presentationSnapshot(), log.presentationSnapshot(), "lazy replay derives the same proof as live cache maintenance");
    log.append({ type: "turn_started", turnId: "next" }, AT);
    log.append({ type: "message", id: "parent", text: "new outcome", final: true }, AT);
    const newer = log.append({ type: "turn_ended", turnId: "next", reason: "error" }, AT);
    assert.equal(log.presentationSnapshot().entries[0]?.outcomeSeq, newer.seq, "proof storage is bounded to the latest outcome per row");
  });

  it("revokes a reused answer before the next turn ends, while preserving duplicate outcome snapshots", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "A" }, AT);
    log.append({ type: "message", id: "x", text: "old unseen", final: true }, AT);
    const old = log.append({ type: "turn_ended", turnId: "A", reason: "complete" }, AT);
    assert.equal(old.seq, 3);
    log.presentationSnapshot();
    const updates: PresentationUpdate[] = [];
    log.subscribePresentation(update => updates.push(update));
    log.append({ type: "message", id: "x", text: "old unseen", final: true }, AT);
    assert.equal(log.presentationPage().entries[0]?.outcomeSeq, old.seq, "same outcome remains observable");
    log.append({ type: "turn_started", turnId: "B" }, AT);
    log.append({ type: "message", id: "x", text: "new partial", final: false }, AT);
    assert.equal(log.presentationPage().entries[0]?.outcomeSeq, undefined);
    assert.equal(updates.at(-1)?.entries[0]?.outcomeSeq, undefined);
    const end = log.append({ type: "turn_ended", turnId: "B", reason: "complete" }, AT);
    assert.equal(log.presentationPage().entries[0]?.outcomeSeq, end.seq);
    assert.deepEqual(new SessionLog("s1", { existing: log.since(0) }).presentationSnapshot(), log.presentationSnapshot());
  });

  it("revokes independent failure proofs on restart but preserves duplicate failures", () => {
    for (const kind of ["subagent", "background_call"] as const) {
      const log = new SessionLog("s1");
      const event = (state: "running" | "error"): AgentEvent => kind === "subagent"
        ? { type: kind, subagentId: "x", name: "reviewer", state }
        : { type: kind, callId: "x", tool: "Bash", state };
      log.append(event("running"), AT);
      const failed = log.append(event("error"), AT);
      assert.equal(failed.seq, 2);
      log.presentationSnapshot();
      log.append(event("error"), AT);
      assert.equal(log.presentationPage().entries[0]?.outcomeSeq, failed.seq);
      log.append(event("running"), AT);
      assert.equal(log.presentationPage().entries[0]?.outcomeSeq, undefined);
      assert.deepEqual(new SessionLog("s1", { existing: log.since(0) }).presentationSnapshot(), log.presentationSnapshot());
    }
  });

  it("revokes reused tool and Enquiry proofs, including unchanged replacement rows", () => {
    for (const restart of ["tool", "enquiry"] as const) {
      const log = new SessionLog("s1");
      log.append({ type: "turn_started", turnId: "A" }, AT);
      log.append({ type: "tool_started", callId: "x", name: "Ask", input: {} }, AT);
      log.append({ type: "enquiry", askId: "x", state: "answered", questions: [], answers: [["yes"]] }, AT);
      log.append({ type: "tool_ended", callId: "x", result: "yes", isError: false }, AT);
      const end = log.append({ type: "turn_ended", turnId: "A", reason: "complete" }, AT);
      const before = log.presentationSnapshot();
      assert.deepEqual(before.entries.map(item => item.outcomeSeq), [end.seq, end.seq]);
      const updates: PresentationUpdate[] = [];
      log.subscribePresentation(update => updates.push(update));
      log.append({ type: "tool_ended", callId: "x", result: "yes", isError: false }, AT);
      log.append({ type: "enquiry", askId: "x", state: "answered", questions: [], answers: [["yes"]] }, AT);
      assert.deepEqual(log.presentationPage().entries.map(item => item.outcomeSeq), [end.seq, end.seq]);
      log.append({ type: "turn_started", turnId: "B" }, AT);
      const unchanged = log.presentationSnapshot().entries[restart === "tool" ? 1 : 0]?.entry;
      log.append(restart === "tool"
        ? { type: "tool_started", callId: "x", name: "Ask", input: {} }
        : { type: "enquiry", askId: "x", state: "asked", questions: [] }, AT);
      assert.deepEqual(log.presentationPage().entries.map(item => item.outcomeSeq), [undefined, undefined]);
      const patch = updates.at(-1)!;
      assert.deepEqual(patch.entries.map(item => item.index), [0, 1]);
      assert.strictEqual(patch.entries[restart === "tool" ? 1 : 0]?.entry, unchanged, "proof-only revocation must publish an unchanged row");
    }
  });

  it("never substitutes independent Workflow notices for an off-tail tool result", () => {
    for (const text of ["Workflow completed. The parent will prepare the result when free.", "Workflow requires recovery. The parent will inspect it when free."]) {
      const log = new SessionLog("s1");
      log.append({ type: "turn_started", turnId: "parent" }, AT);
      log.append({ type: "tool_started", callId: "result", name: "Read", input: {} }, AT);
      log.append({ type: "tool_ended", callId: "result", result: "parent result", isError: false }, AT);
      for (let i = 0; i < 400; i++) log.append({ type: "message", id: `child-${i}`, text: "child", final: true, producer: { subagentId: "sub" } }, AT);
      const workflow = log.append({ type: "notice", level: "info", text }, AT);
      log.presentationSnapshot();
      const end = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" }, AT);
      const snapshot = log.presentationSnapshot();
      assert.equal(snapshot.entries.at(-1)?.outcomeSeq, workflow.seq);
      assert.ok(snapshot.entries.every(item => item.outcomeSeq !== end.seq));
      assert.equal(log.presentationPage(snapshot.start).entries[0]?.outcomeSeq, end.seq);
      assert.deepEqual(new SessionLog("s1", { existing: log.since(0) }).presentationSnapshot(), snapshot);
    }
  });

  it("selects the latest still-valid own answer or failure after candidates are superseded", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "parent" }, AT);
    log.append({ type: "message", id: "a", text: "parent answer", final: true }, AT);
    log.append({ type: "message", id: "b", text: "later answer", final: true }, AT);
    log.append({ type: "message", id: "b", text: "child answer", final: true, producer: { subagentId: "sub" } }, AT);
    const end = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" }, AT);
    assert.deepEqual(log.presentationPage().entries.map(item => item.outcomeSeq), [end.seq, undefined]);
    log.append({ type: "turn_started", turnId: "failure" }, AT);
    log.append({ type: "tool_started", callId: "first", name: "Bash", input: {} }, AT);
    log.append({ type: "tool_ended", callId: "first", result: "failed", isError: true }, AT);
    log.append({ type: "tool_started", callId: "second", name: "Bash", input: {} }, AT);
    log.append({ type: "tool_ended", callId: "second", result: "failed", isError: true }, AT);
    log.append({ type: "tool_started", callId: "second", name: "Bash", input: {} }, AT);
    log.append({ type: "message", id: "partial", text: "partial", final: false }, AT);
    const failed = log.append({ type: "turn_ended", turnId: "failure", reason: "error" }, AT);
    assert.equal(log.presentationPage().entries.find(item => item.entry.id === "first")?.outcomeSeq, failed.seq);
    assert.equal(log.presentationPage().entries.find(item => item.entry.id === "partial")?.outcomeSeq, undefined);
  });

  it("does not stamp a running tool or asked Enquiry as a completed result", () => {
    for (const kind of ["tool", "enquiry"] as const) {
      const log = new SessionLog("s1");
      log.append({ type: "turn_started", turnId: "parent" }, AT);
      log.append({ type: "tool_started", callId: "result", name: "Read", input: {} }, AT);
      log.append({ type: "tool_ended", callId: "result", result: "result", isError: false }, AT);
      log.append(kind === "tool"
        ? { type: "tool_started", callId: "pending", name: "Read", input: {} }
        : { type: "enquiry", askId: "pending", state: "asked", questions: [] }, AT);
      const end = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" }, AT);
      assert.deepEqual(log.presentationPage().entries.map(item => item.outcomeSeq), [end.seq, undefined]);
    }
  });

  it("keeps hidden parent answers as the proof candidate despite later visible tool chatter or notices", () => {
    for (const chatter of ["tool", "notice", "enquiry", "compacted"] as const) {
      const log = new SessionLog("s1");
      log.append({ type: "turn_started", turnId: "parent" }, AT);
      log.append({ type: "message", id: "answer", text: "parent answer", final: false }, AT);
      for (let i = 0; i < 400; i++) {
        log.append({ type: "message", id: `child-${i}`, text: "delegated", final: true, producer: { subagentId: "sub" } }, AT);
      }
      log.append({ type: "tool_started", callId: "background", name: "Bash", input: "work" }, AT);
      log.append({ type: "background_call", callId: "background", tool: "Bash", state: "running" }, AT);
      log.append({ type: "tool_ended", callId: "background", result: "launch receipt", isError: false }, AT);
      log.append({ type: "message", id: "answer", text: "final parent answer", final: true }, AT);
      if (chatter === "tool") log.append({ type: "tool_updated", callId: "background", update: "late progress" }, AT);
      if (chatter === "notice") log.append({ type: "notice", level: "info", text: "Workflow completed. The parent will prepare the result when free." }, AT);
      if (chatter === "enquiry") log.append({ type: "enquiry", askId: "old-question", questions: [], state: "answered", answers: [["yes"]] }, AT);
      if (chatter === "compacted") log.append({ type: "compacted", trigger: "auto", before: 100, after: 50 }, AT);
      log.presentationSnapshot();
      const ended = log.append({ type: "turn_ended", turnId: "parent", reason: "complete" }, AT);
      const snapshot = log.presentationSnapshot();
      assert.ok(!snapshot.entries.some(item => item.outcomeSeq === ended.seq), `${chatter} cannot stand in for the missing answer`);
      assert.equal(log.presentationPage(snapshot.start).entries.find(item => item.entry.id === "answer")?.outcomeSeq, ended.seq);
      assert.deepEqual(new SessionLog("s1", { existing: log.since(0) }).presentationSnapshot(), snapshot);
    }
  });

  it("preserves a real qualifying tool-only outcome through late progress, duplicate receipts and a newer abort", async () => {
    const host = new SessionHost();
    const backend = new FakeBackend();
    host.registerBackend(backend);
    try {
      const id = await host.create({ scope: "/tmp", backend: "fake" });
      await host.send(id, "A", "now");
      const result = { content: [{ type: "text", text: "original receipt" }] };
      const callId = backend.latest.useTool("Bash", "original call", result);
      backend.latest.completeTurn();
      await new Promise(resolve => setImmediate(resolve));
      const attention = host.list().find(summary => summary.id === id)!.attention!;
      assert.equal(attention.group, "unread");
      const log = host.logFor(id)!;
      const proof = (source: SessionLog) => source.presentationSnapshot().entries.find(item => item.entry.kind === "tool" && item.entry.id === callId)?.outcomeSeq;
      assert.equal(proof(log), attention.observedSeq); // Warm the incremental projection.
      await host.send(id, "B", "now");
      log.append({ type: "tool_updated", callId, update: "late progress" });
      assert.equal(proof(log), attention.observedSeq);
      log.append({ type: "tool_ended", callId, result: structuredClone(result), isError: false });
      assert.equal(proof(log), attention.observedSeq);
      backend.latest.completeTurn("aborted");
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(host.list().find(summary => summary.id === id)!.attention, attention);
      assert.equal(proof(log), attention.observedSeq);
      assert.equal(proof(new SessionLog(id, { existing: log.since(0) })), attention.observedSeq);
      host.acknowledge(id, attention.version);
      assert.equal(host.list().find(summary => summary.id === id)!.attention, undefined);
    } finally {
      await host.shutdown();
    }
  });

  it("does not let old Background Call progress or duplicate receipts replace a hidden tool-only result", () => {
    for (const duplicate of [false, true]) {
      const log = new SessionLog("s1");
      log.append({ type: "turn_started", turnId: "old" }, AT);
      log.append({ type: "tool_started", callId: "answer", name: "Bash", input: "old" }, AT);
      log.append({ type: "tool_ended", callId: "answer", result: "old", isError: false }, AT);
      for (let i = 0; i < 400; i++) log.append({ type: "message", id: `child-${i}`, text: "delegated", final: true, producer: { subagentId: "sub" } }, AT);
      log.append({ type: "tool_started", callId: "background", name: "Bash", input: "background job" }, AT);
      log.append({ type: "background_call", callId: "background", tool: "Bash", state: "running" }, AT);
      log.append({ type: "tool_ended", callId: "background", result: "launch receipt", isError: false }, AT);
      log.append({ type: "turn_ended", turnId: "old", reason: "complete" }, AT);
      log.append({ type: "turn_started", turnId: "next" }, AT);
      log.append({ type: "tool_started", callId: "answer", name: "Bash", input: "new" }, AT);
      log.append({ type: "tool_ended", callId: "answer", result: "unseen new parent result", isError: false }, AT);
      if (duplicate) log.append({ type: "tool_ended", callId: "background", result: "launch receipt", isError: false }, AT);
      else log.append({ type: "tool_updated", callId: "background", update: "late progress" }, AT);
      const ended = log.append({ type: "turn_ended", turnId: "next", reason: "complete" }, AT);
      const snapshot = log.presentationSnapshot();
      assert.ok(!snapshot.entries.some(item => item.outcomeSeq === ended.seq));
      assert.equal(log.presentationPage(snapshot.start).entries.find(item => item.entry.id === "answer")?.outcomeSeq, ended.seq);
    }
  });

  it("requires the explicit failure row on errored turns rather than a preceding partial answer", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "parent" }, AT);
    log.append({ type: "message", id: "answer", text: "attempting work", final: false }, AT);
    log.append({ type: "notice", level: "error", text: "work failed" }, AT);
    log.append({ type: "notice", level: "info", text: "unrelated later notice" }, AT);
    const ended = log.append({ type: "turn_ended", turnId: "parent", reason: "error" }, AT);
    assert.deepEqual(log.presentationSnapshot().entries.map(item => item.outcomeSeq), [undefined, ended.seq, undefined]);
  });

  it("associates parent tool results with the tool and its human-facing replacement card", () => {
    const log = new SessionLog("s1");
    log.append({ type: "turn_started", turnId: "spawn" }, AT);
    log.append({ type: "tool_started", callId: "sub", name: "Agent", input: "review" }, AT);
    log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "running" }, AT);
    log.append({ type: "tool_ended", callId: "sub", result: "spawned", isError: false }, AT);
    const outcome = log.append({ type: "turn_ended", turnId: "spawn", reason: "complete" }, AT);
    assert.deepEqual(log.presentationSnapshot().entries.map(item => [item.entry.kind, item.outcomeSeq]), [["tool", outcome.seq], ["subagent", outcome.seq]]);
    log.append({ type: "turn_started", turnId: "notice" }, AT);
    log.append({ type: "notice", level: "info", text: "result explanation" }, AT);
    const ended = log.append({ type: "turn_ended", turnId: "notice", reason: "error" }, AT);
    assert.equal(log.presentationPage().entries.at(-1)?.outcomeSeq, ended.seq);
  });

  it("proves only qualifying independent failures, not successful, duplicate, or unopened terminal snapshots", () => {
    const log = new SessionLog("s1");
    log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "running" }, AT);
    log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "waiting", on: "provider" }, AT);
    log.append({ type: "background_call", callId: "bg", tool: "Bash", state: "running", producer: { subagentId: "sub" } }, AT);
    log.presentationSnapshot();
    const subFailure = log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "error" }, AT);
    const bgFailure = log.append({ type: "background_call", callId: "bg", tool: "Bash", state: "error", producer: { subagentId: "sub" } }, AT);
    log.append({ type: "background_call", callId: "bg", tool: "Bash", state: "error", producer: { subagentId: "sub" } }, AT);
    log.append({ type: "subagent", subagentId: "unopened", name: "missing", state: "error" }, AT);
    log.append({ type: "background_call", callId: "ok", tool: "Bash", state: "running" }, AT);
    log.append({ type: "background_call", callId: "ok", tool: "Bash", state: "complete" }, AT);
    assert.deepEqual(log.presentationPage().entries.map(item => item.outcomeSeq), [subFailure.seq, bgFailure.seq, undefined, undefined]);
    assert.deepEqual(new SessionLog("s1", { existing: log.since(0) }).presentationSnapshot(), log.presentationSnapshot());
  });

  it("associates workflow, dispatch and backend-loss boundaries but not input or ordinary lifecycle metadata", () => {
    const log = new SessionLog("s1");
    const failure = log.append({ type: "notice", level: "error", text: "dispatch failed" }, AT);
    const recovery = log.append({ type: "notice", level: "info", text: "Workflow requires recovery. The parent will inspect it when free." }, AT);
    const complete = log.append({ type: "notice", level: "info", text: "Workflow completed. The parent will prepare the result when free." }, AT);
    log.append({ type: "notice", level: "info", text: "ordinary notice" }, AT);
    const lost = log.append({ type: "session_dormant", reason: "backend worker lost" }, AT);
    log.append({ type: "revived", fromSeq: lost.seq }, AT);
    log.append({ type: "turn_started", turnId: "ask" }, AT);
    log.append({ type: "tool_started", callId: "ask", name: "Write", input: "x" }, AT);
    const input = log.append({ type: "permission", callId: "ask", tool: "Write", state: "asked" }, AT);
    assert.ok(log.presentationSnapshot().entries.every(item => item.outcomeSeq !== input.seq));
    log.append({ type: "turn_ended", turnId: "ask", reason: "aborted" }, AT);
    log.append({ type: "turn_started", turnId: "empty" }, AT);
    const empty = log.append({ type: "turn_ended", turnId: "empty", reason: "complete" }, AT);
    const proof = log.presentationSnapshot().entries.map(item => item.outcomeSeq);
    assert.deepEqual(proof, [failure.seq, recovery.seq, complete.seq, undefined, lost.seq, undefined, undefined]);
    assert.ok(!proof.includes(empty.seq), "a previous turn's row cannot prove an empty later turn");
    log.append({ type: "turn_started", turnId: "producer-only" }, AT);
    log.append({ type: "message", id: "child-only", text: "delegated", final: true, producer: { subagentId: "sub" } }, AT);
    const childOnly = log.append({ type: "turn_ended", turnId: "producer-only", reason: "complete" }, AT);
    assert.ok(log.presentationSnapshot().entries.every(item => item.outcomeSeq !== childOnly.seq), "producer-only output cannot borrow a previous parent row");
  });

  it("publishes exact full-log Idle, Running and Awaiting state, not replay chrome", () => {
    const log = populated();
    const check = (status: PresentationState["status"]) => {
      const snapshot = log.presentationSnapshot(undefined, 1);
      assert.deepEqual(snapshot.state, metadata(reduceAll(log.since(0))));
      assert.equal(snapshot.state.status, status);
      assert.ok(!("entries" in snapshot.state));
      assert.ok(!("lastSeq" in snapshot.state));
    };
    check("running");
    log.append({ type: "turn_ended", turnId: "turn", reason: "complete" }, AT);
    check("idle");
    log.append({ type: "turn_started", turnId: "next" }, AT);
    log.append({ type: "permission", callId: "tool", tool: "Read", state: "asked" }, AT);
    check("awaiting");
    assert.equal(log.presentationSnapshot().state.authorising?.callId, "tool");
    log.append({ type: "permission", callId: "tool", tool: "Read", state: "decided", decision: "allow" }, AT);
    log.append({ type: "enquiry", askId: "next-ask", state: "asked", questions: [] }, AT);
    check("awaiting");
    assert.equal(log.presentationSnapshot().state.asking?.askId, "next-ask");
  });

  it("includes every outside card and unresolved control, without duplicating suffix rows", () => {
    const log = populated();
    // Dormant clears the active prompt but old asked rows still belong in related.
    let snapshot = log.presentationSnapshot();
    assert.deepEqual(snapshot.related.map(item => item.entry.id), ["sub", "bg", "permission", "ask"]);
    assert.ok(snapshot.related.every(item => item.index < snapshot.start));
    log.append({ type: "permission", callId: "tool", tool: "Read", state: "asked" }, AT);
    // A repeated tool-start drops authorisation on the row, but chrome still addresses it.
    log.append({ type: "tool_started", callId: "tool", name: "Read", input: "again" }, AT);
    snapshot = log.presentationSnapshot();
    assert.equal(snapshot.state.authorising?.callId, "tool");
    assert.deepEqual(snapshot.related.map(item => item.entry.id), ["tool", "sub", "bg", "permission", "ask"]);
    log.append({ type: "subagent", subagentId: "recent", name: "new", state: "running" }, AT);
    snapshot = log.presentationSnapshot();
    assert.equal(snapshot.entries.at(-1)?.entry.id, "recent");
    assert.ok(!snapshot.related.some(item => item.entry.id === "recent"));
    assert.deepEqual(log.presentationSnapshot(0).related, []);
  });

  it("diffs identities at old ordinals and sends metadata only on shallow changes", () => {
    const log = populated();
    const snapshot = log.presentationSnapshot();
    const updates: PresentationUpdate[] = [];
    const stop = log.subscribePresentation(update => updates.push(update));
    log.append({ type: "tool_updated", callId: "tool", update: "late" }, AT);
    let update = updates.at(-1)!;
    assert.equal(update.entries[0]?.index, 1);
    assert.equal(update.entries[0]?.entry.id, "tool");
    assert.ok(!("state" in update));
    log.append({ type: "subagent", subagentId: "sub", name: "reviewer", state: "complete" }, AT);
    update = updates.at(-1)!;
    assert.equal(update.entries[0]?.index, 2);
    assert.equal(update.state?.activeSubagents, 0);
    assert.deepEqual(update.state, metadata(reduceAll(log.since(0))));
    log.append({ type: "message", id: "m-449", text: "late text", final: true }, AT);
    update = updates.at(-1)!;
    assert.equal(update.entries.length, 1);
    assert.equal(update.entries[0]?.index, snapshot.entries.find(item => item.entry.id === "m-449")?.index);
    assert.ok(!("state" in update), "ordinary streaming cannot republish chrome");
    log.append({ type: "message", id: "new", text: "new text", final: false }, AT);
    update = updates.at(-1)!;
    assert.equal(update.total, snapshot.total + 1);
    assert.equal(update.entries[0]?.index, snapshot.total);
    assert.ok(!("state" in update));
    log.append({ type: "queue_changed", pending: ["queued"] }, AT);
    update = updates.at(-1)!;
    assert.deepEqual(update.entries, []);
    assert.deepEqual(update.state?.queue, ["queued"]);
    log.append({ type: "compacting", active: true }, AT);
    assert.equal(updates.at(-1)?.state?.compacting, true);
    log.append({ type: "compacting", active: false }, AT);
    assert.ok(updates.at(-1)?.state && !("compacting" in updates.at(-1)!.state!));
    log.append({ type: "tool_updated", callId: "missing", update: "ignored" }, AT);
    update = updates.at(-1)!;
    assert.equal(update.seq, log.lastSeq, "seq advances even when reducer returns the same state");
    assert.deepEqual(update.entries, []);
    assert.ok(!("state" in update));
    stop();
    const count = updates.length;
    log.append({ type: "notice", text: "unsubscribed", level: "info" }, AT);
    assert.equal(updates.length, count);
    const clear = log.subscribePresentation(update => updates.push(update));
    log.closeSubscribers();
    log.append({ type: "notice", text: "reaped", level: "info" }, AT);
    assert.equal(updates.length, count);
    clear();
  });
});

/** Tiny transport-only SSE reader: no dependency on the client connection under development. */
function frames(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    reader,
    async next<T>(): Promise<T> {
      while (true) {
        const end = buffer.indexOf("\n\n");
        if (end >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame.split("\n").find(line => line.startsWith("data: "));
          if (data) return JSON.parse(data.slice(6)) as T;
        } else {
          const chunk = await reader.read();
          assert.equal(chunk.done, false, "stream ended before the next frame");
          buffer += decoder.decode(chunk.value, { stream: true });
        }
      }
    },
  };
}

describe("presentation HTTP transport", () => {
  let host: SessionHost;
  let running: RunningServer;
  let id: string;
  let log: SessionLog;
  const token = "presentation-test-token";
  const aborters: AbortController[] = [];

  beforeEach(async () => {
    host = new SessionHost();
    host.registerBackend(new FakeBackend());
    id = await host.create({ scope: "/tmp", backend: "fake", modelId: "fake-1" });
    log = host.logFor(id);
    fill(log);
    running = await serve({ host, token, assets: {} });
  });

  afterEach(async () => {
    for (const abort of aborters.splice(0)) abort.abort();
    await running.close();
    await host.dispose(id);
  });

  const get = (path: string, authenticate = true) => fetch(`${running.url}${path}`, {
    headers: authenticate ? { authorization: `Bearer ${token}` } : {},
    signal: AbortSignal.timeout(5000),
  });
  const url = (suffix = "") => `/api/sessions/${id}/presentation${suffix}`;
  const stream = async (path: string) => {
    const abort = new AbortController();
    aborters.push(abort);
    const response = await fetch(`${running.url}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(5000)]),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    return { ...frames(response), abort };
  };

  it("sends a current snapshot FIRST, streams continuous updates, and refreshes the loaded suffix on reconnect", async () => {
    const sse = await stream(url("/events"));
    const first = await sse.next<PresentationSnapshot>();
    assert.equal(first.type, "snapshot");
    assert.equal(first.entries.length, 400);
    assert.equal(first.seq, log.lastSeq);
    assert.deepEqual(first.state, metadata(reduceAll(log.since(0))));
    log.append({ type: "message", id: "m-0", text: "late old text", final: true }, AT);
    const late = await sse.next<PresentationUpdate>();
    assert.equal(late.type, "update");
    assert.equal(late.entries[0]?.index, 0);
    assert.ok(!("state" in late));
    log.append({ type: "turn_started", turnId: "running" }, AT);
    const chrome = await sse.next<PresentationUpdate>();
    assert.equal(chrome.state?.status, "running");
    assert.deepEqual(chrome.entries, []);
    log.append({ type: "message", id: "new", text: "new row", final: false }, AT);
    const text = await sse.next<PresentationUpdate>();
    assert.equal(text.seq, log.lastSeq);
    assert.equal(text.entries[0]?.index, first.total);
    assert.ok(!("state" in text));
    sse.abort.abort();
    const reconnect = await stream(url(`/events?start=${first.start - 20}&limit=400`));
    const refreshed = await reconnect.next<PresentationSnapshot>();
    assert.equal(refreshed.type, "snapshot");
    assert.equal(refreshed.start, first.start - 20);
    assert.equal(refreshed.entries.length, 421);
    assert.equal(refreshed.state.status, "running");
    assert.equal(refreshed.seq, log.lastSeq);
    const complete = await stream(url("/events?start=0"));
    assert.equal((await complete.next<PresentationSnapshot>()).entries.length, log.presentationPage().total);
    const empty = await stream(url(`/events?start=${text.total}`));
    assert.deepEqual((await empty.next<PresentationSnapshot>()).entries, []);
    log.append({ type: "notice", text: "after empty suffix", level: "info" }, AT);
    assert.equal((await empty.next<PresentationUpdate>()).entries[0]?.index, text.total);
  });

  it("emits Idle keepalive comments without appending events and clears the timer on disconnect", async (t) => {
    const originalInterval = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    let heartbeat: (() => void) | undefined;
    let cleared = false;
    const timer = { unref: () => timer } as unknown as ReturnType<typeof setInterval>;
    // Drive only the presentation heartbeat; no fifteen-second sleep or extra durable event.
    t.mock.method(globalThis, "setInterval", (callback: () => void, milliseconds: number) => {
      if (milliseconds !== 15_000) return originalInterval(callback, milliseconds);
      heartbeat = callback;
      return timer;
    });
    t.mock.method(globalThis, "clearInterval", (handle: Parameters<typeof clearInterval>[0]) => {
      if (handle === timer) cleared = true;
      else originalClear(handle);
    });
    const abort = new AbortController();
    aborters.push(abort);
    const response = await fetch(`${running.url}${url("/events")}`, {
      headers: { authorization: `Bearer ${token}` }, signal: abort.signal,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let snapshot = "";
    while (!snapshot.includes("\n\n")) snapshot += decoder.decode((await reader.read()).value);
    const seq = log.lastSeq;
    assert.ok(heartbeat);
    heartbeat();
    assert.equal(decoder.decode((await reader.read()).value), ": keepalive\n\n");
    assert.equal(log.lastSeq, seq);
    abort.abort();
    for (let i = 0; i < 100 && !cleared; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(cleared, true, "closed clients must not retain heartbeat timers");
  });

  it("serves backward pages current as-of seq and leaves Settled Agent Sessions unrevived", async () => {
    await host.settle(id);
    const before = host.list();
    const response = await get(url());
    assert.equal(response.headers.get("cache-control"), "no-store");
    const tail = await response.json() as PresentationPage;
    assert.equal(tail.entries.length, 400);
    assert.equal(tail.seq, log.lastSeq);
    const older = await (await get(url(`?before=${tail.start}&limit=20`))).json() as PresentationPage;
    assert.equal(older.entries.length, 20);
    assert.equal(older.entries.at(-1)?.index, tail.start - 1);
    assert.equal(older.seq, log.lastSeq);
    assert.deepEqual((await (await get(url("?before=0"))).json() as PresentationPage).entries, []);
    const sse = await stream(url("/events"));
    assert.equal((await sse.next<PresentationSnapshot>()).state.status, "settled");
    assert.deepEqual(host.list(), before, "reading must not attach a Backend Session");
    assert.equal(log.lastSeq, tail.seq);
  });

  it("keeps the existing raw event replay and continuous stream unchanged", async () => {
    const raw = await stream(`/api/sessions/${id}/events?since=${log.lastSeq - 2}`);
    const expected = log.since(log.lastSeq - 2);
    assert.deepEqual(await raw.next<LoggedEvent>(), expected[0]);
    assert.deepEqual(await raw.next<LoggedEvent>(), expected[1]);
    const appended = log.append({ type: "message", id: "raw", text: "raw snapshot", final: false }, AT);
    assert.deepEqual(await raw.next<LoggedEvent>(), appended);
    const caughtUp = await stream(`/api/sessions/${id}/events?since=${log.lastSeq}`);
    const next = log.append({ type: "message", id: "raw", text: "final snapshot", final: true }, AT);
    assert.deepEqual(await caughtUp.next<LoggedEvent>(), next);
  });

  it("enforces auth, missing logs and integer/bounds validation before opening SSE", async () => {
    for (const suffix of ["", "/events"]) {
      assert.equal((await get(url(suffix), false)).status, 401);
      assert.equal((await get(`/api/sessions/missing/presentation${suffix}`)).status, 404);
      for (const bad of ["0", "-1", "401", "NaN", "1.5", "Infinity", "", "9007199254740992"]) {
        assert.equal((await get(url(`${suffix}?limit=${bad}`))).status, 400, `limit=${bad}`);
      }
      const key = suffix ? "start" : "before";
      for (const bad of ["-1", "NaN", "1.5", "Infinity", "", "9007199254740992", String(log.presentationPage().total + 1)]) {
        assert.equal((await get(url(`${suffix}?${key}=${bad}`))).status, 400, `${key}=${bad}`);
      }
    }
    const one = await (await get(url("?limit=1"))).json() as PresentationPage;
    assert.equal(one.entries.length, 1);
    const sse = await stream(url("/events?limit=1"));
    assert.equal((await sse.next<PresentationSnapshot>()).entries.length, 1);
  });

  it("registers browser SSE with the OIDC lifetime gate and detaches on close", async () => {
    await running.close();
    let end: (() => void) | undefined;
    let detached = 0;
    let registered: string | undefined;
    const gate = {
      config: { publicAppUrl: "https://flow.example" },
      authenticate: async () => "browser-session",
      registerConnection: (sessionId: string, close: () => void) => {
        registered = sessionId;
        end = close;
        return () => { detached++; };
      },
      dispose: () => {},
    } as unknown as OidcGate;
    running = await serve({ host, token, assets: {}, oidc: gate });
    const response = await fetch(`${running.url}${url("/events")}`, {
      headers: { cookie: "browser-cookie" }, signal: AbortSignal.timeout(5000),
    });
    const sse = frames(response);
    assert.equal((await sse.next<PresentationSnapshot>()).type, "snapshot");
    assert.equal(registered, "browser-session");
    end!();
    assert.equal((await sse.reader.read()).done, true);
    assert.equal(detached, 1);
  });
});
