import assert from "node:assert/strict";
import { it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowSubagentOptions } from "../../src/backend/types.ts";
import { gate, piFixture, until, userText } from "./pi-fixture.ts";

const options = (id: string, extra: Partial<WorkflowSubagentOptions> = {}): WorkflowSubagentOptions => ({
  id, name: "Reviewer", instructions: "Explicit instructions", input: { id }, modelId: "flow-test/child",
  effort: "high", permissionMode: "auto-accept", emit: () => {}, ...extra,
});

it("isolates concurrent workflows, preserves full JSON, and leaves parent chat and abort independent", { timeout: 15_000 }, async (t) => {
  const release = gate();
  const output = JSON.stringify({ large: "x".repeat(60_000) });
  const fixture = await piFixture(t, async (request) => {
    if (request.model === "child") { await release.promise; return { text: output,
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 } }; }
    return { text: "Parent response" };
  });
  writeFileSync(join(fixture.scope, "AGENTS.md"), "PRIVATE CONTEXT FILE");
  writeFileSync(join(fixture.scope, "APPEND_SYSTEM.md"), "PRIVATE APPEND FILE");
  const session = await fixture.create();
  await session.prompt("PRIVATE PARENT CONVERSATION");
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const a = session.startWorkflowSubagent!(options("a", { emit: (event) => activity.push(event) }));
  const b = session.startWorkflowSubagent!(options("b", { effort: "low" }));
  await until(() => fixture.requests.filter((r) => r.model === "child").length === 2);
  await session.prompt("Concurrent parent chat");
  await session.abort();
  const parentCount = fixture.events.length;
  release.release();
  assert.deepEqual(await Promise.all([a.done, b.done]), [output, output]);
  assert.equal(fixture.events.length, parentCount);
  const requests = fixture.requests.filter((r) => r.model === "child");
  assert.deepEqual(requests.map((r) => r.reasoning_effort).sort(), ["high", "low"]);
  for (const request of requests) {
    const text = JSON.stringify(request.messages);
    assert.ok(text.includes("Explicit instructions"));
    assert.ok(!text.includes("PRIVATE"));
    assert.equal(request.tools?.some((tool) => tool.function.name === "subagent"), false);
    assert.equal(request.messages.filter((m) => m.role === "user").length, 1);
  }
  const spend = activity.find((a) => a.event.type === "spend")?.event;
  assert.ok(spend?.type === "spend");
  assert.equal(spend.spend.tokens, 19);
  assert.equal(spend.spend.models[0]?.id, "flow-test/child");
  assert.ok(activity.every((a) => a.subagentId === "a" && !["turn_started", "turn_ended", "context_usage"].includes(a.event.type)));
});

it("waits for Background Calls after final JSON without notifying the parent", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => request.messages.at(-1)?.role === "user" ? { tools: [{
    id: "shell", name: "bash", arguments: { command: "while [ ! -f release ]; do sleep 0.01; done", timeout: 5, run_in_background: true },
  }] } : { text: '{"done":true}' });
  const session = await fixture.create();
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const handle = session.startWorkflowSubagent!(options("a", { emit: (event) => activity.push(event) }));
  let done = false;
  void handle.done.then(() => { done = true; });
  await until(() => activity.some((a) => a.event.type === "message" && a.event.final));
  assert.equal(done, false);
  writeFileSync(join(fixture.scope, "release"), "");
  assert.equal(await handle.done, '{"done":true}');
  assert.equal(fixture.events.some((event) => event.type === "turn_started"), false);
});

it("routes permissions and Enquiries to independent handles, including Auto-accept questions", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (request.messages.at(-1)?.role === "user") return { tools: [{ id: "read", name: "read", arguments: { path: "source" } }] };
    if (!request.messages.some((m) => m.tool_call_id === "ask")) return { tools: [{ id: "ask", name: "ask_question", arguments: {
      questions: [{ header: "Choose", question: "Which?", multiSelect: false, options: [{ label: "A" }, { label: "B" }] }],
    } }] };
    return { text: '{"ok":true}' };
  });
  writeFileSync(join(fixture.scope, "source"), "Source");
  const session = await fixture.create();
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const emit: WorkflowSubagentOptions["emit"] = (event) => activity.push(event);
  const a = session.startWorkflowSubagent!(options("a", { permissionMode: "ask", emit }));
  const b = session.startWorkflowSubagent!(options("b", { emit }));
  await until(() => activity.some((a) => a.event.type === "permission") && activity.some((a) => a.event.type === "enquiry"));
  assert.equal(await b.answerPermission("read", "allow"), false);
  assert.equal(await a.answerEnquiry("ask", [["A"]]), false);
  assert.equal(await a.answerPermission("read", "always"), true);
  assert.equal(await a.answerPermission("read", "allow"), false);
  await until(() => activity.filter((a) => a.event.type === "enquiry" && a.event.state === "asked").length === 2);
  assert.equal(await a.answerEnquiry("ask", [["A"]]), true);
  assert.equal(await b.answerEnquiry("ask", [["B"]]), true);
  await Promise.all([a.done, b.done]);
  assert.equal(activity.filter((a) => a.event.type === "permission" && a.event.state === "asked").length, 1);
});

it("accepts off and rejects high for a nonreasoning model", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "{}" }));
  const path = join(fixture.scope, "models.json");
  const models = JSON.parse(readFileSync(path, "utf8"));
  models.providers["flow-test"].models.find((model: { id: string }) => model.id === "child").reasoning = false;
  writeFileSync(path, JSON.stringify(models));
  const session = await fixture.create();
  const high = session.startWorkflowSubagent!(options("high"));
  await assert.rejects(high.done, /Unsupported workflow Effort/);
  assert.equal(fixture.requests.length, 0);
  const off = session.startWorkflowSubagent!(options("off", { effort: "off" }));
  assert.equal(await off.done, "{}");
  assert.equal(fixture.requests.length, 1);
});

it("cancels startup and rejects invalid choices without model requests", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "{}" }));
  const session = await fixture.create();
  const invalid = session.startWorkflowSubagent!(options("invalid", { modelId: "missing" }));
  await assert.rejects(invalid.done, /Unknown workflow model/);
  const effort = session.startWorkflowSubagent!(options("effort", { effort: "max" }));
  await assert.rejects(effort.done, /Unsupported workflow Effort/);
  const cancelled = session.startWorkflowSubagent!(options("cancelled"));
  await cancelled.cancel();
  await assert.rejects(cancelled.done);
  const disposed = session.startWorkflowSubagent!(options("disposed"));
  await session.dispose();
  await assert.rejects(disposed.done);
  assert.throws(() => session.startWorkflowSubagent!(options("late")), /stopped/);
  assert.equal(fixture.requests.length, 0);
});

it("disposal cancels a pending permission and owned Background Calls", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => request.messages.at(-1)?.role === "user" ? { tools: [{
    id: "shell", name: "bash", arguments: { command: "sleep 30", run_in_background: true },
  }] } : { text: "{}" });
  const session = await fixture.create();
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const emit: WorkflowSubagentOptions["emit"] = (event) => activity.push(event);
  const a = session.startWorkflowSubagent!(options("a", { permissionMode: "ask", emit }));
  const b = session.startWorkflowSubagent!(options("b", { emit }));
  await until(() => activity.some((a) => a.event.type === "permission") && activity.some((a) => a.event.type === "background_call"));
  await session.dispose();
  await Promise.all([assert.rejects(a.done), assert.rejects(b.done)]);
  assert.equal(await a.answerPermission("shell", "allow"), false);
  assert.ok(activity.some((a) => a.event.type === "background_call" && a.event.state === "aborted"));
});

it("aborts an active parent turn without aborting workflow inference", { timeout: 15_000 }, async (t) => {
  const parent = gate();
  const child = gate();
  const fixture = await piFixture(t, async (request) => {
    await (request.model === "parent" ? parent : child).promise;
    return { text: "{}" };
  });
  const session = await fixture.create();
  const handle = session.startWorkflowSubagent!(options("a"));
  const prompt = session.prompt("Hold parent");
  await until(() => fixture.requests.length === 2);
  await session.abort();
  await prompt;
  assert.ok(fixture.events.some((event) => event.type === "turn_ended" && event.reason === "aborted"));
  child.release();
  assert.equal(await handle.done, "{}");
  parent.release();
});

it("cancels during SDK creation and during model inference", { timeout: 15_000 }, async (t) => {
  const release = gate();
  const fixture = await piFixture(t, async () => { await release.promise; return { text: "{}" }; });
  const session = await fixture.create();
  const startup = session.startWorkflowSubagent!(options("startup"));
  await Promise.resolve();
  await startup.cancel();
  await assert.rejects(startup.done);
  assert.equal(fixture.requests.length, 0);
  const running = session.startWorkflowSubagent!(options("running"));
  await until(() => fixture.requests.length === 1);
  await running.cancel();
  await assert.rejects(running.done);
  release.release();
});

it("honours Standing Authorisation and keeps denial separate from Enquiries", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => request.messages.at(-1)?.role === "user" ? { tools: [
    { id: "read", name: "read", arguments: { path: "source" } },
    { id: "write", name: "write", arguments: { path: "denied", content: "no" } },
  ] } : { text: "{}" });
  writeFileSync(join(fixture.scope, "source"), "Source");
  const session = await fixture.create({ standingAuthorisations: ["read"] });
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const handle = session.startWorkflowSubagent!(options("a", { permissionMode: "ask", emit: (event) => activity.push(event) }));
  await until(() => activity.some((a) => a.event.type === "permission"));
  assert.equal(await handle.answerPermission("read", "allow"), false);
  assert.equal(await handle.answerPermission("write", "deny"), true);
  assert.equal(await handle.done, "{}");
  assert.ok(activity.some((a) => a.event.type === "tool_ended" && a.event.callId === "write" && a.event.isError));
  assert.equal(activity.some((a) => a.event.type === "enquiry"), false);
});
