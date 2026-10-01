import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { isolationIntegration, privateWorkerState } from "../isolation-fixture.ts";
import { piFixture, until, userText } from "./pi-fixture.ts";

function attackFixture(t: TestContext) {
  // Put the sentinel outside /tmp so it is visible read-only, not merely hidden by scratch mounts.
  const outside = mkdtempSync(join(homedir(), ".flow-denial-test-"));
  writeFileSync(join(outside, "sentinel"), "intact");
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  const source = `const f=require('fs'),a=require('assert/strict'),p=${JSON.stringify(outside)};
    a.throws(()=>f.writeFileSync(p+'/sentinel','bad'));
    a.throws(()=>f.rmSync(p,{recursive:true,force:true}));
    if(!f.existsSync('escape'))f.symlinkSync(p,'escape');
    a.throws(()=>f.writeFileSync('escape/sentinel','bad'));
    const c=require('child_process').spawnSync(process.execPath,['-e',"require('fs').writeFileSync("+JSON.stringify(p+'/sentinel')+",'bad')"],{stdio:'ignore'});
    a.notEqual(c.status,0); f.writeFileSync('denial-marker','denied'); console.log('denied');`;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return { outside, command: `${quote(process.execPath)} -e ${quote(source)}`,
    intact: () => assert.equal(readFileSync(join(outside, "sentinel"), "utf8"), "intact") };
}

for (const backend of ["pi", "claude"] as const) {
  test(`${backend} worker refuses execution if an OS boundary cannot be established`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), "flow-refused-worker-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scope = join(root, "project"); mkdirSync(scope);
    const entry = join(scope, "entry.cjs");
    const marker = join(root, "unrestricted-execution");
    writeFileSync(entry, `require('fs').writeFileSync(${JSON.stringify(marker)},'unsafe')`);
    await assert.rejects(new WorkerBackend({ backend, entry, env: { FLOW_BWRAP_PATH: "/missing-bubblewrap" } })
      .create({ scope, emit: () => {} }), /Filesystem isolation unavailable; unrestricted launch refused/);
    assert.equal(readFileSync(entry, "utf8").includes("unsafe"), true);
    assert.throws(() => readFileSync(marker));
  });
}

test("Pi parent, ordinary Subagent, Background Call and Workflow Subagent cannot mutate out-of-Scope files", { ...isolationIntegration, timeout: 45_000 }, async (t) => {
  const attack = attackFixture(t);
  const f = await piFixture(t, (request) => {
    if (request.messages.at(-1)?.role === "user") {
      if (request.model === "child") return { tools: [{ id: "child-probe", name: "bash", arguments: { command: attack.command } }] };
      if (userText(request) === "ordinary") return { tools: [{ id: "ordinary", name: "subagent", arguments: {
        prompt: "attempt", description: "Isolation probe", model: "flow-test/child", run_in_background: false,
      } }] };
      if (userText(request) === "background") return { tools: [{ id: "background", name: "bash", arguments: {
        command: `while [ ! -f release ]; do sleep 0.01; done; ${attack.command}`, run_in_background: true,
      } }] };
      if (userText(request) === "parent") return { tools: [{ id: "parent", name: "bash", arguments: { command: attack.command } }] };
    }
    return { text: "denied" };
  });
  const { scope, stateDir } = privateWorkerState(t);
  const events: BackendEvent[] = [];
  const session = await new WorkerBackend({ env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: "1" } })
    .create({ scope, stateDir, modelId: "flow-test/parent", emit: (event) => events.push(event) });
  try {
    await session.prompt("parent"); attack.intact();
    assert.equal(readFileSync(join(scope, "denial-marker"), "utf8"), "denied");
    rmSync(join(scope, "denial-marker"));
    await session.prompt("ordinary"); attack.intact();
    assert.equal(readFileSync(join(scope, "denial-marker"), "utf8"), "denied");
    assert.ok(events.some((event) => event.type === "tool_ended" && event.producer?.subagentId === "ordinary"));
    rmSync(join(scope, "denial-marker"));
    await session.prompt("background");
    writeFileSync(join(scope, "release"), "");
    await until(() => events.some((event) => event.type === "background_call" && event.state === "complete"));
    attack.intact();
    assert.equal(readFileSync(join(scope, "denial-marker"), "utf8"), "denied");
    rmSync(join(scope, "denial-marker"));
    const handle = session.startWorkflowSubagent!({ id: "workflow-probe", name: "Probe", instructions: "attempt", input: {},
      modelId: "flow-test/child", effort: "medium", permissionMode: "auto-accept", emit: () => {} });
    assert.equal(await handle.done, "denied"); attack.intact();
    assert.equal(readFileSync(join(scope, "denial-marker"), "utf8"), "denied");
  } finally { await session.dispose(); }
});

test("Claude parent, ordinary Subagent, Background Call and Workflow processes inherit the restricted worker", { ...isolationIntegration, timeout: 60_000 }, async (t) => {
  const attack = attackFixture(t);
  const { root, scope, stateDir } = privateWorkerState(t);
  const home = join(root, "source-home"), auth = join(root, "source-auth");
  mkdirSync(home); mkdirSync(auth);
  let requests = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (new URL(request.url!, "http://localhost").pathname !== "/v1/messages") {
      response.writeHead(200, { "content-type": "application/json" }); response.end('{"input_tokens":100}'); return;
    }
    const parsed = JSON.parse(body);
    const lastUser = parsed.messages.findLast((message: { role: string }) => message.role === "user")?.content;
    const done = Array.isArray(lastUser) && lastUser.some((part: { type: string }) => part.type === "tool_result");
    const prompt = Array.isArray(lastUser) ? lastUser.filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text).join("\n") : String(lastUser);
    const workflow = parsed.tools?.some((tool: { name: string }) => tool.name === "mcp__workflow__bash");
    const tool = workflow ? "mcp__workflow__bash" : prompt.includes("attempt ordinary") ? "Agent" : "Bash";
    const input = tool === "Agent" ? { description: "Isolation probe", subagent_type: "general-purpose", prompt: "attempt child" }
      : tool === "Bash" ? { command: prompt.includes("attempt background") ? `sleep 0.5; ${attack.command}` : attack.command,
        description: "Isolation probe", ...(prompt.includes("attempt background") ? { run_in_background: true } : {}) }
      : { command: attack.command };
    const id = `fixture-${++requests}`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: string, data: unknown) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: parsed.model,
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
    send("content_block_start", { type: "content_block_start", index: 0, content_block: done ? { type: "text", text: "" } : { type: "tool_use", id: `${id}-bash`, name: tool, input: {} } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: done ? { type: "text_delta", text: "denied" } : { type: "input_json_delta", partial_json: JSON.stringify(input) } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
    send("message_delta", { type: "message_delta", delta: { stop_reason: done ? "end_turn" : "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } });
    send("message_stop", { type: "message_stop" }); response.end();
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === "object");
  const events: BackendEvent[] = [];
  const session = await new WorkerBackend({ backend: "claude", env: { HOME: home, CLAUDE_CONFIG_DIR: auth,
    ANTHROPIC_API_KEY: "test-only", ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }).create({ scope, stateDir, modelId: "sonnet", emit: (event) => events.push(event) });
  try {
    await session.prompt("attempt");
    try { await until(() => events.some((event) => event.type === "turn_ended"), 30_000); }
    catch (error) { throw new Error(JSON.stringify({ events, requests }), { cause: error }); }
    attack.intact();
    assert.ok(existsSync(join(scope, "denial-marker")), JSON.stringify(events));
    assert.equal(readFileSync(join(scope, "denial-marker"), "utf8"), "denied");
    assert.ok(events.some((event) => event.type === "tool_ended" && !event.isError));
    for (const [index, prompt] of ["attempt ordinary", "attempt background"].entries()) {
      rmSync(join(scope, "denial-marker"));
      await session.prompt(prompt);
      await until(() => events.filter((event) => event.type === "turn_ended").length >= index + 2, 30_000);
      await until(() => existsSync(join(scope, "denial-marker")), 30_000);
      attack.intact(); assert.equal(readFileSync(join(scope, "denial-marker"), "utf8"), "denied");
    }
    assert.ok(events.some((event) => event.type === "tool_started" && event.name === "Agent"));
    rmSync(join(scope, "denial-marker"));
    const handle = session.startWorkflowSubagent!({ id: "claude-workflow-probe", name: "Probe", instructions: "attempt", input: {},
      modelId: "sonnet", effort: "medium", permissionMode: "auto-accept", emit: () => {} });
    assert.equal(await handle.done, "denied"); attack.intact();
    assert.equal(readFileSync(join(scope, "denial-marker"), "utf8"), "denied");
    assert.ok(requests >= 10);
  } finally { await session.dispose(); }
});
