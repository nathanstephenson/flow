import assert from "node:assert/strict";
import { join } from "node:path";
import { it, type TestContext } from "node:test";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve } from "../src/daemon/server.ts";
import { ShellRegistry } from "../src/daemon/shell.ts";
import { createSandbox, sandboxMounts, type Sandbox } from "../src/isolation/sandbox.ts";
import type { FilesystemIsolationMode } from "../src/protocol/settings.ts";
import { fakeProvider } from "./backend/sandbox-fixture.ts";

async function open(t: TestContext, mode: FilesystemIsolationMode, sandbox?: Sandbox) {
  const spawns: { file: string; args: string[]; cwd: string }[] = [];
  const exits: (() => void)[] = [];
  const shells = new ShellRegistry({ loadPty: async () => ({ spawn: (file, args, { cwd }) => {
    spawns.push({ file, args, cwd });
    let exit!: (event: { exitCode: number }) => void;
    exits.push(() => exit({ exitCode: 0 }));
    return { onData() {}, onExit(listener) { exit = listener; }, write() {}, resize() {}, kill() {} };
  } }) });
  const host = new SessionHost({ filesystemIsolationMode: () => mode });
  host.registerBackend(new FakeBackend());
  const scope = process.cwd();
  const sessionId = await host.create({ scope, backend: "fake" });
  if (sandbox) t.mock.method(host, "workflowSandbox", async () => sandbox);
  const running = await serve({ host, token: "secret", assets: {}, shells });
  t.after(async () => { await host.shutdown(); await running.close(); });
  const response = await fetch(`${running.url}/api/shells`, { method: "POST", headers: { authorization: "Bearer secret" }, body: JSON.stringify({ sessionId }) });
  return { response, spawns, exits, scope };
}

async function sandboxFor(t: TestContext, shell?: string[]) {
  const f = fakeProvider(t);
  const sandbox = await createSandbox({ ...f.support.provider, ...(shell ? { shell } : {}) },
    { name: "flow-test", workspace: f.scope, mounts: sandboxMounts([f.scope, f.state], []), env: {} }, join(f.state, "sandbox.json"));
  return { sandbox, calls: f.calls };
}

it("opens a sandbox Shell in the session VM and holds the VM while it runs", async (t) => {
  const { sandbox, calls } = await sandboxFor(t, ["sbx", "exec", "-it", "-w", "{cwd}", "{name}"]);
  const { response, spawns, exits, scope } = await open(t, "sandbox", sandbox);
  assert.equal(response.status, 200);
  assert.deepEqual(spawns, [{ file: "sbx", args: ["exec", "-it", "-w", scope, "flow-test", "/bin/bash", "-l"], cwd: scope }]);
  const closing = sandbox.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls().some((call) => call.startsWith("remove")), false);
  exits[0]!();
  await closing;
  assert.equal(calls().at(-1), "remove flow-test");
});

it("refuses a sandbox Shell when the provider has no shell template", async (t) => {
  const { sandbox } = await sandboxFor(t);
  const { response, spawns } = await open(t, "sandbox", sandbox);
  assert.equal(response.status, 503);
  assert.match((await response.json() as { error: string }).error, /Add a `shell` template to the sandbox provider file/);
  assert.deepEqual(spawns, []);
  await sandbox.close();
});

for (const mode of ["bubblewrap", "none"] as const) {
  it(`opens a ${mode} Shell on the host`, async (t) => {
    const previous = process.env["SHELL"];
    process.env["SHELL"] = "/bin/test-shell";
    t.after(() => { if (previous === undefined) delete process.env["SHELL"]; else process.env["SHELL"] = previous; });
    const { response, spawns, scope } = await open(t, mode);
    assert.equal(response.status, 200);
    assert.deepEqual(spawns, [{ file: "/bin/test-shell", args: [], cwd: scope }]);
  });
}
