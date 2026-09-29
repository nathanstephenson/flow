import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

export type NativeAutoResult = {
  messages: SDKMessage[];
  classifierRequests: number;
  permissionCallbacks: Array<{ tool: string; input: Record<string, unknown>; toolUseID: string; agentID?: string }>;
  switchedToDefault: boolean;
};

type Scenario = "allow" | "deny" | "subagent";

let messageSequence = 0;

function event(response: ServerResponse, name: string, data: unknown): void {
  response.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamMessage(response: ServerResponse, block: { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }, stopReason: "end_turn" | "tool_use"): void {
  const id = `fixture-message-${++messageSequence}`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  event(response, "message_start", { type: "message_start", message: {
    id, type: "message", role: "assistant", model: "claude-sonnet-4-6", content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 },
  } });
  if (block.type === "text") {
    event(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: block.text } });
  } else {
    event(response, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } });
    event(response, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
  }
  event(response, "content_block_stop", { type: "content_block_stop", index: 0 });
  event(response, "message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: {
    input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  } });
  event(response, "message_stop", { type: "message_stop" });
  response.end();
}

function classifierMessage(response: ServerResponse, text: string): void {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({
    id: `fixture-classifier-${++messageSequence}`, type: "message", role: "assistant", model: "claude-sonnet-4-6",
    content: [{ type: "text", text }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  }));
}

function bodyText(body: { messages?: unknown }): string {
  return JSON.stringify(body.messages ?? []);
}

/** Exercise the installed SDK and its bundled CLI against a deterministic local Anthropic endpoint. */
export async function runNativeAutoScenario(scenario: Scenario): Promise<NativeAutoResult> {
  const root = mkdtempSync(join(tmpdir(), `flow-native-auto-${scenario}-`));
  let classifierRequests = 0;
  let switchedToDefault = false;
  let sdkQuery: ReturnType<typeof query> | undefined;
  const permissionCallbacks: NativeAutoResult["permissionCallbacks"] = [];

  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = raw ? JSON.parse(raw) as { system?: unknown; messages?: unknown; tools?: Array<{ name: string }> } : {};
    if (!request.url?.includes("/messages")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }

    const transcript = bodyText(body);
    const classifier = JSON.stringify(body.system ?? []).includes("security monitor for autonomous AI coding agents");
    if (classifier) {
      classifierRequests++;
      if (scenario !== "deny") {
        classifierMessage(response, "<block>no</block>");
      } else if (transcript.includes("Use <thinking>")) {
        classifierMessage(response, "<thinking>fixture</thinking><block>yes</block><category>Irreversible Local Destruction</category><reason>[Irreversible Local Destruction] fixture denial</reason>");
      } else {
        classifierMessage(response, "<block>yes</block>");
      }
      return;
    }

    const hasToolResult = transcript.includes("tool_result");
    if (scenario === "subagent") {
      if (transcript.includes("native child marker") && !hasToolResult) {
        await sdkQuery?.setPermissionMode("default");
        switchedToDefault = true;
        streamMessage(response, { type: "tool_use", id: "sub-tool-1", name: "Bash", input: { command: "git push" } }, "tool_use");
      } else if (!hasToolResult) {
        streamMessage(response, { type: "tool_use", id: "agent-call-1", name: "Agent", input: {
          description: "native permission probe", prompt: "native child marker: run git push",
          subagent_type: "general-purpose", run_in_background: false,
        } }, "tool_use");
      } else {
        streamMessage(response, { type: "text", text: "done" }, "end_turn");
      }
      return;
    }

    if (!hasToolResult) {
      const command = scenario === "allow" ? "node -e \"console.log(42)\"" : "git reset --hard";
      streamMessage(response, { type: "tool_use", id: `${scenario}-tool-1`, name: "Bash", input: { command } }, "tool_use");
    } else {
      streamMessage(response, { type: "text", text: "done" }, "end_turn");
    }
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  async function* prompts() {
    await promptGate;
    yield { type: "user" as const, message: { role: "user" as const, content: scenario === "subagent" ? "spawn ordinary worker" : `run ${scenario}` }, parent_tool_use_id: null, session_id: "" };
  }

  sdkQuery = query({ prompt: prompts(), options: {
    cwd: root, model: "claude-sonnet-4-6", tools: scenario === "subagent" ? ["Bash", "Agent"] : ["Bash"],
    allowedTools: [], env: {
      ...process.env, ANTHROPIC_API_KEY: "sk-ant-api03-native-auto-fixture",
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CONFIG_DIR: join(root, ".claude"), CLAUDE_CODE_ENABLE_AUTO_MODE: "1",
      DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    },
    canUseTool: async (tool, input, extra) => {
      permissionCallbacks.push({ tool, input, toolUseID: extra.toolUseID, ...(extra.agentID ? { agentID: extra.agentID } : {}) });
      return { behavior: "deny", message: "fixture human denied" };
    },
  } });

  const messages: SDKMessage[] = [];
  try {
    await sdkQuery.setPermissionMode("auto");
    releasePrompt();
    for await (const message of sdkQuery) messages.push(message);
  } finally {
    sdkQuery.close();
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
  return { messages, classifierRequests, permissionCallbacks, switchedToDefault };
}
