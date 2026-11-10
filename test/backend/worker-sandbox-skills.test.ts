import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { before } from "node:test";
import { WorkerBackend } from "../../src/backend/worker/index.ts";
import type { BackendSession } from "../../src/backend/types.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";
import { SharedSandbox } from "../../src/isolation/shared-sandbox.ts";
import { fakeProvider } from "./sandbox-fixture.ts";

const backendModule = new URL("./pi-resources-worker-fixture.ts", import.meta.url).href;
before(() => { execFileSync(process.execPath, ["scripts/build-worker.mjs"]); });

for (const sharing of ["session", "shared"] as const) for (const linked of [false, true]) {
  test(`Pi ${sharing} sandbox discovers ${linked ? "symlinked" : "ordinary"} user instructions, skills and prompts`, async t => {
    const sessions: BackendSession[] = [];
    let shared: SharedSandbox | undefined;
    t.after(async () => {
      for (const session of sessions) {
        await session.dispose();
        if (!shared) await session.sandbox?.close();
      }
      await shared?.close();
    });
    const f = fakeProvider(t);
    const root = dirname(f.stateRoot), source = join(root, "pi");
    const config = linked ? join(root, "dotfiles", "pi") : source;
    for (const path of [source, join(config, "skills", "review", "references"), join(config, "prompts")]) mkdirSync(path, { recursive: true });
    writeFileSync(join(config, "AGENTS.md"), "Global Pi instructions.");
    writeFileSync(join(f.scope, "AGENTS.md"), "Project instructions.");
    if (linked) {
      symlinkSync(join(config, "AGENTS.md"), join(source, "AGENTS.md"), "file");
      for (const name of ["skills", "prompts"]) symlinkSync(join(config, name), join(source, name), "dir");
    }
    const skill = join(config, "skills", "review", "SKILL.md");
    writeFileSync(skill, "---\nname: review\ndescription: Review code\n---\nRead references/checklist.txt.");
    writeFileSync(join(config, "skills", "review", "references", "checklist.txt"), "Keep the supporting files.");
    writeFileSync(join(config, "prompts", "publish.md"), "---\ndescription: Publish changes\n---\nPublish $ARGUMENTS");
    // Other user state must not become a read-only mount alongside these resources.
    writeFileSync(join(source, "transcript.jsonl"), "private user transcript");
    shared = sharing === "shared" ? new SharedSandbox(f.stateRoot, () => f.scope) : undefined;
    const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot,
      isolationMode: () => "sandbox", sandbox: () => f.support, sharedSandbox: () => shared,
      env: { PI_CODING_AGENT_DIR: source } });
    const events: BackendEvent[] = [];
    const session = await backend.create({ scope: f.scope, stateDir: f.state, emit: event => events.push(event) });
    sessions.push(session);
    const agent = join(f.state, "pi-agent"), mounts = f.spec().additionalWorkspaces;
    for (const name of ["AGENTS.md", "skills", "prompts"]) {
      assert.equal(lstatSync(join(agent, name)).isSymbolicLink(), true);
      assert.equal(realpathSync(join(agent, name)), realpathSync(join(config, name)));
      assert.ok(mounts.some(mount => mount.path === realpathSync(join(config, name)) && mount.readOnly));
    }
    assert.ok(!mounts.some(mount => mount.path === source || (linked && mount.path === join(root, "dotfiles"))));
    assert.equal(existsSync(join(agent, "transcript.jsonl")), false);
    assert.equal(readFileSync(join(agent, "skills", "review", "references", "checklist.txt"), "utf8"), "Keep the supporting files.");
    const context = async () => {
      await session.prompt("context");
      const message = events.filter(event => event.type === "message" && event.id === "context").at(-1);
      assert.ok(message?.type === "message");
      return JSON.parse(message.text) as { path: string; content: string }[];
    };
    const instructions = await context();
    assert.deepEqual(instructions.filter(file => file.path === join(agent, "AGENTS.md")),
      [{ path: join(agent, "AGENTS.md"), content: "Global Pi instructions." }]);
    assert.ok(instructions.some(file => file.path === join(f.scope, "AGENTS.md") && file.content === "Project instructions."));
    const names = async () => (await session.skills!()).map(skill => skill.name);
    assert.ok((await names()).includes("review"));
    assert.ok((await names()).includes("publish"));
    // A host-side Git update is visible on the next resource reload, not a stale snapshot.
    writeFileSync(join(config, "AGENTS.md"), "Updated global Pi instructions.");
    assert.equal((await context()).find(file => file.path === join(agent, "AGENTS.md"))?.content, "Updated global Pi instructions.");
    writeFileSync(skill, "---\nname: review\ndescription: Updated by Git\n---\nUpdated instructions.");
    assert.equal((await session.skills!()).find(skill => skill.name === "review")?.description, "Updated by Git");
    if (shared) {
      const otherState = join(f.stateRoot, "sessions", "s2", "backend");
      mkdirSync(otherState, { recursive: true });
      const other = await backend.create({ scope: f.scope, stateDir: otherState, emit: () => {} });
      sessions.push(other);
      assert.equal(session.sandbox, other.sandbox);
      assert.ok((await other.skills!()).some(skill => skill.name === "review"));
      await other.dispose();
    }
    await session.dispose();
    assert.equal(existsSync(agent), false);
    assert.equal(existsSync(skill), true);
    assert.equal(readFileSync(join(config, "AGENTS.md"), "utf8"), "Updated global Pi instructions.");
    assert.equal(readFileSync(join(source, "transcript.jsonl"), "utf8"), "private user transcript");
  });
}

test("a sandbox Workflow builder does not stage ambient Pi instructions, skills or prompts", async t => {
  let session: BackendSession | undefined;
  t.after(async () => { await session?.dispose(); await session?.sandbox?.close(); });
  const f = fakeProvider(t), source = join(dirname(f.stateRoot), "pi");
  for (const name of ["skills", "prompts"]) mkdirSync(join(source, name), { recursive: true });
  writeFileSync(join(source, "AGENTS.md"), "Ambient instructions must stay out of the builder.");
  const backend = new WorkerBackend({ backendModule, stateRoot: f.stateRoot,
    isolationMode: () => "sandbox", sandbox: () => f.support, env: { PI_CODING_AGENT_DIR: source } });
  session = await backend.create({ scope: f.scope, stateDir: f.state, emit: () => {}, workflowBuilder: {
    instructions: "Build a workflow", read: async () => "", list: async () => "", write: async () => "",
  } });
  for (const name of ["AGENTS.md", "skills", "prompts"]) {
    assert.equal(existsSync(join(f.state, "pi-agent", name)), false);
    assert.ok(!f.spec().additionalWorkspaces.some(mount => mount.path === join(source, name)));
  }
});
