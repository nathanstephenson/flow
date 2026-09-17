import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { WorkflowSubagentOptions } from "../../src/backend/types.ts";
import type { ModelAutoCompaction } from "../../src/protocol/settings.ts";
import { gate, piFixture, until, userText } from "./pi-fixture.ts";

const options = (id: string, extra: Partial<WorkflowSubagentOptions> = {}): WorkflowSubagentOptions => ({
  id, name: "Reviewer", instructions: "Explicit instructions", input: { id }, modelId: "flow-test/child",
  effort: "high", permissionMode: "auto-accept", emit: () => {}, ...extra,
});

const childSettings = (handle: unknown): SettingsManager =>
  (handle as { child: AgentSession }).child.settingsManager;

it("applies the workflow model's opening compaction snapshot and isolates attempts", { timeout: 15_000 }, async (t) => {
  const release = gate();
  const fixture = await piFixture(t, async () => { await release.promise; return { text: "{}" }; });
  const snapshot: ModelAutoCompaction = {
    "flow-test/parent": { mode: "disabled" },
    "flow-test/child": { mode: "enabled", targetPercent: 75 },
  };
  mkdirSync(join(fixture.scope, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(fixture.scope, ".pi", "prompts", "review.md"), "Review: $ARGUMENTS");
  const session = await fixture.create({ autoCompaction: snapshot });
  snapshot["flow-test/child"] = { mode: "disabled" };
  const first = session.startWorkflowSubagent!(options("policy-a", {
    instructions: "/review changes",
    skill: { name: "review", invocation: "/review changes" },
  }));
  await until(() => fixture.requests.length === 1);
  assert.equal(userText(fixture.requests[0]!), "Review: changes");
  assert.equal(childSettings(first).getCompactionEnabled(), true);
  assert.equal(childSettings(first).getCompactionReserveTokens(), 4096);
  assert.equal(childSettings(first).getRetrySettings().enabled, false);

  childSettings(first).applyOverrides({ compaction: { enabled: false } });
  const second = session.startWorkflowSubagent!(options("policy-b"));
  await until(() => fixture.requests.length === 2);
  assert.equal(childSettings(first).getCompactionEnabled(), false);
  assert.equal(childSettings(second).getCompactionEnabled(), true);
  assert.equal(childSettings(second).getCompactionReserveTokens(), 4096);
  const parent = (session as unknown as { session: AgentSession }).session.settingsManager;
  assert.equal(parent.getCompactionEnabled(), false, "the parent uses its own model policy");

  release.release();
  await Promise.all([first.done, second.done]);

  const reopened = await fixture.create({ autoCompaction: snapshot });
  const retry = reopened.startWorkflowSubagent!(options("policy-retry"));
  await until(() => fixture.requests.length === 3);
  assert.equal(childSettings(retry).getCompactionEnabled(), false);
  await retry.cancel();
});

it("keeps Pi backend defaults when the workflow model has no override", { timeout: 15_000 }, async (t) => {
  const release = gate();
  const fixture = await piFixture(t, async () => { await release.promise; return { text: "{}" }; });
  const session = await fixture.create({ autoCompaction: {} });
  const handle = session.startWorkflowSubagent!(options("default"));
  await until(() => fixture.requests.length === 1);
  assert.equal(childSettings(handle).getCompactionEnabled(), true);
  assert.equal(childSettings(handle).getCompactionReserveTokens(), 16384);
  await handle.cancel();
  release.release();
});

it("clears observable compaction progress when a workflow attempt is cancelled", { timeout: 15_000 }, async (t) => {
  const release = gate();
  const fixture = await piFixture(t, async () => { await release.promise; return { text: "{}" }; });
  const session = await fixture.create({ autoCompaction: {
    "flow-test/child": { mode: "enabled", targetPercent: 75 },
  } });
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const handle = session.startWorkflowSubagent!(options("compacting", { emit: (event) => activity.push(event) }));
  await until(() => fixture.requests.length === 1);
  const child = (handle as unknown as { child: AgentSession }).child;
  (child as unknown as { _emit: (event: unknown) => void })._emit({ type: "compaction_start", reason: "threshold" });
  assert.deepEqual(activity.filter(({ event }) => event.type === "compacting").map(({ event }) => event), [
    { type: "compacting", active: true },
  ]);

  await handle.cancel();
  assert.deepEqual(activity.filter(({ event }) => event.type === "compacting").map(({ event }) => event), [
    { type: "compacting", active: true },
    { type: "compacting", active: false },
  ]);
  release.release();
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

it("expands pi prompt templates and Skills while preserving workflow input and isolation", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "{}" }));
  mkdirSync(join(fixture.scope, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(fixture.scope, ".pi", "prompts", "review.md"), [
    "---", "description: Review carefully", "argument-hint: [focus]", "---", "REVIEW TEMPLATE: $ARGUMENTS",
  ].join("\n"));
  mkdirSync(join(fixture.scope, ".pi", "skills", "audit"), { recursive: true });
  writeFileSync(join(fixture.scope, ".pi", "skills", "audit", "SKILL.md"), [
    "---", "name: audit", "description: Audit the implementation", "---", "AUDIT SKILL BODY",
  ].join("\n"));
  const session = await fixture.create();

  const templateInvocation = "/review cancellation";
  const template = session.startWorkflowSubagent!(options("template", {
    instructions: templateInvocation + "\nReturn only JSON matching the schema",
    skill: { name: "review", invocation: templateInvocation },
    input: { mapped: "template" },
  }));
  assert.equal(await template.done, "{}");
  const templateRequest = fixture.requests.find((request) => request.model === "child")!;
  assert.equal(userText(templateRequest), "REVIEW TEMPLATE: cancellation");
  const templateSystem = templateRequest.messages.find((message) => message.role === "developer")?.content;
  assert.ok(String(templateSystem).includes('"mapped":"template"'));
  assert.ok(String(templateSystem).includes("Return only JSON matching the schema"));
  assert.equal(templateRequest.tools?.some((tool) => tool.function.name === "subagent"), false);

  const skillInvocation = "/audit changed files";
  const skill = session.startWorkflowSubagent!(options("skill", {
    instructions: skillInvocation + "\nReturn only JSON matching the schema",
    skill: { name: "audit", invocation: skillInvocation },
    input: { mapped: "skill" },
  }));
  assert.equal(await skill.done, "{}");
  const skillRequest = fixture.requests.filter((request) => request.model === "child").at(-1)!;
  assert.ok(userText(skillRequest).includes('<skill name="audit"'));
  assert.ok(userText(skillRequest).includes("AUDIT SKILL BODY"));
  assert.ok(userText(skillRequest).includes("changed files"));

  writeFileSync(join(fixture.scope, ".pi", "prompts", "review.md"), "UPDATED TEMPLATE: $ARGUMENTS");
  const fresh = session.startWorkflowSubagent!(options("fresh", {
    instructions: templateInvocation,
    skill: { name: "review", invocation: templateInvocation },
  }));
  assert.equal(await fresh.done, "{}");
  assert.equal(userText(fixture.requests.filter(request => request.model === "child").at(-1)!), "UPDATED TEMPLATE: cancellation");
  unlinkSync(join(fixture.scope, ".pi", "prompts", "review.md"));
  const removed = session.startWorkflowSubagent!(options("removed", {
    instructions: templateInvocation,
    skill: { name: "review", invocation: templateInvocation },
  }));
  await assert.rejects(removed.done, /Skill \/review is unavailable in the execution Scope/);

  const missing = session.startWorkflowSubagent!(options("missing", {
    instructions: "/deleted",
    skill: { name: "deleted", invocation: "/deleted" },
  }));
  await assert.rejects(missing.done, /Skill \/deleted is unavailable in the execution Scope/);
  assert.equal(fixture.requests.filter((request) => request.model === "child").length, 3);
});

for (const location of ["user", "project"]) it(`resolves configured ${location} Skills and installed package templates fresh without extensions`, { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "{}" }));
  const session = await fixture.create();
  delete process.env.PI_OFFLINE;
  const root = location === "user" ? fixture.scope : join(fixture.scope, ".pi");
  const external = join(root, "external", "audit");
  const pkg = join(root, "npm", "node_modules", "workflow-prompts");
  mkdirSync(external, { recursive: true });
  mkdirSync(join(pkg, "prompts"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "workflow-prompts", version: "1.0.0",
    pi: { prompts: ["prompts"], extensions: ["extension.js"] } }));
  const marker = join(fixture.scope, "extension-loaded");
  writeFileSync(join(pkg, "extension.js"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); export default function () {}`);
  const installMarker = join(fixture.scope, "package-install-started");
  writeFileSync(join(root, "settings.json"), JSON.stringify({ skills: ["./external"],
    packages: ["npm:workflow-prompts", "npm:workflow-not-installed"],
    npmCommand: [process.execPath, "-e", `if (process.argv.includes('install')) require('node:fs').writeFileSync(${JSON.stringify(installMarker)}, 'started')`, "--"],
  }));
  writeFileSync(join(fixture.scope, "AGENTS.md"), "PRIVATE CONTEXT");
  const files = { audit: join(external, "SKILL.md"), review: join(pkg, "prompts", "review.md") };
  for (const revision of ["INITIAL", "UPDATED"]) {
    writeFileSync(files.audit, `---\nname: audit\ndescription: Audit\n---\n${revision} AUDIT`);
    writeFileSync(files.review, `${revision} REVIEW: $ARGUMENTS`);
    for (const name of ["audit", "review"] as const) {
      const invocation = `/${name} changes`;
      const handle = session.startWorkflowSubagent!(options(`${revision}-${name}`, { instructions: invocation, skill: { name, invocation } }));
      assert.equal(await handle.done, "{}");
      const request = fixture.requests.filter(request => request.model === "child").at(-1)!;
      assert.ok(userText(request).includes(`${revision} ${name.toUpperCase()}`));
      assert.ok(!JSON.stringify(request.messages).includes("PRIVATE CONTEXT"));
      assert.equal(request.tools?.some(tool => tool.function.name === "subagent"), false);
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(installMarker), false);
    }
  }
});

for (const name of ["audit", "review"]) it(`expands multiline pi ${name} invocations`, { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "{}" }));
  mkdirSync(join(fixture.scope, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(fixture.scope, ".pi", "prompts", "review.md"), "REVIEW TEMPLATE: $ARGUMENTS");
  mkdirSync(join(fixture.scope, ".pi", "skills", "audit"), { recursive: true });
  writeFileSync(join(fixture.scope, ".pi", "skills", "audit", "SKILL.md"), [
    "---", "name: audit", "description: Audit the implementation", "---", "AUDIT SKILL BODY",
  ].join("\n"));
  const session = await fixture.create();
  const invocation = `/${name}\nextra\nretain this text`;
  const handle = session.startWorkflowSubagent!(options("multiline", {
    instructions: invocation,
    skill: { name, invocation },
  }));
  assert.equal(await handle.done, "{}");
  const text = userText(fixture.requests.find(request => request.model === "child")!);
  assert.ok(text.includes(name === "audit" ? "AUDIT SKILL BODY" : "REVIEW TEMPLATE:"));
  assert.ok(text.includes(name === "audit" ? "extra\nretain this text" : "extra retain this text"));
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
