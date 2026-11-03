import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test, { before } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { fakeProvider } from "./sandbox-fixture.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

const backendModule = new URL("./worker-fixture.ts", import.meta.url).href;

before(() => { execFileSync(process.execPath, ["scripts/build-worker.mjs"]); });

test("a sandbox-mode Backend Session runs its worker through the provider and removes the VM on dispose", async (t) => {
  const f = fakeProvider(t);
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: (event) => events.push(event) });
  await session.prompt("permission-mode");
  assert.ok(events.some((event) => event.type === "message" && event.id === "permission-mode"));
  const spec = f.spec();
  assert.equal(spec.schemaVersion, "1");
  assert.match(spec.name, /^flow-[0-9a-f]{16}$/);
  assert.equal(spec.workspace, f.scope);
  assert.deepEqual(spec.additionalWorkspaces.filter((mount) => !mount.readOnly).map((mount) => mount.path), [f.state]);
  assert.ok(spec.additionalWorkspaces.some((mount) => mount.readOnly));
  await session.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(f.calls(), ["create", `exec ${spec.name} ${f.scope}`, `remove ${spec.name}`]);
});

test("a Revive after a clean close skips the pre-create remove; a spec left by a crash does not", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  await (await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} })).dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  await (await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} })).dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const name = f.spec().name, run = ["create", `exec ${name} ${f.scope}`, `remove ${name}`];
  assert.deepEqual(f.calls(), [...run, ...run]);
  writeFileSync(join(f.state, "sandbox.json"), "{}");
  await (await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} })).dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(f.calls().slice(6), [`remove ${name}`, ...run]);
});

test("a sandbox start writes one timing line and runs the bundled worker", async (t) => {
  const f = fakeProvider(t);
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => { lines.push(line); });
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: (event) => events.push(event) });
  t.after(() => session.dispose());
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /^Sandbox flow-[0-9a-f]{16} start: prepare \d+ms, remove \d+ms, create \d+ms, open \d+ms \(worker ready \d+ms, import \d+ms, backend \d+ms\)$/);
  await session.prompt("entry");
  const entry = events.find((event) => event.type === "message" && event.id === "entry");
  assert.equal(entry?.type === "message" && entry.text, resolve("build/backend-worker.mjs"));
});

test("sandbox mode refuses to launch without the worker bundle", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backendModule, entry: "/missing/backend-worker.mjs", stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  await assert.rejects(backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} }), /npm run build:worker/);
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

test("a failed remove before create (no VM yet) does not block the session", async (t) => {
  const f = fakeProvider(t, undefined, 'echo "remove $1" >> "$LOG/calls"; echo "sandbox not found" >&2; exit 1');
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} });
  await session.dispose();
  assert.ok(f.calls().includes("create"));
});

test("a sandbox probe without a state directory runs in a disposable VM and removes its temporary state", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, tools: "none", emit: () => {} });
  const temp = f.spec().additionalWorkspaces.find((mount) => !mount.readOnly)!.path;
  assert.equal(existsSync(temp), true);
  await session.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(f.calls().at(-1), `remove ${f.spec().name}`);
  assert.equal(existsSync(temp), false);
});

test("a Claude sandbox session mounts the provider's Claude sign-in folder writable", async (t) => {
  const f = fakeProvider(t);
  const auth = join(f.stateRoot, "..", "claude-auth");
  mkdirSync(auth);
  const backend = new WorkerBackend({ backend: "claude", backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const,
    sandbox: () => f.support.supported ? { ...f.support, provider: { ...f.support.provider, claudeAuthDir: auth } } : f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} });
  t.after(() => session.dispose());
  assert.ok(f.spec().additionalWorkspaces.some((mount) => mount.path === realpathSync(auth) && !mount.readOnly));
});
