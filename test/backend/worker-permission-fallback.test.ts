import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { AutoPermissionUnavailable } from "../../src/backend/permission-errors.ts";
import { SessionHost } from "../../src/daemon/host.ts";
import { reduceAll } from "../../src/client/reduce.ts";
import { isolationIntegration } from "../isolation-fixture.ts";

const backendModule = new URL("./worker-fixture.ts", import.meta.url).href;
for (const isolated of [false, true]) {
  test(`Claude worker preserves typed Auto rejection and host fallback (isolated=${isolated})`,
    isolated ? isolationIntegration : {}, async t => {
      const scope = mkdtempSync(join(tmpdir(), "flow-worker-permission-fallback-"));
      t.after(() => rmSync(scope, { recursive: true, force: true }));
      const backend = new WorkerBackend({ backend: "claude", backendModule, isolationEnabled: () => isolated });
      await assert.rejects(backend.create({ scope, permissionMode: "auto", modelId: "auto-unavailable", emit: () => {} }),
        error => error instanceof AutoPermissionUnavailable && error.message === "fixture Auto unsupported");
      // Ordinary startup errors must never be reclassified as a permission-policy fallback.
      await assert.rejects(backend.create({ scope, permissionMode: "auto", modelId: "create-error", emit: () => {} }),
        error => error instanceof Error && !(error instanceof AutoPermissionUnavailable));
      const host = new SessionHost();
      host.registerBackend(backend);
      t.after(() => host.shutdown());
      const id = await host.create({ scope, backend: "claude", permissionMode: "auto", modelId: "auto-unavailable" });
      assert.equal(host.list()[0]?.permissionMode, "ask");
      assert.equal(reduceAll(host.logFor(id).since(0)).permissionMode, "ask");
      assert.ok(host.logFor(id).since(0).some(({ event }) => event.type === "notice" && event.text.includes("Auto")));
      await host.setPermissionMode(id, "always");
      assert.equal(host.list()[0]?.permissionMode, "always");
      await host.setPermissionMode(id, "auto"); // fixture rejects Auto; the host confirms Ask through IPC.
      assert.equal(host.list()[0]?.permissionMode, "ask");
      await host.shutdown();
    });
}
