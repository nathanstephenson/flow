import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test, { before } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { fakeHostClaude, fakeProvider } from "./sandbox-fixture.ts";
import { summariseToName } from "../../src/daemon/summariser.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import type { SandboxSupport } from "../../src/isolation/sandbox.ts";

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

test("a mounted read-only Scope is a read-only sandbox mount and the state folder is the workspace", async (t) => {
  const f = fakeProvider(t);
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, readOnly: "mounted", emit: (event) => events.push(event) });
  await session.prompt("read-only");
  const event = events.findLast((event) => event.type === "message" && event.id === "read-only");
  assert.ok(event?.type === "message");
  assert.equal(JSON.parse(event.text).readOnly, "mounted");
  const spec = f.spec();
  assert.equal(spec.workspace, realpathSync(f.state));
  assert.deepEqual(spec.additionalWorkspaces.filter((mount) => mount.path === f.scope), [{ path: f.scope, readOnly: true }]);
  assert.ok(!spec.additionalWorkspaces.some((mount) => !mount.readOnly && mount.path === f.scope));
  await session.dispose();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.deepEqual(f.calls(), ["create", `exec ${spec.name} ${f.scope}`, `remove ${spec.name}`]);
});

test("a tool-less Backend Session mounts its Scope read-only in its sandbox", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, tools: "none", emit: () => {} });
  t.after(() => session.dispose());
  const spec = f.spec();
  assert.notEqual(spec.workspace, f.scope);
  assert.deepEqual(spec.additionalWorkspaces.filter((mount) => mount.path === f.scope), [{ path: f.scope, readOnly: true }]);
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
  const events: BackendEvent[] = [];
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: (event) => events.push(event) });
  t.after(() => session.dispose());
  const lines = readFileSync(join(f.stateRoot, "timings.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 1);
  const { at, ...start } = JSON.parse(lines[0]!);
  assert.equal(typeof at, "string");
  const number = (value: unknown) => typeof value === "number" ? 0 : value;
  assert.deepEqual(JSON.parse(JSON.stringify(start, (_, value) => number(value))), { kind: "start", backend: "pi", isolation: "sandbox", sharing: "own",
    prepare: 0, remove: 0, create: 0, open: 0, worker: { ready: 0, import: 0, create: 0 } });
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

test("a failed remove of a crashed VM before create does not block the session", async (t) => {
  const f = fakeProvider(t, undefined, 'echo "remove $1" >> "$LOG/calls"; echo "sandbox not found" >&2; exit 1');
  writeFileSync(join(f.state, "sandbox.json"), "{}");
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} });
  await session.dispose();
  assert.deepEqual(f.calls().slice(0, 2), [`remove ${f.spec().name}`, "create"]);
});

test("a sandbox probe without a state directory runs in a disposable VM and removes its temporary state", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, tools: "none", emit: () => {} });
  const temp = f.spec().workspace;
  assert.notEqual(temp, f.scope);
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

function hostSupport(support: SandboxSupport, hostClaudePath: string): SandboxSupport {
  if (!support.supported) return support;
  const { claudePath: _, ...provider } = support.provider;
  return { ...support, provider: { ...provider, hostClaudePath } };
}

test("a Claude sandbox session runs the host-installed Claude from its read-only versions directory", async (t) => {
  const f = fakeProvider(t);
  const host = join(f.stateRoot, "..", "host-claude");
  let install = fakeHostClaude(host, "2.1.0");
  const backend = new WorkerBackend({ backend: "claude", backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const,
    sandbox: () => hostSupport(f.support, install.link) });
  const start = async () => {
    const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} });
    await session.dispose();
    assert.ok(f.spec().additionalWorkspaces.some((mount) => mount.path === install.versions && mount.readOnly));
    assert.ok(!f.spec().additionalWorkspaces.some((mount) => mount.path === dirname(install.link)));
    assert.ok(f.argv().includes(`FLOW_CLAUDE_PATH=${install.executable}`));
    assert.ok(f.argv().includes("DISABLE_AUTOUPDATER=1"));
  };
  await start();
  install = fakeHostClaude(host, "2.2.0");
  await start();
});

test("a Claude sandbox session refuses an incompatible host Claude before it creates a VM", async (t) => {
  const f = fakeProvider(t);
  const install = fakeHostClaude(join(f.stateRoot, "..", "host-claude"), "2.1.0", 3);
  const backend = new WorkerBackend({ backend: "claude", backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const,
    sandbox: () => hostSupport(f.support, install.link) });
  await assert.rejects(backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} }),
    /Sandbox isolation is unavailable; unrestricted launch refused: host Claude .* is not a 64-bit/);
  assert.equal(existsSync(join(f.stateRoot, "..", "log", "calls")), false);
});

test("a Claude sandbox session with a guest Claude passes the guest path unchanged", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backend: "claude", backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} });
  await session.dispose();
  assert.ok(f.argv().includes("FLOW_CLAUDE_PATH=/bin/false"));
  assert.ok(!f.argv().includes("DISABLE_AUTOUPDATER=1"));
});

test("a Claude sandbox session without a Claude path leaves the SDK's own Claude in place", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backend: "claude", backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const,
    sandbox: () => { if (!f.support.supported) return f.support; const { claudePath: _, ...provider } = f.support.provider; return { ...f.support, provider }; } });
  const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {} });
  await session.dispose();
  assert.ok(!f.argv().some((part) => part.startsWith("FLOW_CLAUDE_PATH=")));
});

test("a Claude sandbox session shares nothing inside its writable state folder read-only", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backend: "claude", backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const,
    sandbox: () => f.support });
  const session = await backend.create({ scope: f.scope, emit: () => {} });
  t.after(() => session.dispose());
  const state = f.spec().additionalWorkspaces.find((mount) => !mount.readOnly)!.path;
  assert.deepEqual(f.spec().additionalWorkspaces.filter((mount) => mount.readOnly && mount.path.startsWith(`${state}/`)), []);
});

test("a Summary Model naming session starts in an own sandbox", async (t) => {
  const f = fakeProvider(t);
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support });
  const errors: unknown[] = [];
  const create = backend.create.bind(backend);
  backend.create = (options) => create(options).catch((error: unknown) => { errors.push(error); throw error; });
  await summariseToName({ backend, modelId: "fixture-model", text: "hello", timeoutMs: 10_000 });
  assert.deepEqual(errors.map(String), []);
  assert.equal(f.calls()[0], "create");
});
