import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, type TestContext } from "node:test";

import { PiBackend, type PiBackendOptions } from "../../src/backend/pi/index.ts";
import type { BackendSession } from "../../src/backend/types.ts";
import type { BackendEvent, Question } from "../../src/protocol/events.ts";

const questions: Question[] = [
  {
    header: "Storage", question: "Which storage?", multiSelect: false,
    options: [{ label: "SQLite", description: "Local" }, { label: "Postgres", description: "Shared" }],
  },
  {
    header: "Checks", question: "Which checks?", multiSelect: true,
    options: [{ label: "Tests" }, { label: "Types" }],
  },
];

type ModelRequest = {
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
};

type Setup = { backend?: PiBackendOptions; input?: unknown; tools?: "none"; calls?: number };

async function start(t: TestContext, options: Setup = {}) {
  const root = mkdtempSync(join(tmpdir(), "flow-pi-enquiries-"));
  const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const oldOffline = process.env["PI_OFFLINE"];
  process.env["PI_CODING_AGENT_DIR"] = root;
  process.env["PI_OFFLINE"] = "1";
  const events: BackendEvent[] = [];
  const requests: ModelRequest[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body) as ModelRequest;
    requests.push(parsed);
    const last = parsed.messages.at(-1);
    const asking = last?.role === "user" && JSON.stringify(last.content).includes('"Ask"');
    response.writeHead(200, { "content-type": "text/event-stream" });
    const delta = asking
      ? { role: "assistant", tool_calls: Array.from({ length: options.calls ?? 1 }, (_, index) => ({
          index, id: `ask-${index + 1}`, type: "function", function: {
            name: "ask_question", arguments: JSON.stringify(options.input ?? { questions }),
          },
        })) }
      : { role: "assistant", content: "ok" };
    response.write(`data: ${JSON.stringify({ id: "response-1", object: "chat.completion.chunk", model: "test-model",
      choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: "response-1", object: "chat.completion.chunk", model: "test-model",
      choices: [{ index: 0, delta: {}, finish_reason: asking ? "tool_calls" : "stop" }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  let session: BackendSession | undefined;
  t.after(async () => {
    try {
      await session?.dispose();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
      else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
      if (oldOffline === undefined) delete process.env["PI_OFFLINE"];
      else process.env["PI_OFFLINE"] = oldOffline;
      rmSync(root, { recursive: true, force: true });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(join(root, "models.json"), JSON.stringify({ providers: {
    "flow-enquiry-test": {
      baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only",
      models: [{ id: "test-model", name: "Test", reasoning: false, input: ["text"],
        contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  } }));
  writeFileSync(join(root, "settings.json"), JSON.stringify({
    retry: { enabled: false }, compaction: { enabled: false },
  }));
  const backend = new PiBackend(options.backend);
  const create = (resume = false) => backend.create({
    scope: root, stateDir: join(root, "sessions"), modelId: "flow-enquiry-test/test-model",
    ...(resume ? { resume: join(root, "sessions") } : {}),
    ...(options.tools ? { tools: options.tools } : {}),
    emit: (event) => events.push(event),
  });
  session = await create();
  return { session, events, requests, revive: async () => {
    session = await create(true);
    return session;
  } };
}

async function waitForAsked(events: BackendEvent[], count = 1) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const asked = events.filter((event) => event.type === "enquiry" && event.state === "asked")[count - 1];
    if (asked?.type === "enquiry") return asked;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`No Enquiry: ${JSON.stringify(events)}`);
}

it("holds a pi turn until the human answers and returns every answer to the model", { timeout: 15_000 }, async (t) => {
  const { session, events, requests } = await start(t);
  assert.equal(session.capabilities.enquiries, true);
  assert.ok(session.answerEnquiry);
  const turn = session.prompt("Ask");
  const asked = await waitForAsked(events);
  assert.equal(asked.askId, "ask-1");
  assert.deepEqual(asked.questions, questions);
  assert.equal(events.some((event) => event.type === "turn_ended"), false);
  const call = events.find((event) => event.type === "tool_started" && event.callId === asked.askId);
  assert.ok(call);
  assert.ok(events.indexOf(call) < events.indexOf(asked));

  const answers = [["Use an existing database"], ["Tests", "Types"]];
  assert.equal(await session.answerEnquiry(asked.askId, answers), true);
  await turn;
  assert.deepEqual(events.filter((event) => event.type === "enquiry"), [
    asked, { type: "enquiry", askId: asked.askId, questions, state: "answered", answers },
  ]);
  const result = requests.at(-1)?.messages.find((message) => message.role === "tool" && message.tool_call_id === asked.askId);
  assert.ok(result);
  for (const answer of answers.flat()) assert.ok(JSON.stringify(result.content).includes(answer));
  assert.equal(events.filter((event) => event.type === "turn_ended").length, 1);
});

it("aborts an open pi Enquiry and accepts a later turn", { timeout: 15_000 }, async (t) => {
  const { session, events } = await start(t);
  const turn = session.prompt("Ask");
  const asked = await waitForAsked(events);
  await session.abort();
  await turn;
  assert.deepEqual(events.filter((event) => event.type === "enquiry"), [
    asked, { type: "enquiry", askId: asked.askId, questions, state: "aborted" },
  ]);
  assert.equal(await session.answerEnquiry?.(asked.askId, [["SQLite"], ["Tests"]]), false);
  assert.equal(events.find((event) => event.type === "turn_ended")?.reason, "aborted");
  await session.prompt("Continue");
  assert.deepEqual(events.filter((event) => event.type === "turn_ended").map((event) => event.reason),
    ["aborted", "complete"]);
});

it("disposes an open pi Enquiry before Revive, preserving its tool result", { timeout: 15_000 }, async (t) => {
  const { session, events, requests, revive } = await start(t);
  const turn = session.prompt("Ask");
  const asked = await waitForAsked(events);
  await session.dispose();
  await turn;
  assert.deepEqual(events.filter((event) => event.type === "enquiry"), [
    asked, { type: "enquiry", askId: asked.askId, questions, state: "aborted" },
  ]);
  assert.equal(await session.answerEnquiry?.(asked.askId, [["SQLite"], ["Tests"]]), false);
  const revived = await revive();
  assert.equal(await revived.answerEnquiry?.(asked.askId, [["SQLite"], ["Tests"]]), false);
  await revived.prompt("Continue");
  const result = requests.at(-1)?.messages.find((message) => message.role === "tool" && message.tool_call_id === asked.askId);
  assert.ok(result, "Revive must not leave an unanswered tool call in the Conversation Context");
  assert.match(JSON.stringify(result.content), /aborted|did not answer/i);
  assert.equal(events.filter((event) => event.type === "enquiry").length, 2);
});

it("refuses incomplete and stale answers without losing the open pi Enquiry", { timeout: 15_000 }, async (t) => {
  const { session, events } = await start(t);
  assert.ok(session.answerEnquiry);
  assert.equal(await session.answerEnquiry("missing", []), false);
  const turn = session.prompt("Ask");
  const asked = await waitForAsked(events);
  assert.equal(await session.answerEnquiry(asked.askId, [["SQLite"]]), false);
  assert.deepEqual(events.filter((event) => event.type === "enquiry"), [asked]);
  assert.equal(await session.answerEnquiry(asked.askId, [["SQLite"], ["Tests"]]), true);
  assert.equal(await session.answerEnquiry(asked.askId, [["Postgres"], ["Types"]]), false);
  await turn;
  assert.equal(events.filter((event) => event.type === "enquiry" && event.state === "answered").length, 1);
});

it("rejects malformed question input as a tool error without opening an Enquiry", { timeout: 15_000 }, async (t) => {
  const { session, events } = await start(t, { input: { questions: [] } });
  await session.prompt("Ask");
  assert.equal(events.some((event) => event.type === "enquiry"), false);
  assert.equal(events.find((event) => event.type === "tool_ended")?.isError, true);
  assert.equal(events.filter((event) => event.type === "turn_ended").length, 1);
});

it("does not wait for an Enquiry attempted by a Summary Model", { timeout: 15_000 }, async (t) => {
  const { session, events } = await start(t, { tools: "none" });
  await session.prompt("Ask");
  assert.equal(events.some((event) => event.type === "enquiry"), false);
  assert.equal(events.find((event) => event.type === "tool_ended")?.isError, true);
  assert.equal(events.filter((event) => event.type === "turn_ended").length, 1);
});

it("keeps simultaneous Enquiries separate when one is answered and the turn is aborted", { timeout: 15_000 }, async (t) => {
  const { session, events } = await start(t, { calls: 2 });
  const turn = session.prompt("Ask");
  const first = await waitForAsked(events);
  const second = await waitForAsked(events, 2);
  assert.notEqual(first.askId, second.askId);
  assert.equal(await session.answerEnquiry?.(second.askId, [["SQLite"], ["Tests"]]), true);
  assert.equal(events.some((event) => event.type === "turn_ended"), false);
  await session.abort();
  await turn;
  assert.deepEqual(events.filter((event) => event.type === "enquiry").map((event) => [event.askId, event.state]), [
    [first.askId, "asked"], [second.askId, "asked"], [second.askId, "answered"], [first.askId, "aborted"],
  ]);
});

const selections: Array<{ name: string; options: Setup; enabled: boolean }> = [
  { name: "default tools", options: {}, enabled: true },
  { name: "explicit question tool", options: { backend: { tools: ["ask_question"] } }, enabled: true },
  { name: "no tools", options: { backend: { tools: [] } }, enabled: false },
  { name: "read-only tools", options: { backend: { tools: ["read"] } }, enabled: false },
  { name: "Summary Model tool suppression", options: { backend: { tools: ["ask_question"] }, tools: "none" }, enabled: false },
];

for (const { name, options, enabled } of selections) {
  it(`declares Enquiries consistently with ${name}`, { timeout: 15_000 }, async (t) => {
    const { session, requests } = await start(t, options);
    await session.setModel("flow-enquiry-test/test-model");
    assert.equal(session.capabilities.enquiries, enabled);
    assert.equal(typeof session.answerEnquiry === "function", enabled);
    await session.prompt("Continue");
    const tools = requests[0]?.tools?.map((tool) => tool.function.name) ?? [];
    assert.equal(tools.includes("ask_question"), enabled);
    if (options.tools === "none" || options.backend?.tools?.length === 0) assert.deepEqual(tools, []);
  });
}
