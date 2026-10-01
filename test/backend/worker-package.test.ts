import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { piFixture } from "./pi-fixture.ts";
import { isolationIntegration, privateWorkerState } from "../isolation-fixture.ts";

const distEntry = fileURLToPath(new URL("../../dist/backend/worker/entry.js", import.meta.url));
const binary = fileURLToPath(new URL("../../build/flow", import.meta.url));
const backendModule = new URL("./worker-fixture.ts", import.meta.url).href;

for (const packaging of ["npm", "SEA"] as const) {
  test(`${packaging} worker entry uses IPC without initializing host state`, { skip: isolationIntegration.skip || !existsSync(packaging === "npm" ? distEntry : binary) }, async (t) => {
    const { root, scope } = privateWorkerState(t);
    const backend = new WorkerBackend({
      backendModule,
      env: { FLOW_STATE_DIR: join(root, "host-must-not-start") },
      ...(packaging === "npm" ? { entry: distEntry } : { command: binary, args: ["--flow-backend-worker"] }),
    });
    const events: BackendEvent[] = [];
    const session = await backend.create({ scope, emit: (event) => events.push(event) });
    try {
      assert.equal(session.resumeToken(), "initial-token");
      await session.prompt("hello");
      assert.equal(events.at(-1)?.type, "turn_ended");
      assert.equal(existsSync(join(root, "host-must-not-start")), false);
    } finally { await session.dispose(); }
  });
}

for (const packaging of ["npm", "SEA"] as const) {
test(`${packaging} worker entry loads installed Pi SDK`, { skip: isolationIntegration.skip || !existsSync(packaging === "npm" ? distEntry : binary) }, async (t) => {
  const f = await piFixture(t, () => ({ text: "packaged Pi response" }));
  const { scope, stateDir } = privateWorkerState(t);
  const events: BackendEvent[] = [];
  const session = await new WorkerBackend({
    ...(packaging === "npm" ? { entry: distEntry } : { command: binary, args: ["--flow-backend-worker"] }),
    env: { PI_CODING_AGENT_DIR: f.scope, PI_OFFLINE: "1" },
  }).create({
    scope, stateDir, modelId: "flow-test/parent", emit: (event) => events.push(event),
  });
  try {
    await session.prompt("hello");
    assert.ok(events.some((event) => event.type === "message" && event.text === "packaged Pi response"));
  } finally { await session.dispose(); }
});
}
