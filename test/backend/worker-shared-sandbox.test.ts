import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test, { before } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import { SharedSandbox, workflowBuilderFolder } from "../../src/isolation/shared-sandbox.ts";
import { fakeProvider } from "./sandbox-fixture.ts";
import { summariseToName } from "../../src/daemon/summariser.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

const backendModule = new URL("./worker-fixture.ts", import.meta.url).href;
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

before(() => { execFileSync(process.execPath, ["scripts/build-worker.mjs"]); });

function shared(t: import("node:test").TestContext) {
  const f = fakeProvider(t);
  let projectRoot: string | undefined = f.scope;
  const vm = new SharedSandbox(f.stateRoot, () => projectRoot);
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot, isolationMode: () => "sandbox" as const, sandbox: () => f.support, sharedSandbox: () => vm });
  const stateDir = (id: string) => { const path = join(f.stateRoot, "sessions", id, "backend"); mkdirSync(path, { recursive: true }); return path; };
  const dir = (path: string) => { mkdirSync(path, { recursive: true }); return path; };
  return { f, vm, backend, stateDir, dir, setProjectRoot: (path: string | undefined) => { projectRoot = path; } };
}

test("two sessions under the Project Root share one VM, which is removed only when the host closes it", async (t) => {
  const { f, vm, backend, stateDir, dir } = shared(t);
  const other = dir(join(f.scope, "b"));
  const a = await backend.create({ scope: f.scope, stateDir: stateDir("s1"), emit: () => {} });
  const events: BackendEvent[] = [];
  const b = await backend.create({ scope: other, stateDir: stateDir("s2"), emit: (event) => events.push(event) });
  const name = f.spec().name;
  assert.match(name, /^flow-shared-[0-9a-f]{16}$/);
  assert.equal(a.sandbox, b.sandbox);
  const writable = f.spec().additionalWorkspaces.filter((mount) => !mount.readOnly).map((mount) => mount.path);
  for (const path of [join(f.stateRoot, "worktrees"), join(f.stateRoot, "sessions"), workflowBuilderFolder()]) assert.ok(writable.includes(path), path);
  assert.equal(f.spec().workspace, f.scope);
  await a.dispose();
  await settle();
  await b.prompt("permission-mode");
  assert.ok(events.some((event) => event.type === "message" && event.id === "permission-mode"));
  await b.dispose();
  await settle();
  assert.deepEqual(f.calls(), ["create", `exec ${name} ${f.scope}`, `exec ${name} ${other}`]);
  await vm.close();
  assert.deepEqual(f.calls().slice(3), [`remove ${name}`]);
});

test("a shared session outside the Project Root, or with no Project Root, is refused before any provider call", async (t) => {
  const { f, backend, stateDir, dir, setProjectRoot } = shared(t);
  const outside = dir(join(f.stateRoot, "..", "elsewhere"));
  await assert.rejects(backend.create({ scope: outside, stateDir: stateDir("s1"), emit: () => {} }), new RegExp(`not under the Project Root ${f.scope}`));
  setProjectRoot(undefined);
  await assert.rejects(backend.create({ scope: f.scope, stateDir: stateDir("s1"), emit: () => {} }), /needs a Project Root/);
  assert.throws(() => f.calls(), /ENOENT/);
});

test("a Worktree Scope and a builder Scope use the shared VM", async (t) => {
  const { f, vm, backend, stateDir, dir } = shared(t);
  const worktree = dir(join(f.stateRoot, "worktrees", "repo", "branch"));
  const builder = mkdtempSync(join(workflowBuilderFolder(), "test-"));
  t.after(() => rmSync(builder, { recursive: true, force: true }));
  const a = await backend.create({ scope: worktree, stateDir: stateDir("s1"), emit: () => {} });
  const b = await backend.create({ scope: builder, tools: "none", emit: () => {} });
  await Promise.all([a.dispose(), b.dispose()]);
  await vm.close();
  const name = f.spec().name;
  assert.deepEqual(f.calls(), ["create", `exec ${name} ${worktree}`, `exec ${name} ${builder}`, `remove ${name}`]);
});

test("a mount change re-creates an idle VM and is refused while a session holds it", async (t) => {
  const { f, vm, backend, stateDir, dir, setProjectRoot } = shared(t);
  const a = await backend.create({ scope: f.scope, stateDir: stateDir("s1"), emit: () => {} });
  const next = dir(join(f.stateRoot, "..", "next"));
  setProjectRoot(next);
  await assert.rejects(backend.create({ scope: next, stateDir: stateDir("s2"), emit: () => {} }), /in use/);
  await a.dispose();
  const b = await backend.create({ scope: next, stateDir: stateDir("s2"), emit: () => {} });
  await b.dispose();
  await vm.close();
  const name = f.spec().name;
  assert.equal(f.spec().workspace, next);
  assert.deepEqual(f.calls(), ["create", `exec ${name} ${f.scope}`, `remove ${name}`, "create", `exec ${name} ${next}`, `remove ${name}`]);
});

test("a shared spec left by a crash is removed before create", async (t) => {
  const { f, vm, backend, stateDir, dir } = shared(t);
  writeFileSync(join(dir(join(f.stateRoot, "sandbox")), "shared.json"), "{}");
  await (await backend.create({ scope: f.scope, stateDir: stateDir("s1"), emit: () => {} })).dispose();
  await vm.close();
  assert.deepEqual(f.calls().slice(0, 2), [`remove ${f.spec().name}`, "create"]);
});

test("a Summary Model naming session starts in the shared VM", async (t) => {
  const { f, vm, backend } = shared(t);
  const errors: unknown[] = [];
  const create = backend.create.bind(backend);
  backend.create = (options) => create(options).catch((error: unknown) => { errors.push(error); throw error; });
  await summariseToName({ backend, modelId: "fixture-model", text: "hello", timeoutMs: 10_000 });
  assert.deepEqual(errors.map(String), []);
  assert.equal(f.calls()[0], "create");
  await vm.close();
});
