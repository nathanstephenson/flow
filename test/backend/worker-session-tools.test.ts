import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { BackendCreateOptions } from "../../src/backend/types.ts";
import type { SessionTools } from "../../src/backend/session-tools.ts";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { until } from "./pi-fixture.ts";

const sessionId = "f2ef600a-f80d-4801-9ecb-1322cbd75d03";
const inputs = {
  list: { offset: 4, limit: 7 },
  inspect: { sessionId, before: 12, limit: 6 },
  create: { scope: "/example", backend: "claude", modelId: "model", effort: "high", worktree: { from: "main", branch: "feature" }, text: "  create instructions  " },
  send: { sessionId, text: "  message  " },
} as const;
const builder: NonNullable<BackendCreateOptions["workflowBuilder"]> = {
  instructions: "restricted", read: async () => "", list: async () => "", write: async () => "",
};

async function fixture(t: TestContext, overrides: Partial<BackendCreateOptions> = {}, raw = false) {
  const scope = await mkdtemp(join(tmpdir(), "flow-worker-session-tools-"));
  t.after(() => rm(scope, { recursive: true, force: true }));
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ isolationMode: () => "none", ...(raw
    ? { entry: new URL("./session-tools-rpc-worker-fixture.ts", import.meta.url).pathname }
    : { backendModule: new URL("./session-tools-worker-fixture.ts", import.meta.url).href }) });
  const session = await backend.create({ scope, emit: event => events.push(event), ...overrides });
  t.after(() => session.dispose());
  const message = (id: string) => {
    const event = events.findLast(event => event.type === "message" && event.id === id);
    assert.ok(event?.type === "message");
    return JSON.parse(event.text);
  };
  return { session, message };
}

function spies() {
  const calls: Array<{ method: string; input: unknown; signal?: AbortSignal | undefined }> = [];
  const tools: SessionTools = {
    list: async input => { calls.push({ method: "list", input }); return { result: "list" }; },
    inspect: async input => { calls.push({ method: "inspect", input }); return { result: "inspect" }; },
    create: async (input, signal) => { calls.push({ method: "create", input, signal }); return { result: "create", sessionId }; },
    send: async (input, signal) => { calls.push({ method: "send", input, signal }); return { result: "send", accepted: true }; },
  };
  return { calls, tools };
}

for (const raw of [false, true]) {
  test(`worker session tools bridge validates arguments and preserves results (${raw ? "raw RPC" : "adapter callbacks"})`, async t => {
    const { calls, tools } = spies();
    const { session, message } = await fixture(t, { sessionTools: tools }, raw);
    if (raw) assert.deepEqual(message("metadata"), { sessionToolsEnabled: true, sessionToolsPresent: false });
    else {
      await session.prompt("capabilities");
      assert.deepEqual(message("capabilities"), { sessionTools: true, workflowBuilder: false });
    }
    for (const method of ["list", "inspect", "create", "send"] as const) {
      await session.prompt(JSON.stringify({ method: raw ? `session.${method}` : method, input: inputs[method] }));
      const call = calls.at(-1)!;
      assert.equal(call.method, method);
      const input = inputs[method];
      assert.deepEqual(call.input, { ...input, ...("text" in input ? { text: input.text.trim() } : {}) });
      if (method === "create" || method === "send") assert.ok(call.signal instanceof AbortSignal);
      assert.deepEqual(message("result"), { result: method, ...(method === "create" ? { sessionId } : method === "send" ? { accepted: true } : {}) });
    }
    await session.prompt(JSON.stringify({ method: raw ? "session.list" : "list", input: {} }));
    assert.deepEqual(calls.at(-1)!.input, { offset: 0, limit: 50 });
    await session.prompt(JSON.stringify({ method: raw ? "session.inspect" : "inspect", input: { sessionId } }));
    assert.deepEqual(calls.at(-1)!.input, { sessionId, limit: 30 });
  });
}

test("raw session RPC rejects invalid schemas and arbitrary properties before invoking host callbacks", async t => {
  const { calls, tools } = spies();
  const { session } = await fixture(t, { sessionTools: tools }, true);
  for (const [method, input] of [
    ["list", { limit: 101 }], ["list", { offset: -1 }], ["list", { offset: 1.5 }],
    ["inspect", { sessionId: "not-a-uuid" }], ["inspect", { sessionId, before: -1 }],
    ["create", { text: " " }], ["create", { text: "hello", worktree: { from: "main", extra: true } }],
    ["send", { sessionId, text: " " }], ["send", { sessionId: "other", text: "hello" }],
    ...Object.entries(inputs).map(([method, input]) => [method, { ...input, unexpected: true }]),
  ] as const) {
    await assert.rejects(session.prompt(JSON.stringify({ method: `session.${method}`, input })));
  }
  for (const method of ["session.constructor", "session.toString", "session.__proto__", "session.dispose"]) {
    await assert.rejects(session.prompt(JSON.stringify({ method, input: {} })), /Unknown host method/);
  }
  assert.deepEqual(calls, []);
});

for (const [name, overrides] of [
  ["absent callbacks", {}],
  ["tools:none", { tools: "none" }],
  ["workflow builder", { workflowBuilder: builder }],
  ["workflow builder with tools:none", { workflowBuilder: builder, tools: "none" }],
] as const) {
  test(`worker hides session callbacks and denies raw RPC with ${name}`, async t => {
    const { calls, tools } = spies();
    const options = { ...(name === "absent callbacks" ? {} : { sessionTools: tools }), ...overrides };
    const normal = await fixture(t, options);
    await normal.session.prompt("capabilities");
    assert.deepEqual(normal.message("capabilities"), { sessionTools: false, workflowBuilder: !!overrides.workflowBuilder });
    const raw = await fixture(t, options, true);
    assert.deepEqual(raw.message("metadata"), { sessionToolsEnabled: false, sessionToolsPresent: false });
    for (const [method, input] of Object.entries(inputs)) {
      await assert.rejects(raw.session.prompt(JSON.stringify({ method: `session.${method}`, input })), /not enabled/);
    }
    assert.deepEqual(calls, []);
  });
}

for (const method of ["create", "send"] as const) {
  test(`worker session.${method} propagates cancellation to the host callback`, async t => {
    const { tools } = spies();
    let signal: AbortSignal | undefined;
    tools[method] = async (_input, incoming) => {
      signal = incoming;
      return new Promise(resolve => incoming!.addEventListener("abort", () => resolve({ cancelled: true }), { once: true }));
    };
    const { session } = await fixture(t, { sessionTools: tools });
    const pending = assert.rejects(session.prompt(JSON.stringify({ method, input: inputs[method] })), /cancelled/);
    await until(() => !!signal);
    assert.equal(signal!.aborted, false);
    await session.abort();
    await pending;
    await until(() => signal!.aborted);
  });
}

test("worker disposal aborts in-flight host session mutations without replay", async t => {
  const { tools } = spies();
  let signal: AbortSignal | undefined;
  let calls = 0;
  tools.create = async (_input, incoming) => { calls++; signal = incoming; return new Promise(() => {}); };
  const { session } = await fixture(t, { sessionTools: tools });
  const pending = assert.rejects(session.prompt(JSON.stringify({ method: "create", input: inputs.create })), /cancelled|stopped|disconnected/);
  await until(() => !!signal);
  await session.dispose();
  await pending;
  assert.equal(signal!.aborted, true);
  assert.equal(calls, 1);
});
