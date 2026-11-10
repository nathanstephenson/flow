import assert from "node:assert/strict";
import { it, type TestContext } from "node:test";
import { query, type Options, type Query, type SDKMessage, type PreToolUseHookInput } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import { AsyncQueue } from "../../src/backend/claude/async-queue.ts";
import { sessionToolsServer, SESSION_TOOL_PREFIX as prefix } from "../../src/backend/claude/session-tools.ts";
import { sessionListInput, sessionListDescription, type SessionTools } from "../../src/backend/session-tools.ts";
import type { BackendCreateOptions } from "../../src/backend/types.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

const id = "930a74e4-c171-4e72-ad93-d6fb58dfe6ed";
const names = ["session_list", "session_inspect", "session_create", "session_send"];
const sessionTools: SessionTools = { list: async input => ({ method: "list", input }), inspect: async input => ({ method: "inspect", input }),
  create: async input => ({ method: "create", input }), send: async input => ({ method: "send", input }) };
const builder = { instructions: "Build only", read: async () => "", list: async () => "", write: async () => "" };

async function fixture(t: TestContext, options: Partial<BackendCreateOptions> = {}) {
  let launch!: Options;
  const events: BackendEvent[] = [];
  const messages = new AsyncQueue<SDKMessage>();
  const registrations: string[][] = [];
  const backend = new ClaudeBackend({ query: ((args: Parameters<typeof query>[0]) => {
    launch = args.options!;
    return { [Symbol.asyncIterator]: () => messages[Symbol.asyncIterator](),
      supportedModels: async () => [{ value: "sonnet" }],
      getContextUsage: async () => ({ totalTokens: 0, maxTokens: 100 }),
      setPermissionMode: async () => {}, close: () => messages.close(),
      mcpServerStatus: async () => Object.keys(launch.mcpServers ?? {}).map(name => ({ name, status: "connected" })),
      setMcpServers: async (servers: object) => { registrations.push(Object.keys(servers).sort()); return { added: [], removed: [], errors: {} }; },
    } as unknown as Query;
  }) as typeof query });
  const session = await backend.create({ scope: "/tmp", emit: event => events.push(event), ...options });
  t.after(() => session.dispose());
  const ask = (name: string, agentID?: string) => launch.canUseTool!(`${prefix}${name}`, { text: "work" }, {
    toolUseID: name, requestId: name, signal: new AbortController().signal, ...(agentID ? { agentID } : {}),
  });
  return { session, launch, events, ask, registrations };
}

it("Claude registers shared session schemas/descriptions and executes all four capabilities", async () => {
  assert.deepEqual(sessionToolsServer(), {});
  const signals: (AbortSignal | undefined)[] = [];
  const server = sessionToolsServer({ ...sessionTools,
    create: async (input, signal) => { signals.push(signal); return sessionTools.create(input, signal); },
    send: async (input, signal) => { signals.push(signal); return sessionTools.send(input, signal); },
  }).flow_sessions!;
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  try {
    await server.instance.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name), names);
    const list = listed.tools[0]!;
    assert.equal(list.description, sessionListDescription);
    const expected = z.toJSONSchema(sessionListInput, { io: "input" });
    assert.deepEqual(list.inputSchema.properties, expected.properties);
    assert.equal(list.inputSchema.required, undefined);
    for (const tool of listed.tools) assert.equal(tool._meta?.["anthropic/alwaysLoad"], true);
    for (const [name, args] of [["session_list", {}], ["session_inspect", { sessionId: id }],
      ["session_create", { text: "Start work" }], ["session_send", { sessionId: id, text: "More work" }]] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, undefined);
      const content = result.content as { text: string }[];
      assert.equal(JSON.parse(content[0]!.text).method, name.slice("session_".length));
    }
    assert.equal(signals.length, 2);
    assert.ok(signals.every(signal => signal instanceof AbortSignal));
  } finally {
    await client.close();
    await server.instance.close();
  }
});

it("Claude pre-approves only session reads and routes writes through the normal permission callback", async t => {
  const f = await fixture(t, { sessionTools, permissionMode: "ask" });
  assert.ok(f.launch.mcpServers?.flow_sessions);
  for (const name of names) assert.equal(f.launch.allowedTools?.includes(`${prefix}${name}`), name === "session_list" || name === "session_inspect");
  assert.equal((await f.ask("session_list"))?.behavior, "allow");
  assert.equal((await f.ask("session_inspect"))?.behavior, "allow");
  const create = f.ask("session_create");
  assert.equal(f.events.filter(event => event.type === "permission" && event.state === "asked").length, 1);
  assert.equal(await f.session.answerPermission!("session_create", "allow"), true);
  assert.equal((await create)?.behavior, "allow");
  const send = f.ask("session_send");
  assert.equal(await f.session.answerPermission!("session_send", "deny"), true);
  assert.equal((await send)?.behavior, "deny");
});

for (const mode of ["always", "standing", "auto"] as const) it(`Claude session writes honour normal ${mode} permissions`, async t => {
  const f = await fixture(t, { sessionTools, permissionMode: mode === "standing" ? "ask" : mode,
    standingAuthorisations: mode === "standing" ? [`${prefix}session_create`, `${prefix}session_send`] : [] });
  for (const name of ["session_create", "session_send"]) {
    assert.equal(f.launch.allowedTools?.includes(`${prefix}${name}`), false);
    const pending = f.ask(name);
    if (mode === "auto") {
      // Native Auto's fall-through remains an ordinary human Permission Prompt.
      assert.equal(await f.session.answerPermission!(name, "allow"), true);
    }
    assert.equal((await pending)?.behavior, "allow");
  }
});

for (const variant of ["absent", "none", "builder"] as const) it(`Claude excludes session tools for ${variant}`, async t => {
  const f = await fixture(t, variant === "absent" ? {} : { sessionTools,
    ...(variant === "none" ? { tools: "none" as const } : { workflowBuilder: builder }) });
  assert.equal(f.launch.mcpServers?.flow_sessions, undefined);
  assert.equal(f.launch.allowedTools?.some(name => name.startsWith(prefix)), false);
  assert.equal(f.launch.hooks?.PreToolUse, undefined);
  if (variant !== "absent") for (const name of names) assert.equal((await f.ask(name))?.behavior, "deny");
});

it("Claude retains session and workflow capabilities across MCP refresh", async t => {
  const f = await fixture(t, { sessionTools, workflow: { inspect: async () => ({}), recover: async () => ({}),
    relayEnquiry: async () => ({}), relayPermission: async () => ({}) } });
  await f.session.refreshMcp!();
  assert.deepEqual(f.registrations, [[], ["flow_sessions", "flow_workflow"]]);
});

it("Claude denies Subagent session tools before Always/grants and before SDK read pre-approval", async t => {
  const f = await fixture(t, { sessionTools, permissionMode: "always", standingAuthorisations: names.map(name => `${prefix}${name}`) });
  const hook = f.launch.hooks?.PreToolUse?.[0];
  assert.ok(hook);
  assert.equal(hook.matcher, `${prefix}.*`);
  for (const name of names) {
    assert.equal((await f.ask(name, "child"))?.behavior, "deny");
    const input: PreToolUseHookInput = { hook_event_name: "PreToolUse", tool_name: `${prefix}${name}`, tool_input: {},
      tool_use_id: name, session_id: "sdk", transcript_path: "unused", cwd: "/tmp", agent_id: "child" };
    const result = await hook.hooks[0]!(input, undefined, { signal: new AbortController().signal });
    assert.ok("hookSpecificOutput" in result);
    assert.equal((result.hookSpecificOutput as { permissionDecision: string }).permissionDecision, "deny");
    delete input.agent_id;
    assert.deepEqual(await hook.hooks[0]!(input, undefined, { signal: new AbortController().signal }), {});
  }
  assert.equal(f.events.some(event => event.type === "permission"), false);
});
