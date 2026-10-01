import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/daemon/config-store.ts";

it("per-backend defaults round-trip and reject unsupported Pi Auto without changing Settings", () => {
  const root = mkdtempSync(join(tmpdir(), "flow-permission-config-"));
  try {
    const config = new ConfigStore(root);
    config.update({ providers: { permissionModes: { claude: "auto", pi: "ask" } } });
    assert.deepEqual(new ConfigStore(root).view().providers?.permissionModes, { claude: "auto", pi: "ask" });
    assert.throws(() => config.update({ providers: { permissionModes: { pi: "auto" } } }), /Unsupported permission mode/);
    assert.equal(config.defaultPermissionMode("pi"), "ask");
    config.update({ providers: { permissionModes: { pi: "" } } });
    assert.equal(config.defaultPermissionMode("pi"), undefined);
    writeFileSync(join(root, "config.json"), JSON.stringify({ providers: { permissionModes: { claude: "bad", pi: "always" } } }));
    const loaded = new ConfigStore(root);
    assert.equal(loaded.defaultPermissionMode("pi"), "always");
    assert.equal(loaded.defaultPermissionMode("claude"), undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
