import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { PiBackend, type PiBackendOptions } from "../../src/backend/pi/index.ts";
import type { BackendCreateOptions, BackendSession } from "../../src/backend/types.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

export type ModelRequest = {
  model: string;
  reasoning_effort?: string;
  messages: Array<{ role: string; content: unknown; tool_call_id?: string }>;
  tools?: Array<{ function: { name: string } }>;
};
export type ModelReply = { text?: string; tools?: Array<{ id: string; name: string; arguments: unknown }>; error?: string; status?: number };

export function userText(request: ModelRequest): string {
  const content = request.messages.filter((message) => message.role === "user").at(-1)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part: { text?: string }) => part.text ?? "").join("");
}

export function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

export async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "Timed out waiting for SDK events");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export async function piFixture(t: TestContext, respond: (request: ModelRequest) => ModelReply | Promise<ModelReply>, options: PiBackendOptions = {}) {
  const scope = mkdtempSync(join(tmpdir(), "flow-pi-work-"));
  const saved = { PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"], PI_OFFLINE: process.env["PI_OFFLINE"] };
  process.env["PI_CODING_AGENT_DIR"] = scope;
  process.env["PI_OFFLINE"] = "1";
  const requests: ModelRequest[] = [];
  const events: BackendEvent[] = [];
  const sessions: BackendSession[] = [];
  const server = createServer(async (request, response) => {
    try {
      let body = "";
      for await (const chunk of request) body += chunk;
      const parsed = JSON.parse(body) as ModelRequest;
      requests.push(parsed);
      const reply = await respond(parsed);
      if (reply.error) {
        response.writeHead(reply.status ?? 400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: reply.error, type: "invalid_request_error" } }));
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const delta = reply.tools
        ? { role: "assistant", tool_calls: reply.tools.map((tool, index) => ({ index, id: tool.id, type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) } })) }
        : { role: "assistant", content: reply.text ?? "ok" };
      for (const choice of [{ index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: reply.tools ? "tool_calls" : "stop" }]) {
        response.write(`data: ${JSON.stringify({ id: `response-${requests.length}`, object: "chat.completion.chunk", model: parsed.model, choices: [choice] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } catch {
      response.destroy();
    }
  });
  t.after(async () => {
    try { await Promise.all(sessions.map((session) => session.dispose())); }
    finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(scope, { recursive: true, force: true });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  writeFileSync(join(scope, "models.json"), JSON.stringify({ providers: { "flow-test": {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", apiKey: "test-only",
    models: ["parent", "child"].map((id) => ({ id, name: id, reasoning: true, input: ["text"],
      contextWindow: 16384, maxTokens: 1024, compat: { supportsReasoningEffort: true },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
  } } }));
  writeFileSync(join(scope, "settings.json"), JSON.stringify({
    retry: { enabled: false, provider: { maxRetries: 0 } }, compaction: { enabled: false, keepRecentTokens: 0 },
  }));
  const backend = new PiBackend(options);
  const create = async (overrides: Partial<BackendCreateOptions> = {}) => {
    const session = await backend.create({ scope, stateDir: join(scope, "sessions"), modelId: "flow-test/parent",
      effort: "medium", emit: (event) => events.push(event), ...overrides });
    sessions.push(session);
    return session;
  };
  return { scope, backend, create, requests, events };
}
