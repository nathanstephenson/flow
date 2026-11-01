import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import type { SandboxSpec, SandboxSupport } from "../../src/isolation/sandbox.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

const backendModule = new URL("./worker-fixture.ts", import.meta.url).href;

function fakeProvider(t: TestContext, createScript = 'cp "$1" "$LOG/spec.json"; echo create >> "$LOG/calls"') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flow-sandbox-worker-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = join(root, "scope"), state = join(root, "state", "sessions", "s1", "backend"), log = join(root, "log");
  for (const dir of [scope, state, log]) mkdirSync(dir, { recursive: true });
  const script = (name: string, body: string) => {
    const path = join(root, name);
    writeFileSync(path, `#!/bin/sh\nLOG=${JSON.stringify(log)}\n${body}\n`);
    chmodSync(path, 0o755);
    return path;
  };
  const support: SandboxSupport = {
    supported: true, path: join(root, "provider.json"),
    provider: {
      version: 1,
      probe: [script("probe", "true")],
      create: [script("create", createScript), "{spec}"],
      exec: [script("exec", 'echo "exec $1 $2" >> "$LOG/calls"; cd "$2" || exit 1; shift 3; exec "$@"'), "{name}", "{cwd}", "--"],
      remove: [script("remove", 'echo "remove $1" >> "$LOG/calls"'), "{name}"],
    },
    probe: { nodePath: process.execPath, claudePath: "/bin/false" },
  };
  return { support, scope, state, stateRoot: join(root, "state"),
    calls: () => readFileSync(join(log, "calls"), "utf8").trim().split("\n"),
    spec: () => JSON.parse(readFileSync(join(log, "spec.json"), "utf8")) as SandboxSpec };
}

test("a sandbox-mode Backend Session runs its worker through the provider and removes the VM on dispose", async (t) => {
  const f = fakeProvider(t);
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: (event) => events.push(event) });
  await session.prompt("permission-mode");
  assert.ok(events.some((event) => event.type === "message" && event.id === "permission-mode"));
  const spec = f.spec();
  assert.match(spec.name, /^flow-[0-9a-f]{16}$/);
  assert.deepEqual(spec.mounts.filter((mount) => !mount.readOnly).map((mount) => mount.path).sort(), [f.scope, f.state].sort());
  assert.ok(spec.mounts.every((mount) => Number.isInteger(mount.dev) && Number.isInteger(mount.ino)));
  await session.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(f.calls(), [`remove ${spec.name}`, "create", `exec ${spec.name} ${f.scope}`, `remove ${spec.name}`]);
});

test("a failed create removes partial state and never launches the worker", async (t) => {
  const f = fakeProvider(t, 'echo create >> "$LOG/calls"; echo "no KVM" >&2; exit 1');
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  await assert.rejects(backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} }), /no KVM/);
  assert.equal(f.calls().filter((call) => call.startsWith("exec")).length, 0);
  assert.equal(f.calls().at(-1)?.startsWith("remove"), true);
});

test("sandbox mode without a working provider refuses to launch", async (t) => {
  const f = fakeProvider(t);
  for (const support of [undefined, { supported: false as const, reason: "probe failed: no KVM" }]) {
    const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => support });
    await assert.rejects(backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} }), /unrestricted launch refused/);
  }
});
