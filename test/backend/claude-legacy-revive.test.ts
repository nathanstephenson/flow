import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import type { AgentBackend } from "../../src/backend/types.ts";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { SessionHost } from "../../src/daemon/host.ts";
import { TranscriptStore } from "../../src/daemon/store.ts";
import { until } from "./pi-fixture.ts";

const prompts = ["LEGACY_FIRST_CONTEXT_MARKER", "REVIVED_SECOND_CONTEXT_MARKER", "OWNED_THIRD_CONTEXT_MARKER"];
const replies = ["legacy context recorded", "continued legacy context", "continued owned context"];

function event(response: ServerResponse, name: string, data: unknown): void {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function reply(response: ServerResponse, text: string, stream: boolean, sequence: number): void {
  const usage = { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  const message = {
    id: `msg_legacy_fixture_${sequence}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null, usage,
  };
  if (!stream) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, "message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } });
  event(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  event(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  event(response, "content_block_stop", { type: "content_block_stop", index: 0 });
  event(response, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
  event(response, "message_stop", { type: "message_stop" });
  response.end();
}

function files(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(root, entry.name)).map(file => join(entry.name, file)) : [entry.name]).sort();
}

// No mocked query results or CLI subprocess: both generations use the installed SDK/CLI.
// Only inference is fake, so --resume must really find and deserialize Claude's durable record
// before supportedModels() can succeed (the original failure happened during Backend creation).
test("a legacy Claude Agent Session revives after a Host update and keeps owned context across another restart", { timeout: 60_000 }, async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flow-claude-legacy-revive-")));
  const scope = join(root, "scope"), home = join(root, "home"), config = join(home, ".claude");
  for (const dir of [scope, config]) mkdirSync(dir, { recursive: true });
  const requests: Array<{ messages?: unknown; stream?: boolean }> = [];
  const failures: unknown[] = [];
  let sequence = 0;
  const server = createServer(async (request, response) => {
    try {
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = raw ? JSON.parse(raw) as { messages?: unknown; stream?: boolean } : {};
      if (request.url?.includes("/count_tokens")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"input_tokens":10}');
      } else if (request.url?.includes("/messages")) {
        requests.push(body);
        const context = JSON.stringify(body.messages ?? []);
        const index = prompts.findLastIndex(prompt => context.includes(prompt));
        reply(response, index < 0 ? "local fixture auxiliary reply" : replies[index]!, !!body.stream, ++sequence);
      } else {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }
    } catch (error) {
      failures.push(error);
      response.writeHead(500);
      response.end();
    }
  });
  const hosts: SessionHost[] = [];
  t.after(async () => {
    try { for (const host of hosts) await host.shutdown(); }
    finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const bundledJs = join(dirname(fileURLToPath(import.meta.resolve("@anthropic-ai/claude-agent-sdk"))), "cli.js");
  const executable = existsSync(bundledJs) ? bundledJs
    : fileURLToPath(import.meta.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`));
  assert.ok(existsSync(executable), "exercise the installed SDK's bundled CLI, not a fixture executable");
  // Clear inherited auth, cloud-provider routing, proxy and Node hooks as well as isolating HOME.
  // Undefined overrides also remove these variables in the real worker's spawn environment.
  const env: NodeJS.ProcessEnv = {
    ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])),
    PATH: process.env.PATH, HOME: home, USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
    CLAUDE_CONFIG_DIR: config, CLAUDE_SECURESTORAGE_CONFIG_DIR: config,
    FLOW_CLAUDE_PATH: executable,
    ANTHROPIC_API_KEY: "sk-ant-api03-local-legacy-fixture-only",
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  };
  const credential = '{"fixture":"must never enter durable backend state"}';
  writeFileSync(join(config, ".credentials.json"), credential);
  const store = new TranscriptStore(join(root, "flow"));
  async function host(backend: AgentBackend) {
    const result = new SessionHost({ store });
    hosts.push(result);
    result.registerBackend(backend);
    await result.load();
    return result;
  }
  async function turn(host: SessionHost, id: string, index: number) {
    const start = host.logFor(id).lastSeq;
    await host.send(id, prompts[index]!, "now");
    await until(() => host.logFor(id).since(start).some(({ event }) => event.type === "turn_ended"), 15_000);
    const events = host.logFor(id).since(start).map(({ event }) => event);
    assert.ok(events.some(event => event.type === "turn_ended" && event.reason === "complete"), JSON.stringify(events));
    assert.ok(events.some(event => event.type === "message" && event.final && event.text === replies[index]), JSON.stringify(events));
    assert.equal(host.statusOf(id), "idle");
    assert.deepEqual(failures, []);
    const inference = requests.findLast(body => JSON.stringify(body.messages).includes(prompts[index]!));
    assert.ok(inference, "the real CLI must send the user message to local inference");
    const context = JSON.stringify(inference.messages);
    for (let prior = 0; prior < index; prior++) {
      assert.ok(context.includes(prompts[prior]!), "prior user context must reach inference, not just the Presentation Transcript");
      assert.ok(context.includes(replies[prior]!), "prior assistant context must reach inference");
    }
  }

  // Reproduce the old adapter's storage behavior only on this first Host. The query injection
  // merely routes the real SDK to the isolated environment/executable; it fabricates no messages.
  const legacy = new ClaudeBackend({ query: ((args: Parameters<typeof query>[0]) => query({ ...args,
    options: { ...args.options, env, pathToClaudeCodeExecutable: executable },
  })) as typeof query, allowedTools: [] });
  const first = await host({ name: legacy.name, create: ({ stateDir: _legacyIgnored, ...options }) => legacy.create(options) });
  const id = await first.create({ scope, backend: "claude", modelId: "claude-sonnet-4-6" });
  await turn(first, id, 0);
  await first.shutdown();
  const resume = store.readMeta(id)?.resumeToken;
  assert.match(resume ?? "", /^[0-9a-f-]{36}$/);
  const stateDir = store.backendDir(id), projects = join(stateDir, "claude-projects");
  assert.equal(existsSync(projects), false, "the old adapter stored no per-Agent Session Claude projects");
  const projectKey = scope.replace(/[^a-zA-Z0-9]/g, "-");
  const globalProjects = join(config, "projects"), globalScope = join(globalProjects, projectKey);
  const legacyFile = join(globalScope, `${resume}.jsonl`);
  const legacyBytes = readFileSync(legacyFile, "utf8");
  assert.ok(legacyBytes.includes(prompts[0]!));
  const unrelatedId = randomUUID();
  writeFileSync(join(globalScope, `${unrelatedId}.jsonl`), "unrelated same-Scope transcript");
  mkdirSync(join(globalProjects, "other-scope"));
  writeFileSync(join(globalProjects, "other-scope", `${resume}.jsonl`), "same UUID in unrelated Scope");
  const legacyCompanion = join(globalScope, resume!);
  mkdirSync(join(legacyCompanion, "subagents"), { recursive: true });
  writeFileSync(join(legacyCompanion, "subagents", "agent-fixture.jsonl"), "selected session companion record");
  mkdirSync(join(globalScope, unrelatedId));
  writeFileSync(join(globalScope, unrelatedId, "private.txt"), "unrelated companion");
  mkdirSync(join(globalScope, "memory"), { recursive: true });
  writeFileSync(join(globalScope, "memory", "unrelated-global-memory.md"), "global project memory must not migrate");

  const worker = () => new WorkerBackend({ backend: "claude", env, isolationEnabled: () => false });
  const beforeLoad = requests.length;
  const second = await host(worker());
  assert.equal(second.statusOf(id), "dormant");
  assert.equal(requests.length, beforeLoad, "loading a Dormant Agent Session spends no inference");
  assert.equal(existsSync(projects), false, "load alone must not import Claude state");
  assert.ok(second.logFor(id).since(0).some(({ event }) => event.type === "message" && event.final && event.text === replies[0]));
  await turn(second, id, 1); // Implicit Revive must migrate BEFORE SDK initialization/model discovery.
  assert.equal(store.readMeta(id)?.resumeToken, resume, "Revive must continue the same Backend conversation ID");
  const ownedFile = join(projects, projectKey, `${resume}.jsonl`);
  assert.ok(readFileSync(ownedFile, "utf8").includes(prompts[1]!));
  assert.equal(readFileSync(legacyFile, "utf8"), legacyBytes, "leave global state untouched and stale");
  assert.equal(readFileSync(join(projects, projectKey, resume!, "subagents", "agent-fixture.jsonl"), "utf8"), "selected session companion record");
  assert.deepEqual(readdirSync(projects), [projectKey], "import only the selected Scope");
  // Recent CLIs also create an empty project memory directory on launch; it is not migration.
  assert.deepEqual(readdirSync(join(projects, projectKey)).filter(name => name !== "memory").sort(), [resume!, `${resume}.jsonl`].sort(), "import only the selected UUID and its companions");
  assert.equal(existsSync(join(projects, projectKey, "memory", "unrelated-global-memory.md")), false, "do not import project-wide memory");
  assert.deepEqual(readdirSync(stateDir), ["claude-projects"], "never persist a config or credential copy");
  assert.ok(!files(stateDir).some(file => file.includes(unrelatedId) || file.includes("credentials")));
  await second.shutdown();
  const ownedBytes = readFileSync(ownedFile, "utf8");

  const third = await host(worker());
  assert.equal(third.statusOf(id), "dormant");
  await turn(third, id, 2);
  assert.equal(store.readMeta(id)?.resumeToken, resume);
  assert.ok(readFileSync(ownedFile, "utf8").startsWith(ownedBytes), "a later Revive must not overwrite the authoritative owned copy with stale global state");
  await third.shutdown();
  assert.equal(readFileSync(legacyFile, "utf8"), legacyBytes);
  assert.equal(readFileSync(join(config, ".credentials.json"), "utf8"), credential);
  assert.equal(readFileSync(join(globalScope, `${unrelatedId}.jsonl`), "utf8"), "unrelated same-Scope transcript");
  assert.equal(readFileSync(join(globalProjects, "other-scope", `${resume}.jsonl`), "utf8"), "same UUID in unrelated Scope");
  const events = store.readEntries(id).map(({ event }) => event);
  assert.equal(events.filter(event => event.type === "session_started").length, 1);
  assert.equal(events.filter(event => event.type === "revived").length, 2);
  assert.equal(events.filter(event => event.type === "turn_ended" && event.reason === "complete").length, 3);
  for (const text of replies) assert.ok(events.some(event => event.type === "message" && event.final && event.text === text));
  assert.ok(!files(stateDir).some(file => file.includes("credentials")));
});
