import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

const probe = process.platform === "linux" ? spawnSync(process.env.FLOW_BWRAP_PATH ?? "/usr/bin/bwrap",
  ["--unshare-user", "--unshare-pid", "--ro-bind", "/", "/", "--", "/bin/true"], { timeout: 5000, encoding: "utf8" }) : undefined;
export const isolationIntegration = { skip: probe?.status !== 0 ? "requires working Linux Bubblewrap namespaces" : false };

/** Keep writable Scope, durable backend data and source SDK credentials in separate directories. */
export function privateWorkerState(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "flow-restricted-worker-"));
  const scope = join(root, "project");
  const stateDir = join(root, "backend");
  mkdirSync(scope); mkdirSync(stateDir);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, scope, stateDir };
}
