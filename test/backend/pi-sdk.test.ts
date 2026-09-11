import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";

import { PiBackend } from "../../src/backend/pi/index.ts";

it("boots the installed pi SDK and selects an authenticated model without inference", async () => {
  const root = mkdtempSync(join(tmpdir(), "flow-pi-sdk-"));
  const scope = join(root, "scope");
  const agentDir = join(root, "agent");
  mkdirSync(scope);
  mkdirSync(agentDir);
  const oldAgentDir = process.env["PI_CODING_AGENT_DIR"];
  const oldOffline = process.env["PI_OFFLINE"];
  process.env["PI_CODING_AGENT_DIR"] = agentDir;
  process.env["PI_OFFLINE"] = "1";
  // An unreachable local endpoint and dummy key: catalogue/session creation must not run inference.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {
    "flow-sdk-test": {
      baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "not-a-real-key",
      models: [{ id: "test-model", name: "SDK test model", reasoning: false, input: ["text"],
        contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    },
  } }));
  const selected: string[] = [];
  const backend = new PiBackend({ tools: [] });
  let session;
  try {
    session = await backend.create({
      scope, stateDir: join(root, "sessions"), modelId: "flow-sdk-test/test-model", tools: "none",
      emit: (event) => { if (event.type === "model_changed") selected.push(event.model.id); },
    });
    assert.ok(session.capabilities.models.some((model) => model.id === "flow-sdk-test/test-model"));
    assert.equal(selected.at(-1), "flow-sdk-test/test-model");
    await session.setModel("flow-sdk-test/test-model");
    assert.equal(selected.at(-1), "flow-sdk-test/test-model");
  } finally {
    await session?.dispose();
    if (oldAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = oldAgentDir;
    if (oldOffline === undefined) delete process.env["PI_OFFLINE"];
    else process.env["PI_OFFLINE"] = oldOffline;
    rmSync(root, { recursive: true, force: true });
  }
});
