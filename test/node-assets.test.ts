import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { McpSession } from "../src/backend/mcp.ts";
import { WorkerBackend } from "../src/backend/worker/index.ts";
import { prepareFilesystemIsolation } from "../src/isolation/filesystem.ts";
import { nodeExecutionAssets } from "../src/isolation/node-assets.ts";
import { isolationIntegration } from "./isolation-fixture.ts";

function fixture(t: TestContext) {
  // Not /tmp: an absent credential masks this owned HOME, including its dependency trees.
  const home = mkdtempSync(join(homedir(), "flow-node-assets-"));
  const scope = join(home, "scope"), workspace = join(home, "workspace");
  const pkg = join(workspace, "packages", "server"), modules = join(workspace, "node_modules");
  const linked = join(home, "linked", "dependency");
  for (const path of [scope, pkg, modules, linked]) mkdirSync(path, { recursive: true });
  writeFileSync(join(pkg, "package.json"), '{"type":"module"}');
  writeFileSync(join(home, "unmounted-sentinel"), "hidden by HOME mask");
  const saved = process.env.HOME;
  process.env.HOME = home;
  t.after(() => {
    if (saved === undefined) delete process.env.HOME; else process.env.HOME = saved;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, scope, workspace, pkg, modules, linked };
}

function linkedDependency(f: ReturnType<typeof fixture>) {
  const secondary = join(f.home, "linked", "node_modules", "secondary");
  mkdirSync(secondary, { recursive: true });
  writeFileSync(join(secondary, "index.js"), "module.exports = 'linked and hoisted';");
  writeFileSync(join(f.linked, "index.js"), "module.exports = require('secondary');");
  symlinkSync(f.linked, join(f.modules, "dependency"), "dir");
  return secondary;
}

function toolText(result: Awaited<ReturnType<ReturnType<McpSession["tools"]>[number]["call"]>>) {
  const content = result.content[0];
  assert.equal(content?.type, "text");
  return (content as { text: string }).text;
}

test("Node assets discover ancestor search trees, scoped links and linked-package search trees without ancestor grants", (t) => {
  const f = fixture(t), secondary = linkedDependency(f);
  const scoped = join(f.modules, "@fixture"); mkdirSync(scoped);
  symlinkSync(f.linked, join(scoped, "alias"), "dir");
  symlinkSync(join(f.home, "absent"), join(f.modules, "optional"), "dir");
  writeFileSync(join(f.pkg, "entry.cjs"), "");
  const assets = nodeExecutionAssets([f.pkg, join(f.pkg, "entry.cjs")]);
  for (const path of [f.modules, f.linked, join(secondary, "..")]) assert.ok(assets.includes(realpathSync(path)), path);
  for (const path of [f.home, f.workspace, join(f.home, "linked"), f.pkg]) assert.equal(assets.includes(path), false, path);
  assert.equal(new Set(assets).size, assets.length);
});

test("hoisted MCP workspace server survives a real HOME mask and hides future credentials", { ...isolationIntegration, timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  // The package has no local node_modules. Both SDK and zod are workspace-hoisted links.
  mkdirSync(join(f.modules, "@modelcontextprotocol"));
  symlinkSync(realpathSync(resolve("node_modules/@modelcontextprotocol/sdk")), join(f.modules, "@modelcontextprotocol/sdk"), "dir");
  symlinkSync(realpathSync(resolve("node_modules/zod")), join(f.modules, "zod"), "dir");
  const server = join(f.pkg, "server.ts");
  writeFileSync(server, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
    import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
    const server = new McpServer({ name: 'hoisted', version: '1' });
    server.registerTool('probe', { inputSchema: {} }, async () => {
      const hidden = ${JSON.stringify([join(f.home, "unmounted-sentinel"), join(f.home, ".npmrc")])}.map(path => !existsSync(path));
      let readonly = false;
      try { writeFileSync(${JSON.stringify(join(f.modules, "mutation"))}, 'bad'); } catch (error) { readonly = error.code === 'EROFS'; }
      return { content: [{ type: 'text', text: JSON.stringify({ hidden, readonly }) }] };
    });
    await server.connect(new StdioServerTransport());
  `);
  const mcp = new McpSession([{ id: "hoisted", name: "Hoisted", enabledByDefault: true, transport: "stdio",
    command: process.execPath, args: ["--experimental-strip-types", server] }], f.scope);
  try {
    await mcp.open();
    assert.equal(mcp.status()[0]?.state, "connected");
    writeFileSync(join(f.home, ".npmrc"), "future secret");
    assert.deepEqual(JSON.parse(toolText(await mcp.tools()[0]!.call({}))), { hidden: [true, true], readonly: true });
  } finally { await mcp.dispose(); }
});

test("non-SEA worker restores hoisted linked packages and their dependencies under a HOME mask", { ...isolationIntegration, timeout: 30_000 }, async (t) => {
  const f = fixture(t); linkedDependency(f);
  // This bootstrap is an ordinary Node worker, not a SEA. The linked dependency must
  // load before the worker can start IPC; its own dependency lives outside the workspace.
  const entry = join(f.pkg, "entry.cjs");
  writeFileSync(entry, `
    const assert = require('node:assert/strict'), fs = require('node:fs');
    assert.equal(require('dependency'), 'linked and hoisted');
    assert.equal(fs.existsSync(${JSON.stringify(join(f.home, "unmounted-sentinel"))}), false);
    fs.writeFileSync('dependency-loaded', 'yes');
    import(${JSON.stringify(pathToFileURL(resolve("src/backend/worker/entry.ts")).href)});
  `);
  const backendModule = join(f.pkg, "backend.mjs");
  writeFileSync(backendModule, `
    import { existsSync } from 'node:fs';
    import dependency from 'dependency';
    export default { name: 'fixture', async create(options) {
      return { capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
        resumeToken: () => dependency,
        async prompt() { if (existsSync(${JSON.stringify(join(f.home, ".npmrc"))})) throw new Error('future credential exposed'); },
        async abort() {}, async setModel() {}, async setEffort() {}, async dispose() {} };
    } };
  `);
  const session = await new WorkerBackend({ entry, backendModule: pathToFileURL(backendModule).href }).create({ scope: f.scope, emit: () => {} });
  try {
    assert.equal(session.resumeToken(), "linked and hoisted");
    assert.equal(readFileSync(join(f.scope, "dependency-loaded"), "utf8"), "yes");
    writeFileSync(join(f.home, ".npmrc"), "future secret");
    await session.prompt("probe");
  } finally { await session.dispose(); }
});

for (const mode of ["tree", "linked target"] as const) test(`protected dependency ${mode} is refused by the strict mount policy`, { ...isolationIntegration, timeout: 15_000 }, async (t) => {
  const f = fixture(t); linkedDependency(f);
  const protectedPath = mode === "tree" ? join(f.modules, "future-credential") : join(f.linked, "future-credential");
  await assert.rejects(prepareFilesystemIsolation({ scope: f.scope, command: process.execPath, args: [],
    readablePaths: [f.pkg, ...nodeExecutionAssets([f.pkg])], protectedPaths: [protectedPath], credentials: "none" }),
  /Readable execution asset would expose protected state/);

  // Both callers must pass discovered mounts to the same validator, not silently
  // drop protected trees or add a bypass for Node dependencies.
  const entry = join(f.pkg, "entry.cjs"), marker = join(f.scope, "launched");
  writeFileSync(entry, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unsafe');`);
  const mcp = new McpSession([{ id: "protected", name: "Protected", enabledByDefault: true, transport: "stdio",
    command: process.execPath, args: [entry] }], f.scope, undefined, false, undefined, [protectedPath]);
  try {
    await mcp.open();
    assert.equal(mcp.status()[0]?.state, "failed");
    assert.deepEqual(mcp.tools(), []);
  } finally { await mcp.dispose(); }
  await assert.rejects(new WorkerBackend({ entry, stateRoot: protectedPath }).create({ scope: f.scope, emit: () => {} }),
    /Readable execution asset would expose protected state/);
  assert.throws(() => readFileSync(marker), { code: "ENOENT" });
});
