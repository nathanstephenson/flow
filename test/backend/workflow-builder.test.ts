import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { query, type Options, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import { AsyncQueue } from "../../src/backend/claude/async-queue.ts";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { workflowBuilderTools, type WorkflowBuilder } from "../../src/backend/workflow-builder.ts";
import { claudeWorkflowBuilderToolNames } from "../../src/backend/claude/workflow-builder.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import type { McpSession } from "../../src/backend/mcp.ts";
import { piFixture, until } from "./pi-fixture.ts";
import { SessionHost } from "../../src/daemon/host.ts";

const bwrap = process.env.FLOW_BWRAP_PATH ?? "/usr/bin/bwrap";
const probe = process.platform === "linux" ? spawnSync(bwrap, ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--", "/bin/true"], { encoding: "utf8", timeout: 10000 }) : undefined;
const restricted = { timeout: 60000, skip: !probe || probe.error || probe.status !== 0 ? "Bubblewrap namespaces unavailable" : false };

const names = workflowBuilderTools.map(tool => tool.name);
const workflow = { inspect: async () => null, recover: async () => null, relayEnquiry: async () => null, relayPermission: async () => null };
function builderFixture() {
  const calls: Array<[string, string]> = [];
  const builder: WorkflowBuilder = {
    instructions: "Only author a Workflow Definition using the host capabilities.",
    read: async path => { calls.push(["read", path]); return "host reference"; },
    list: async path => { calls.push(["list", path]); return "host examples"; },
    write: async content => { calls.push(["write", content]); if (content === "invalid") throw new Error("Host validation refused"); return "saved draft"; },
  };
  return { builder, calls };
}

it("host cancellation stops a worker whose adapter creation has not resolved", { timeout: 5000 }, async t => {
  const scope = await mkdtemp(join(tmpdir(), "flow-builder-cancel-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const controller = new AbortController();
  let reached = false;
  const backend = new WorkerBackend({ backend: "pi", isolationEnabled: () => false,
    backendModule: new URL("./workflow-builder-worker-fixture.ts", import.meta.url).href,
    startupTimeoutMs: 2000, shutdownTimeoutMs: 20,
  });
  const opening = backend.create({ scope, signal: controller.signal, emit: () => {}, workflowBuilder: {
    instructions: "delay-start", read: async () => { reached = true; return "ready"; },
    list: async () => "", write: async () => "",
  } });
  const rejected = assert.rejects(opening);
  await until(() => reached);
  controller.abort();
  await rejected;
});

it("Pi builder exposes only host tools and ignores ambient resources, grants, and configured tools", { timeout: 20000 }, async t => {
  const { builder, calls } = builderFixture();
  let turn = 0;
  const f = await piFixture(t, () => {
    turn++;
    return turn === 1 ? { tools: [
      { id: "read", name: names[0]!, arguments: { path: "reference" } },
      { id: "list", name: names[1]!, arguments: { path: "examples" } },
      { id: "write", name: names[2]!, arguments: { content: "draft" } },
      // Even an unsolicited native tool call must not execute.
      { id: "denied", name: "bash", arguments: { command: "exit 99" } },
    ] } : { text: "done" };
  }, { tools: ["bash", "read", "subagent", "workflow_inspect"] });
  mkdirSync(join(f.scope, ".pi", "extensions"), { recursive: true });
  mkdirSync(join(f.scope, ".pi", "prompts"), { recursive: true });
  mkdirSync(join(f.scope, ".pi", "skills", "ambient"), { recursive: true });
  writeFileSync(join(f.scope, "AGENTS.md"), "AMBIENT AUTHORITY");
  writeFileSync(join(f.scope, ".pi", "SYSTEM.md"), "AMBIENT AUTHORITY");
  writeFileSync(join(f.scope, ".pi", "APPEND_SYSTEM.md"), "AMBIENT AUTHORITY");
  writeFileSync(join(f.scope, ".pi", "prompts", "ambient.md"), "AMBIENT AUTHORITY");
  writeFileSync(join(f.scope, ".pi", "skills", "ambient", "SKILL.md"), "---\nname: ambient\ndescription: AMBIENT AUTHORITY\n---\nAMBIENT AUTHORITY");
  writeFileSync(join(f.scope, ".pi", "extensions", "bad.ts"), "throw new Error('ambient extension executed')");
  const mcp = { tools: () => { throw new Error("Builder accessed MCP tools"); } } as unknown as McpSession;
  const session = await f.create({ workflowBuilder: builder, workflow, mcp, tools: "none", permissionMode: "always",
    standingAuthorisations: ["bash", "subagent"], compactionModelId: "flow-test/child" });
  assert.equal(session.capabilities.subagents, false);
  assert.equal(session.capabilities.enquiries, false);
  assert.equal(session.capabilities.permissions, false);
  assert.deepEqual(await session.skills!(), []);
  assert.throws(() => session.startWorkflowSubagent!({} as never), /builder cannot create Subagents/);
  await session.prompt("Build draft");
  assert.deepEqual(calls, [["read", "reference"], ["list", "examples"], ["write", "draft"]]);
  assert.ok(f.requests.length >= 2);
  for (const request of f.requests) {
    assert.deepEqual(request.tools?.map(tool => tool.function.name).sort(), [...names].sort());
    const messages = JSON.stringify(request.messages);
    assert.ok(messages.includes(builder.instructions));
    assert.ok(!messages.includes("AMBIENT AUTHORITY"));
  }
  assert.ok(f.events.some(event => event.type === "tool_ended" && event.callId === "denied" && event.isError));
  assert.ok(!f.events.some(event => event.type === "permission" || event.type === "enquiry"));
  await session.refreshMcp!();
  await session.setPermissionMode!("auto");
  await session.setModel("flow-test/child");
  await session.prompt("Still restricted");
  assert.deepEqual(f.requests.at(-1)?.tools?.map(tool => tool.function.name).sort(), [...names].sort());
});

it("restricted Pi builder starts, uses host tools, reopens, and discovers models with linked ambient resources", restricted, async t => {
  const { builder, calls } = builderFixture();
  let turn = 0;
  const f = await piFixture(t, () => ++turn === 1 ? { tools: [
    { id: "read", name: names[0]!, arguments: { path: "reference" } },
    { id: "list", name: names[1]!, arguments: { path: "examples" } },
    { id: "write", name: names[2]!, arguments: { content: "draft" } },
  ] } : { text: "done" });
  const root = await mkdtemp(join(tmpdir(), "flow-restricted-builder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, "project"), stateDir = join(root, "backend"), ambient = join(root, "ambient");
  for (const path of [scope, stateDir, ambient]) mkdirSync(path);
  writeFileSync(join(ambient, "AGENTS.md"), "AMBIENT AUTHORITY");
  symlinkSync(join(ambient, "AGENTS.md"), join(f.scope, "AGENTS.md"));
  symlinkSync(ambient, join(f.scope, "skills"));
  writeFileSync(join(f.scope, "auth.json"), '{"flow-test":{"type":"api_key","key":"test-only"}}');
  const credentials = ["auth.json", "models.json", "settings.json"].map(name => [name, readFileSync(join(f.scope, name), "utf8")] as const);
  const backend = new WorkerBackend({ backend: "pi", isolationEnabled: () => true,
    env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: "1", FLOW_BWRAP_PATH: bwrap } });
  const host = new SessionHost();
  host.registerBackend(backend);
  t.after(() => host.shutdown());
  const events: BackendEvent[] = [];
  const options = { scope, stateDir, workflowBuilder: builder, modelId: "flow-test/parent", emit: (event: BackendEvent) => events.push(event) };
  const session = await host.createWorkflowBuilderSession("pi", options);
  t.after(() => session.dispose());
  assert.deepEqual(await session.skills!(), []);
  await session.prompt("Build draft");
  await until(() => events.some(event => event.type === "turn_ended"), 15000);
  assert.deepEqual(calls, [["read", "reference"], ["list", "examples"], ["write", "draft"]]);
  const resume = session.resumeToken();
  await session.dispose();
  const reopened = await backend.create({ ...options, ...(resume ? { resume } : {}) });
  t.after(() => reopened.dispose());
  await reopened.prompt("Continue draft");
  await until(() => events.filter(event => event.type === "turn_ended").length === 2, 15000);
  await reopened.dispose();
  const beforeProbe = f.requests.length;
  const listing = await host.workflowBuilderModels("pi", scope);
  assert.equal(listing.problem, undefined);
  assert.ok(listing.models.some(model => model.id === "flow-test/parent"));
  assert.equal(f.requests.length, beforeProbe);
  for (const request of f.requests) {
    assert.deepEqual(request.tools?.map(tool => tool.function.name).sort(), [...names].sort());
    assert.ok(!JSON.stringify(request.messages).includes("AMBIENT AUTHORITY"));
  }
  for (const [name, content] of credentials) assert.equal(readFileSync(join(f.scope, name), "utf8"), content);
  const ordinary = await host.models(scope);
  assert.match(ordinary[0]!.problem ?? "", /Unsafe Pi resource/);
});

it("Claude builder excludes native and external tools and cannot relax its permission gate", async t => {
  const { builder, calls } = builderFixture();
  const messages = new AsyncQueue<SDKMessage>();
  const modes: string[] = [];
  let launch!: Options;
  const backend = new ClaudeBackend({ allowedTools: ["Bash", "Agent"], systemPrompt: "ambient prompt", query: ((args: Parameters<typeof query>[0]) => {
    launch = args.options!;
    return {
      [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      supportedModels: async () => [{ value: "sonnet" }],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      setPermissionMode: async (mode: string) => { modes.push(mode); },
      close: () => messages.close(),
    } as unknown as Query;
  }) as typeof query });
  const mcp = { get connections() { throw new Error("Builder accessed external MCP"); } } as unknown as McpSession;
  const session = await backend.create({ scope: "/tmp", workflowBuilder: builder, workflow, mcp,
    tools: "none", permissionMode: "auto", standingAuthorisations: ["Bash", "Agent"], emit: () => {} });
  t.after(() => session.dispose());
  assert.equal(launch.systemPrompt, builder.instructions);
  assert.deepEqual(launch.tools, []);
  assert.deepEqual(launch.settingSources, []);
  assert.deepEqual(launch.skills, []);
  assert.deepEqual(launch.plugins, []);
  assert.deepEqual(launch.agents, {});
  assert.equal(launch.strictMcpConfig, true);
  assert.equal(launch.permissionMode, "default");
  assert.deepEqual(launch.allowedTools, claudeWorkflowBuilderToolNames);
  assert.deepEqual(Object.keys(launch.mcpServers!), ["flow_workflow_builder"]);
  assert.equal(session.capabilities.subagents, false);
  assert.deepEqual(await session.skills!(), []);
  assert.throws(() => session.startWorkflowSubagent!({} as never), /builder cannot create Subagents/);
  await session.refreshMcp!();
  const input = { path: "reference" };
  const extra = { toolUseID: "call", requestId: "request", signal: new AbortController().signal, suggestions: [] };
  for (const mode of ["ask", "auto", "always"] as const) {
    await session.setPermissionMode!(mode);
    for (const name of ["Bash", "Read", "Write", "AskUserQuestion", "Agent", "mcp__external__tool", "workflow_builder_read", "mcp__flow_workflow_builder__evil"]) {
      assert.equal((await launch.canUseTool!(name, input, extra))?.behavior, "deny", `${mode}: ${name}`);
    }
    for (const name of claudeWorkflowBuilderToolNames) assert.equal((await launch.canUseTool!(name, input, extra))?.behavior, "allow");
  }
  assert.deepEqual(modes, ["default", "default", "default", "default"]);
  const server = launch.mcpServers!.flow_workflow_builder;
  assert.ok(server?.type === "sdk");
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  t.after(async () => { await client.close(); await server.instance.close(); });
  await server.instance.connect(serverTransport);
  await client.connect(clientTransport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name), names);
  for (const tool of listed.tools) assert.equal(tool._meta?.["anthropic/alwaysLoad"], true);
  for (const [name, args] of [[names[0]!, { path: "reference" }], [names[1]!, { path: "examples" }], [names[2]!, { content: "draft" }]] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.ok(!result.isError);
  }
  assert.deepEqual(calls, [["read", "reference"], ["list", "examples"], ["write", "draft"]]);
  const invalid = await client.callTool({ name: names[2]!, arguments: { content: "invalid" } });
  assert.equal(invalid.isError, true);
});

it("worker serializes only builder instructions, proxies three host closures, and validates reverse RPC", { timeout: 20000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "flow-builder-worker-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { builder, calls } = builderFixture();
  const events: BackendEvent[] = [];
  const mcp = { tools: () => { throw new Error("Builder serialized MCP"); } } as unknown as McpSession;
  // No filesystem isolation is needed to enforce builder authority.
  const backend = new WorkerBackend({ backendModule: new URL("./workflow-builder-worker-fixture.ts", import.meta.url).href,
    isolationEnabled: () => false });
  const session = await backend.create({ scope: root, workflowBuilder: builder, workflow, mcp, emit: event => events.push(event) });
  t.after(() => session.dispose());
  assert.equal(session.refreshMcp, undefined);
  assert.equal(session.startWorkflowSubagent, undefined);
  await session.prompt("builder");
  assert.deepEqual(calls, [["read", "reference"], ["list", "examples"], ["write", '{"name":"Draft"}']]);
  const output = () => events.findLast(event => event.type === "message");
  assert.deepEqual(output(), { type: "message", id: "builder", text: `${builder.instructions}\nhost reference\nhost examples\nsaved draft`, final: true });
  await session.prompt("invalid");
  assert.match((output() as { text: string }).text, /Invalid workflow builder input/);
  assert.equal(calls.length, 3);
  await session.prompt("error");
  assert.match((output() as { text: string }).text, /Host validation refused/);
});

it("builder host rejects other reverse RPC capabilities even from a misbehaving worker", async t => {
  const root = await mkdtemp(join(tmpdir(), "flow-builder-rpc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { builder, calls } = builderFixture();
  const events: BackendEvent[] = [];
  const session = await new WorkerBackend({ isolationEnabled: () => false,
    entry: fileURLToPath(new URL("./workflow-builder-rpc-fixture.ts", import.meta.url)),
  }).create({ scope: root, workflowBuilder: builder, workflow, mcp: { tools: () => { throw new Error("MCP must not be consulted"); } } as unknown as McpSession,
    emit: event => events.push(event) });
  t.after(() => session.dispose());
  const output = events.find(event => event.type === "message");
  assert.ok(output?.type === "message");
  const errors = JSON.parse(output.text) as string[];
  assert.equal(errors.length, 9);
  for (const error of errors.slice(0, 6)) assert.match(error, /Host capability is not enabled/);
  for (const error of errors.slice(6)) assert.match(error, /Invalid workflow builder input/);
  assert.deepEqual(calls, []);
});

for (const isolated of [false, true]) it(`${isolated ? "restricted" : "direct"} installed Claude CLI declares only the three builder tools and executes them through the host`, isolated ? restricted : { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), "flow-claude-builder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, "project"), config = join(root, "user-config"), home = join(root, "home"), stateDir = join(root, "backend");
  for (const path of [scope, config, home, stateDir]) mkdirSync(path);
  writeFileSync(join(root, "authority.md"), "AMBIENT AUTHORITY");
  symlinkSync(join(root, "authority.md"), join(config, "CLAUDE.md"));
  symlinkSync(scope, join(config, "skills"));
  writeFileSync(join(config, ".credentials.json"), "{}");
  writeFileSync(join(home, ".claude.json"), "{}");
  mkdirSync(join(scope, ".claude", "skills", "ambient"), { recursive: true });
  writeFileSync(join(scope, "CLAUDE.md"), "AMBIENT AUTHORITY");
  writeFileSync(join(scope, ".claude", "skills", "ambient", "SKILL.md"), "---\nname: ambient\ndescription: AMBIENT AUTHORITY\n---\nAMBIENT AUTHORITY");
  writeFileSync(join(scope, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "exit 99" }] }] }, permissions: { allow: ["Bash", "Agent"] } }));
  const { builder, calls } = builderFixture();
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body || "{}");
    if (request.url?.includes("count_tokens")) { response.end('{"input_tokens":1}'); return; }
    if (!JSON.stringify(parsed).includes(builder.instructions)) { response.end("{}"); return; }
    requests.push(parsed);
    const number = requests.length;
    const name = claudeWorkflowBuilderToolNames[number - 1];
    const input = number === 3 ? { content: "draft" } : { path: number === 1 ? "reference" : "examples" };
    const message = { id: `msg_${number}`, type: "message", role: "assistant", model: parsed.model,
      content: name ? [{ type: "tool_use", id: `call_${number}`, name, input }] : [{ type: "text", text: "done" }],
      stop_reason: name ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 } };
    if (!parsed.stream) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(message)); return; }
    response.setHeader("Content-Type", "text/event-stream");
    const send = (type: string, data: object) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send("message_start", { message: { ...message, content: [], stop_reason: null } });
    send("content_block_start", { index: 0, content_block: name ? { type: "tool_use", id: `call_${number}`, name, input: {} } : { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: name ? { type: "input_json_delta", partial_json: JSON.stringify(input) } : { type: "text_delta", text: "done" } });
    send("content_block_stop", { index: 0 });
    send("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 5 } });
    send("message_stop", {});
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address() as { port: number };
  const events: BackendEvent[] = [];
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: undefined, FLOW_BWRAP_PATH: bwrap,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`, ANTHROPIC_API_KEY: "dummy-local-key",
    ANTHROPIC_AUTH_TOKEN: undefined, CLAUDE_CODE_OAUTH_TOKEN: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_USE_BEDROCK: undefined, CLAUDE_CODE_USE_VERTEX: undefined, CLAUDE_CODE_USE_FOUNDRY: undefined };
  const backend = isolated ? new WorkerBackend({ backend: "claude", isolationEnabled: () => true, env })
    : new ClaudeBackend({ query: args => query({ ...args, options: { ...args.options, env: { ...args.options?.env, ...env } } }) });
  const options = { scope, stateDir, workflowBuilder: builder, permissionMode: "always" as const, emit: (event: BackendEvent) => events.push(event) };
  const session = await backend.create(options);
  t.after(() => session.dispose());
  await session.prompt("Build draft");
  await until(() => events.some(event => event.type === "turn_ended"), 20000);
  assert.deepEqual(calls, [["read", "reference"], ["list", "examples"], ["write", "draft"]]);
  assert.equal(requests.length, 4);
  if (isolated) {
    const resume = session.resumeToken();
    await session.dispose();
    const reopened = await backend.create({ ...options, ...(resume ? { resume } : {}) });
    t.after(() => reopened.dispose());
    await reopened.prompt("Continue draft");
    await until(() => events.filter(event => event.type === "turn_ended").length === 2, 20000);
    await reopened.dispose();
    const host = new SessionHost();
    host.registerBackend(backend);
    t.after(() => host.shutdown());
    const beforeProbe = requests.length;
    const listing = await host.workflowBuilderModels("claude", scope);
    assert.equal(listing.problem, undefined);
    assert.ok(listing.models.length);
    assert.equal(requests.length, beforeProbe);
    assert.equal(readFileSync(join(config, ".credentials.json"), "utf8"), "{}");
    assert.equal(readFileSync(join(home, ".claude.json"), "utf8"), "{}");
    const ordinary = await host.models(scope);
    assert.match(ordinary[0]!.problem ?? "", /Unsafe Claude resource/);
  }
  for (const request of requests) {
    assert.deepEqual((request.tools as { name: string }[]).map(tool => tool.name).sort(), [...claudeWorkflowBuilderToolNames].sort());
    assert.ok(!JSON.stringify(request).includes("AMBIENT AUTHORITY"));
  }
  assert.ok(!events.some(event => event.type === "permission" || event.type === "enquiry"));
});
