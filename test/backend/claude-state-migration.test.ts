import assert from "node:assert/strict";
import { existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { migrateLegacyClaudeState } from "../../src/backend/worker/claude-state.ts";

const uuid = "12345678-1234-4567-89ab-123456789abc";
const otherUuid = "87654321-4321-7654-ba98-cba987654321";
const main = `${uuid}.jsonl`;
const encodeScope = (scope: string) => scope.replace(/[^a-zA-Z0-9]/g, "-");

function put(path: string, content: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

// lstat rather than stat: snapshots never follow links and also detect source replacement.
function snapshot(root: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  function visit(path: string, relative: string): void {
    const stat = lstatSync(path);
    const metadata = { ino: stat.ino, nlink: stat.nlink, mode: stat.mode };
    if (stat.isSymbolicLink()) result[relative] = { ...metadata, link: readlinkSync(path) };
    else if (stat.isDirectory()) {
      result[relative] = { ...metadata, directory: true };
      for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
    } else result[relative] = { ...metadata, content: readFileSync(path, "utf8") };
  }
  visit(root, "");
  return result;
}

function files(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(path: string, relative: string): void {
    const stat = lstatSync(path);
    assert.equal(stat.isSymbolicLink(), false, `unexpected owned link: ${relative}`);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), relative ? `${relative}/${name}` : name);
    } else {
      assert.equal(stat.nlink, 1, `unexpected owned hardlink: ${relative}`);
      result[relative] = readFileSync(path, "utf8");
    }
  }
  visit(root, "");
  return result;
}

function fixture(t: TestContext, configured?: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "flow-claude-migration-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scope = join(root, "scope"), home = join(root, "home"), state = join(root, "backend");
  const config = configured === undefined ? join(home, ".claude") : join(scope, configured);
  const key = encodeScope(scope);
  const source = join(config, "projects", key);
  const projects = join(state, "claude-projects"), destination = join(projects, key);
  for (const dir of [scope, home, state, source]) mkdirSync(dir, { recursive: true });
  const env: NodeJS.ProcessEnv = { HOME: home, ...(configured === undefined ? {} : { CLAUDE_CONFIG_DIR: configured }) };
  const migrate = () => migrateLegacyClaudeState(state, env, scope, uuid);
  put(join(source, main), "selected main\n");
  return { root, scope, home, state, config, key, source, projects, destination, env, migrate };
}

function assertUnpublished(f: ReturnType<typeof fixture>): void {
  assert.deepEqual(files(f.state), {}, "no transcript or sidecars may be partially published");
  if (existsSync(f.projects)) {
    assert.ok(readdirSync(f.projects).every(name => !name.startsWith(".migrate-")), "no staging directory remains");
  }
}

test("migration imports only the selected Scope and resume UUID, preserving global records and excluding credentials", t => {
  const f = fixture(t);
  const selected = {
    [main]: "selected main\n",
    [`${uuid}/subagents/agent-one.jsonl`]: "selected Subagent\n",
    [`${uuid}/tool-results/result.txt`]: "selected tool result",
  };
  for (const [path, content] of Object.entries(selected)) put(join(f.source, path), content);
  put(join(f.source, `${otherUuid}.jsonl`), "other UUID main");
  put(join(f.source, otherUuid, "subagents/agent-two.jsonl"), "other UUID sidecar");
  put(join(f.source, "unrelated.json"), "unrelated project metadata");
  put(join(f.config, "projects", encodeScope(join(f.root, "other-scope")), main), "other Scope main");
  put(join(f.config, "projects", encodeScope(join(f.root, "other-scope")), uuid, "tool-results/result.txt"), "other Scope sidecar");
  put(join(f.config, ".credentials.json"), "secret OAuth tokens");
  put(join(f.config, ".config.json"), "secret config");
  put(join(f.home, ".claude.json"), "secret home config");
  const before = snapshot(f.home);

  f.migrate();

  assert.deepEqual(files(f.state), Object.fromEntries(Object.entries(selected).map(([path, content]) => [`claude-projects/${f.key}/${path}`, content])));
  assert.deepEqual(readdirSync(f.projects), [f.key]);
  assert.deepEqual(snapshot(f.home), before, "source content, links and inodes are preserved");
});

test("migration preserves an existing owned project directory and its unrelated records", t => {
  const f = fixture(t);
  put(join(f.destination, `${otherUuid}.jsonl`), "owned unrelated conversation");
  put(join(f.source, uuid, "subagents/agent.jsonl"), "selected sidecar");
  f.migrate();
  assert.equal(readFileSync(join(f.destination, main), "utf8"), "selected main\n");
  assert.equal(readFileSync(join(f.destination, `${otherUuid}.jsonl`), "utf8"), "owned unrelated conversation");
  assert.equal(readFileSync(join(f.destination, uuid, "subagents/agent.jsonl"), "utf8"), "selected sidecar");
  assert.equal(lstatSync(join(f.destination, main)).nlink, 1);
  assert.ok(readdirSync(f.projects).every(name => !name.startsWith(".migrate-")));
});

for (const matching of [true, false]) {
  test(`a restart between sidecar and transcript publication ${matching ? "recovers" : "preserves differing owned state"}`, t => {
    const f = fixture(t);
    put(join(f.source, uuid, "subagents/agent.jsonl"), "selected sidecar");
    put(join(f.destination, uuid, "subagents/agent.jsonl"), matching ? "selected sidecar" : "different owned sidecar");
    const before = snapshot(f.destination);
    if (matching) {
      f.migrate();
      assert.equal(readFileSync(join(f.destination, main), "utf8"), "selected main\n");
      assert.equal(lstatSync(join(f.destination, main)).nlink, 1);
    } else {
      assert.throws(f.migrate, /sidecars differ from the legacy record/);
      assert.equal(existsSync(join(f.destination, main)), false);
    }
    const after = snapshot(f.destination);
    if (matching) delete after[main];
    assert.deepEqual(after, before, "existing sidecar content and inodes must never change");
    assert.ok(readdirSync(f.projects).every(name => !name.startsWith(".migrate-")));
  });
}

test("an existing owned copy is authoritative on repeated import, even when the global project becomes unsafe", t => {
  const f = fixture(t);
  put(join(f.source, uuid, "tool-results/result.txt"), "original sidecar");
  f.migrate();
  put(join(f.destination, main), "newer owned main");
  put(join(f.destination, uuid, "tool-results/result.txt"), "newer owned sidecar");
  const owned = snapshot(f.state);
  put(join(f.source, main), "changed global main");
  put(join(f.source, uuid, "tool-results/result.txt"), "changed global sidecar");
  put(join(f.source, uuid, "subagents/new.jsonl"), "new global sidecar");
  f.migrate();
  assert.deepEqual(snapshot(f.state), owned);
  const relocated = join(f.root, "relocated-project");
  renameSync(f.source, relocated);
  symlinkSync(relocated, f.source, "dir");
  assert.doesNotThrow(f.migrate, "must not consult global storage once the owned main exists");
  assert.deepEqual(snapshot(f.state), owned);
});

test("migration is a no-op without a resume ID or a state directory", t => {
  const f = fixture(t), before = snapshot(f.root);
  migrateLegacyClaudeState(f.state, f.env, f.scope, undefined);
  migrateLegacyClaudeState(f.state, f.env, f.scope, "");
  migrateLegacyClaudeState(undefined, f.env, f.scope, uuid);
  migrateLegacyClaudeState(undefined, f.env, f.scope, "../invalid");
  migrateLegacyClaudeState(join(f.root, "missing-state"), f.env, f.scope, undefined);
  assert.deepEqual(snapshot(f.root), before, "even the owned projects directory must not be created");
});

test("long Scope keys use the installed SDK's 200-character encoding and absolute signed Java hash of the raw Scope", t => {
  const f = fixture(t);
  // Independent Java String.hashCode formulation; split keeps UTF-16 code units, including surrogates.
  const javaHash = (value: string) => value.split("").reduce((hash, char) => (Math.imul(31, hash) + char.charCodeAt(0)) | 0, 0);
  let scope = join(f.root, "Scope.with punctuation_".repeat(8), "nested+".repeat(16), "unicode-🧪");
  while (javaHash(scope) >= 0) scope += "x";
  mkdirSync(scope, { recursive: true });
  const encoded = encodeScope(scope), hash = javaHash(scope);
  assert.ok(encoded.length > 200);
  assert.ok(hash < 0, "exercise Math.abs rather than an unsigned hash");
  assert.notEqual(hash, javaHash(encoded), "hash the raw Scope, not its encoded key");
  const key = `${encoded.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
  put(join(f.config, "projects", key, main), "long Scope selected main");
  put(join(f.config, "projects", encoded.slice(0, 200), main), "wrong truncated key");
  put(join(f.config, "projects", `${encoded.slice(0, 200)}-${(hash >>> 0).toString(36)}`, main), "wrong unsigned hash key");

  migrateLegacyClaudeState(f.state, f.env, scope, uuid);

  assert.deepEqual(readdirSync(f.projects), [key]);
  assert.deepEqual(files(f.state), { [`claude-projects/${key}/${main}`]: "long Scope selected main" });
});

for (const configured of ["relative-config", "~", "~/literal-config"]) {
  test(`config ${JSON.stringify(configured)} resolves literally against the Scope, not HOME`, t => {
    const f = fixture(t, configured);
    put(join(f.home, ".claude", "projects", f.key, main), "wrong HOME record");
    const before = snapshot(f.config);
    f.migrate();
    assert.deepEqual(files(f.state), { [`claude-projects/${f.key}/${main}`]: "selected main\n" });
    assert.deepEqual(snapshot(f.config), before);
  });
}

for (const location of ["projects", "Scope"]) {
  test(`refuses a symlink in the source ${location} directory`, t => {
    const f = fixture(t);
    const path = location === "projects" ? join(f.config, "projects") : f.source;
    const target = join(f.root, "source-target");
    renameSync(path, target);
    symlinkSync(target, path, "dir");
    const before = snapshot(f.config), targetBefore = snapshot(target);
    assert.throws(f.migrate, /Unsafe legacy Claude project directory/);
    assertUnpublished(f);
    assert.deepEqual(snapshot(f.config), before);
    assert.deepEqual(snapshot(target), targetBefore);
  });
}

for (const [record, kind] of [
  [main, "symlink"], [main, "hardlink"],
  [uuid, "directory symlink"],
  [`${uuid}/subagents`, "directory symlink"],
  [`${uuid}/tool-results/z-linked.txt`, "symlink"],
  [`${uuid}/tool-results/z-linked.txt`, "hardlink"],
] as const) {
  test(`refuses ${kind} at selected record ${record} without publishing files or leaving staging`, t => {
    const f = fixture(t);
    // A valid record comes first to exercise cleanup after copying has already begun.
    put(join(f.source, uuid, "a-valid.jsonl"), "valid sidecar");
    const target = join(f.root, "unrelated-host-record");
    if (kind === "directory symlink") {
      mkdirSync(target);
      put(join(target, "secret.jsonl"), "must not follow");
    } else put(target, "must not copy");
    const path = join(f.source, record);
    rmSync(path, { recursive: true, force: true });
    mkdirSync(join(path, ".."), { recursive: true });
    if (kind === "hardlink") linkSync(target, path);
    else symlinkSync(target, path, kind === "directory symlink" ? "dir" : "file");
    const before = snapshot(f.config), targetBefore = snapshot(target);

    assert.throws(f.migrate, /Unsafe legacy Claude conversation record/);

    assertUnpublished(f);
    assert.deepEqual(snapshot(f.config), before);
    assert.deepEqual(snapshot(target), targetBefore);
  });
}

for (const resume of ["../escape", `${uuid}/../../escape`, `${uuid}/`, `${uuid}.jsonl`, "not-a-uuid"]) {
  test(`refuses invalid resume ID ${JSON.stringify(resume)} before any filesystem mutation`, t => {
    const f = fixture(t), before = snapshot(f.root);
    assert.throws(() => migrateLegacyClaudeState(f.state, f.env, f.scope, resume), /Invalid Claude resume ID/);
    assert.deepEqual(snapshot(f.root), before);
  });
}

for (const [directory, kind] of [
  ["project", "symlink"], ["project", "file"],
  ["projects", "symlink"], ["projects", "file"],
] as const) {
  test(`refuses unsafe owned ${directory} directory (${kind})`, t => {
    const f = fixture(t), target = join(f.root, "owned-target");
    const path = directory === "projects" ? f.projects : f.destination;
    mkdirSync(join(path, ".."), { recursive: true });
    mkdirSync(target);
    if (kind === "symlink") symlinkSync(target, path, "dir");
    else put(path, "not a directory");
    const before = snapshot(f.root);
    assert.throws(f.migrate, directory === "projects" ? /Unsafe Claude backend transcript directory/ : /Unsafe Claude backend project directory/);
    assert.deepEqual(snapshot(f.root), before, "no publication, staging leftovers or writes through the unsafe directory");
  });
}
