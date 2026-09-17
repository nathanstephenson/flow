import assert from "node:assert/strict";
import { it } from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { query, type Options, type Query, type SDKMessage, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { WorkflowSubagentOptions } from "../../src/backend/types.ts";
import type { ModelAutoCompaction } from "../../src/protocol/settings.ts";
import { AsyncQueue } from "../../src/backend/claude/async-queue.ts";
import { ClaudeWorkflowSubagent, spawnWorkflowProcess } from "../../src/backend/claude/workflow-subagent.ts";
import { WorkflowProcesses } from "../../src/backend/claude/workflow-processes.ts";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";

const gate = () => { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; };
const options = (extra: Partial<WorkflowSubagentOptions> = {}): WorkflowSubagentOptions => ({
  id: "step", name: "Step", instructions: "Explicit instructions", input: { value: 1 }, modelId: "sonnet", effort: "high",
  permissionMode: "auto-accept", emit: () => {}, ...extra,
});
const result = (text = "{}") => ({ type: "result", subtype: "success", result: text, modelUsage: {
  sonnet: { inputTokens: 2, outputTokens: 3, cacheReadInputTokens: 4, cacheCreationInputTokens: 1, costUSD: 0.1 },
} } as unknown as SDKMessage);

function fixture(extra: Partial<WorkflowSubagentOptions> = {}, effort = true, autoCompaction: ModelAutoCompaction = {}) {
  const messages = new AsyncQueue<SDKMessage>();
  const started = gate();
  const stopped = gate();
  const closed = gate();
  let launch!: Options;
  let prompt!: AsyncIterable<unknown>;
  const events: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const process = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    exitCode: null, killed: false, kill: () => { stopped.resolve(); return true; } }) as unknown as SpawnedProcess;
  const handle = new ClaudeWorkflowSubagent({ cwd: "/tmp" }, options({ emit: (e) => events.push(e), ...extra }), new Set(), {
    spawn: () => ({ process, stopped: stopped.promise }),
    query: ((args: Parameters<typeof query>[0]) => {
      launch = args.options!;
      prompt = args.prompt as AsyncIterable<unknown>;
      launch.spawnClaudeCodeProcess!({ command: "unused", args: [], env: {}, signal: new AbortController().signal });
      started.resolve();
      return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](), supportedModels: async () => [{ value: "sonnet", supportsEffort: effort,
        supportedEffortLevels: effort ? ["low", "high"] : [] }], close: () => { messages.close(); closed.resolve(); } } as unknown as Query;
    }) as typeof query,
  }, autoCompaction);
  return { handle, events, messages, started, stopped, closed, launch: () => launch, prompt: () => prompt };
}

it("isolates query options, preserves full JSON and Spend, and waits for SDK process exit", { timeout: 5000 }, async () => {
  const f = fixture();
  await f.started.promise;
  const launch = f.launch();
  assert.deepEqual(launch.settingSources, []);
  assert.deepEqual(launch.skills, []);
  assert.equal(launch.persistSession, false);
  assert.equal(launch.resume, undefined);
  assert.equal(launch.strictMcpConfig, true);
  assert.equal(launch.model, "sonnet");
  assert.equal(launch.effort, "high");
  assert.deepEqual((await f.prompt()[Symbol.asyncIterator]().next()).value, {
    type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: '{"value":1}' },
  });
  const text = JSON.stringify({ value: "x".repeat(80_000) });
  f.messages.push(result(text));
  await f.closed.promise;
  let done = false;
  void f.handle.done.then(() => { done = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  f.stopped.resolve();
  assert.equal(await f.handle.done, text);
  assert.deepEqual(f.events, [{ subagentId: "step", event: { type: "spend", spend: {
    tokens: 10, cached: 4, costUSD: 0.1, models: [{ id: "sonnet", tokens: 10, cached: 4, costUSD: 0.1 }],
  } } }]);
});

it("applies each workflow model's opening compaction policy without losing isolation flags", { timeout: 5000 }, async () => {
  const snapshot: ModelAutoCompaction = { sonnet: { mode: "enabled", targetPercent: 82 } };
  const enabled = fixture({}, true, snapshot);
  snapshot.sonnet = { mode: "disabled" };
  const disabled = fixture({}, true, { sonnet: { mode: "disabled" } });
  const defaults = fixture();
  await Promise.all([enabled.started.promise, disabled.started.promise, defaults.started.promise]);

  assert.equal(enabled.launch().env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "82");
  assert.equal(enabled.launch().env?.DISABLE_AUTO_COMPACT, "0");
  assert.equal(disabled.launch().env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
  assert.equal(disabled.launch().env?.DISABLE_AUTO_COMPACT, "1");
  assert.equal(defaults.launch().env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
  assert.equal(defaults.launch().env?.DISABLE_AUTO_COMPACT, process.env.DISABLE_AUTO_COMPACT);
  for (const launch of [enabled.launch(), disabled.launch(), defaults.launch()]) {
    assert.equal(launch.env?.PATH, process.env.PATH, "the child preserves its startup environment");
    assert.equal(launch.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1");
    assert.equal(launch.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, "1");
    assert.equal(launch.env?.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS, "1");
    assert.equal(launch.persistSession, false);
    assert.deepEqual(launch.settingSources, []);
  }
  // Each attempt receives a fresh environment object rather than one mutable shared child policy.
  enabled.launch().env!.DISABLE_AUTO_COMPACT = "changed";
  assert.equal(disabled.launch().env?.DISABLE_AUTO_COMPACT, "1");

  for (const f of [enabled, disabled, defaults]) { f.messages.push(result()); f.stopped.resolve(); }
  assert.deepEqual(await Promise.all([enabled.handle.done, disabled.handle.done, defaults.handle.done]), ["{}", "{}", "{}"]);
});

it("records Claude compact boundaries and continues the same attempt to final JSON", { timeout: 5000 }, async () => {
  const f = fixture();
  await f.started.promise;
  let done = false;
  void f.handle.done.then(() => { done = true; });
  f.messages.push({ type: "system", subtype: "compact_boundary", compact_metadata: {
    trigger: "auto", pre_tokens: 84_000, post_tokens: 22_000,
  } } as unknown as SDKMessage);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(done, false, "compaction does not complete the Workflow Step");
  f.messages.push({ type: "assistant", uuid: "after-compaction", message: {
    content: [{ type: "text", text: '{"draft":true}' }],
  } } as unknown as SDKMessage);
  f.messages.push(result('{"final":true}'));
  f.stopped.resolve();
  assert.equal(await f.handle.done, '{"final":true}');
  assert.deepEqual(f.events.filter(({ event }) => event.type === "compacted"), [{
    subagentId: "step",
    event: { type: "compacted", trigger: "auto", before: 84_000, after: 22_000 },
  }]);
  assert.equal(f.events.some(({ event }) => event.type === "compacting"), false,
    "Claude exposes no truthful automatic-compaction start signal");
  assert.equal(f.events.filter(({ event }) => event.type === "message").length, 1);
});

it("routes independent permissions and never auto-answers Enquiries", { timeout: 5000 }, async () => {
  const a = fixture({ permissionMode: "ask" });
  const b = fixture();
  await Promise.all([a.started.promise, b.started.promise]);
  const ask = (f: ReturnType<typeof fixture>, id: string, name: string, input = {}) => f.launch().canUseTool!(name, input,
    { toolUseID: id, requestId: id, signal: new AbortController().signal });
  const allowed = ask(a, "same", "Read");
  assert.equal(await b.handle.answerPermission("same", "always"), false);
  assert.equal(await a.handle.answerPermission("same", "always"), true);
  assert.equal((await allowed)?.behavior, "allow");
  assert.equal(await a.handle.answerPermission("same", "always"), false);
  assert.equal((await ask(a, "next", "Read"))?.behavior, "allow");
  const question = ask(b, "same", "AskUserQuestion", { questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B" }] }] });
  assert.equal(await a.handle.answerEnquiry("same", [["A"]]), false);
  assert.equal(await b.handle.answerEnquiry("same", [["B"]]), true);
  assert.equal((await question)?.behavior, "allow");
  const pending = ask(a, "write", "Write");
  a.stopped.resolve(); b.stopped.resolve();
  await Promise.all([a.handle.cancel(), b.handle.cancel()]);
  assert.equal((await pending)?.behavior, "deny");
  assert.equal(await a.handle.answerPermission("write", "always"), false);
  await Promise.all([assert.rejects(a.handle.done), assert.rejects(b.handle.done)]);
});

it("cancels before startup and strictly validates model and Effort, including no-Effort models", { timeout: 5000 }, async () => {
  const early = fixture();
  await early.handle.cancel();
  await assert.rejects(early.handle.done);
  for (const extra of [{ modelId: "missing" }, { effort: "max" as const }, { effort: "off" as const }]) {
    const f = fixture(extra);
    f.stopped.resolve();
    await assert.rejects(f.handle.done, /Unknown workflow model|Unsupported workflow Effort/);
  }
  const unsupported = fixture({}, false);
  unsupported.stopped.resolve();
  await assert.rejects(unsupported.handle.done, /Unsupported workflow Effort/);
  const off = fixture({ effort: "off" }, false);
  await off.started.promise;
  assert.equal(off.launch().effort, undefined);
  off.messages.push(result()); off.stopped.resolve();
  assert.equal(await off.handle.done, "{}");
});

it("keeps the backend-open snapshot stable for child attempts and refreshes it on reopen", { timeout: 5000 }, async () => {
  const runs: { launch: Options; messages: AsyncQueue<SDKMessage> }[] = [];
  const backend = new ClaudeBackend({ query: ((args: Parameters<typeof query>[0]) => {
    const messages = new AsyncQueue<SDKMessage>();
    runs.push({ launch: args.options!, messages });
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      supportedModels: async () => [
        { value: "opus", supportedEffortLevels: ["high"] },
        { value: "sonnet", supportedEffortLevels: ["high"] },
      ],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      interrupt: async () => {},
      close: () => messages.close(),
    } as unknown as Query;
  }) as typeof query });
  const snapshot: ModelAutoCompaction = {
    opus: { mode: "disabled" }, sonnet: { mode: "enabled", targetPercent: 77 },
  };
  const parent = await backend.create({ scope: "/tmp", modelId: "opus", autoCompaction: snapshot, emit: () => {} });
  snapshot.sonnet = { mode: "disabled" };
  const first = parent.startWorkflowSubagent!(options());
  while (runs.length < 2) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs[0]!.launch.env?.DISABLE_AUTO_COMPACT, "1", "parent model keeps its own policy");
  assert.equal(runs[1]!.launch.env?.DISABLE_AUTO_COMPACT, "0");
  assert.equal(runs[1]!.launch.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "77");
  runs[1]!.messages.push(result());
  assert.equal(await first.done, "{}");

  // A retry opened by the same parent keeps the same snapshot, even after the Settings edit.
  const retry = parent.startWorkflowSubagent!(options({ id: "retry" }));
  while (runs.length < 3) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs[2]!.launch.env?.DISABLE_AUTO_COMPACT, "0");
  assert.equal(runs[2]!.launch.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "77");
  runs[2]!.messages.push(result());
  assert.equal(await retry.done, "{}");
  await parent.dispose();

  const reopened = await backend.create({ scope: "/tmp", modelId: "opus", autoCompaction: snapshot, emit: () => {} });
  const refreshed = reopened.startWorkflowSubagent!(options());
  while (runs.length < 5) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs[4]!.launch.env?.DISABLE_AUTO_COMPACT, "1");
  assert.equal(runs[4]!.launch.env?.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined);
  runs[4]!.messages.push(result());
  assert.equal(await refreshed.done, "{}");
  await reopened.dispose();
});

it("registers handles before startup, leaves parent abort independent, and awaits starting handles on repeated disposal", { timeout: 5000 }, async () => {
  const release = gate();
  const started = gate();
  const streams: { closed: boolean; interrupted: number }[] = [];
  const backend = new ClaudeBackend({ query: ((args: Parameters<typeof query>[0]) => {
    const messages = new AsyncQueue<SDKMessage>();
    const state = { closed: false, interrupted: 0 };
    streams.push(state);
    const child = args.options?.persistSession === false;
    if (child) started.resolve();
    return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      supportedModels: async () => { if (child) await release.promise; return [{ value: "sonnet", supportedEffortLevels: ["high"] }]; },
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      interrupt: async () => { state.interrupted++; },
      close: () => { state.closed = true; messages.close(); },
    } as unknown as Query;
  }) as typeof query });
  const session = await backend.create({ scope: "/tmp", emit: () => {} });
  const handle = session.startWorkflowSubagent!(options());
  await started.promise;
  await session.abort();
  assert.deepEqual(streams.map((s) => s.interrupted), [1, 0]);
  assert.equal(streams[1]!.closed, false);
  let disposed = false;
  const first = session.dispose();
  const second = session.dispose().then(() => { disposed = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(disposed, false);
  release.resolve();
  await Promise.all([first, second]);
  await assert.rejects(handle.done);
  assert.throws(() => session.startWorkflowSubagent!(options()), /disposed/);
  const next = await backend.create({ scope: "/tmp", emit: () => {} });
  const early = next.startWorkflowSubagent!(options());
  const count = streams.length;
  await next.dispose();
  await assert.rejects(early.done);
  assert.equal(streams.length, count);
});

it("owns Background Calls until exit and kills process groups on disposal", { timeout: 5000 }, async () => {
  const events: unknown[] = [];
  const work = new WorkflowProcesses("/tmp", (event) => events.push(event));
  work.start("sleep 30 & wait", true);
  let done = false;
  const draining = work.drain().then(() => { done = true; });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(done, false);
  await work.dispose();
  await draining;
  assert.deepEqual(events.map((e) => (e as { state: string }).state), ["running", "aborted"]);
});

it("retains complete WorkflowProcesses output above 100k", { timeout: 5000 }, async () => {
  const work = new WorkflowProcesses("/tmp", () => {});
  const id = work.start("printf '%100001s' x", false);
  await work.drain();
  const output = JSON.parse(work["result"](id).content[0]!.text);
  assert.equal(output.truncated, undefined);
  assert.equal(output.output.length, 100_001);
});

for (const scenario of ["ask", "auto-accept", "cancel"] as const) it(`installed Claude CLI isolates input and owns human input and background work (${scenario})`, { timeout: 30_000 }, async (t) => {
  const permissionMode = scenario === "ask" ? "ask" : "auto-accept";
  let processesStopped = 0;
  const scope = await mkdtemp(join(tmpdir(), "flow-claude-workflow-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  await writeFile(join(scope, "CLAUDE.md"), "PRIVATE CONTEXT MUST NOT LOAD");
  const requests: Record<string, unknown>[] = [];
  const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
  const final = gate();
  let turn = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body || "{}");
    if (request.url?.includes("count_tokens")) { response.end('{"input_tokens":1}'); return; }
    if (!JSON.stringify(parsed).includes("Explicit instructions")) { response.end("{}"); return; }
    requests.push(parsed);
    const calls = [
      { name: "Read", input: { file_path: join(scope, "source") } },
      { name: "AskUserQuestion", input: { questions: [{ header: "Choose", question: "Which?", multiSelect: false,
        options: [{ label: "A", description: "First" }, { label: "B", description: "Second" }] }] } },
      { name: "mcp__workflow__bash", input: { command: "while [ ! -f release ]; do sleep 0.01; done", run_in_background: true } },
    ];
    const call = calls[turn++];
    const message = { id: `msg_test_${turn}`, type: "message", role: "assistant", model: parsed.model,
      content: call ? [{ type: "tool_use", id: `call_${turn}`, ...call }] : [{ type: "text", text: '{"ok":true}' }],
      stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
    if (!parsed.stream) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(message)); return; }
    response.setHeader("Content-Type", "text/event-stream");
    const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { ...message, content: [], stop_reason: null } });
    send("content_block_start", { index: 0, content_block: call ? { type: "tool_use", id: `call_${turn}`, name: call.name, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: call ? { type: "input_json_delta", partial_json: JSON.stringify(call.input) } : { type: "text_delta", text: '{"ok":true}' } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
    send("message_stop", {});
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  await writeFile(join(scope, "source"), "SOURCE FILE");
  const handle = new ClaudeWorkflowSubagent({ cwd: scope }, options({ permissionMode, emit: (event) => {
    activity.push(event);
    if (event.event.type === "permission" && event.event.state === "asked") void handle.answerPermission(event.event.callId, "always");
    if (event.event.type === "enquiry" && event.event.state === "asked") {
      if (scenario === "cancel") void handle.cancel();
      else void handle.answerEnquiry(event.event.askId, [["B"]]);
    }
    if (event.event.type === "message" && event.event.text === '{"ok":true}') final.resolve();
  } }), new Set(), { spawn: (options) => {
    const owned = spawnWorkflowProcess(options);
    void owned.stopped.then(() => { processesStopped++; });
    return owned;
  }, query: (args) => query({ ...args,
    options: { ...args.options, env: { ...args.options?.env, HOME: scope, CLAUDE_CONFIG_DIR: scope,
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "dummy-local-key",
      ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_USE_BEDROCK: undefined,
      CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined,
    } },
  }) });
  t.after(() => handle.cancel());
  if (scenario === "cancel") {
    await assert.rejects(handle.done);
    assert.equal(processesStopped, 1);
    assert.ok(activity.some((a) => a.event.type === "enquiry" && a.event.state === "aborted"));
    return;
  }
  let done = false;
  void handle.done.then(() => { done = true; }, () => {});
  await Promise.race([final.promise, handle.done]);
  assert.equal(done, false);
  assert.ok(activity.some((a) => a.event.type === "background_call" && a.event.state === "running"), JSON.stringify({ activity, requests }));
  await writeFile(join(scope, "release"), "");
  assert.equal(await handle.done, '{"ok":true}');
  assert.equal(processesStopped, 1);
  assert.ok(activity.some((a) => a.event.type === "background_call" && a.event.state === "complete"));
  assert.ok(activity.some((a) => a.event.type === "enquiry" && a.event.state === "answered"), JSON.stringify(activity));
  assert.equal(activity.filter((a) => a.event.type === "permission" && a.event.state === "asked").length, permissionMode === "ask" ? 2 : 0);
  assert.ok(JSON.stringify(requests).includes("SOURCE FILE"));
  assert.ok(JSON.stringify(requests).includes('\\"Which?\\"=\\"B\\"'));
  const request = requests.find((r) => JSON.stringify(r).includes("Explicit instructions"));
  assert.ok(request);
  assert.ok(!JSON.stringify(request).includes("PRIVATE CONTEXT"));
  assert.equal((request.output_config as { effort: string }).effort, "high");
  const tools = request.tools as { name: string }[];
  assert.ok(!tools.some((tool) => ["Agent", "Task", "Bash", "Monitor", "Skill"].includes(tool.name)));
  const background = activity.find((a) => a.event.type === "background_call");
  assert.equal(background?.event.type === "background_call" && background.event.callId, "call_3");
  assert.ok(JSON.stringify(request).includes('\\"value\\":1'));
});
