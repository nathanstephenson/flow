import assert from "node:assert/strict";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { McpSession } from "../src/backend/mcp.ts";
import { WorkerBackend } from "../src/backend/worker/index.ts";
import { prepareFilesystemIsolation } from "../src/isolation/filesystem.ts";
import { nodeExecutionAssets } from "../src/isolation/node-assets.ts";
import { filesystemStdioLaunch } from '../src/isolation/launcher.ts';
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

function aliasModules(f: ReturnType<typeof fixture>) {
  const target = join(f.home, 'cache', 'dependencies');
  mkdirSync(join(f.home, 'cache')); renameSync(f.modules, target);
  symlinkSync(target, f.modules, 'dir');
  return target;
}

for (const alias of [false, true]) {
test(`hoisted MCP workspace server survives a real HOME mask and hides future credentials (alias=${alias})`, { ...isolationIntegration, timeout: 30_000 }, async (t) => {
  const f = fixture(t);
  // The package has no local node_modules. Both SDK and zod are workspace-hoisted links.
  mkdirSync(join(f.modules, "@modelcontextprotocol"));
  symlinkSync(realpathSync(resolve("node_modules/@modelcontextprotocol/sdk")), join(f.modules, "@modelcontextprotocol/sdk"), "dir");
  symlinkSync(realpathSync(resolve("node_modules/zod")), join(f.modules, "zod"), "dir");
  if (alias) aliasModules(f);
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

test(`non-SEA worker restores hoisted linked packages and their dependencies under a HOME mask (alias=${alias})`, { ...isolationIntegration, timeout: 30_000 }, async (t) => {
  const f = fixture(t); linkedDependency(f);
  if (alias) aliasModules(f);
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

}

test('masked dependency aliases preserve realpath and target-side ancestor dependencies', { ...isolationIntegration, timeout: 30_000 }, async t => {
  const f = fixture(t);
  const plain = join(f.modules, 'plain'); mkdirSync(plain);
  writeFileSync(join(plain, 'index.js'), "module.exports={value:require('secondary'),filename:__filename};");
  const target = aliasModules(f);
  const secondary = join(f.home, 'cache/node_modules/secondary'); mkdirSync(secondary, { recursive: true });
  writeFileSync(join(secondary, 'index.js'), "module.exports='target-side';");
  const entry = join(f.pkg, 'entry.cjs'); writeFileSync(entry, "console.log(JSON.stringify(require('plain')));");
  const assets = nodeExecutionAssets([entry]);
  assert.ok(assets.includes(f.modules)); assert.ok(assets.includes(target));
  const plan = await prepareFilesystemIsolation({ scope: f.scope, command: process.execPath, args: [entry],
    readablePaths: [f.pkg, ...assets], credentials: 'none' });
  try {
    const launch = filesystemStdioLaunch(plan);
    const { stdout } = await promisify(execFile)(launch.command, launch.args, { env: plan.env, timeout: 15_000 });
    assert.deepEqual(JSON.parse(stdout), { value: 'target-side', filename: join(target, 'plain/index.js') });
  } finally { plan.cleanup(); }
});

for (const mode of ['direct', 'linked SDK', 'linked library parent'] as const) test(`SEA SDK default-prefix lookup survives masking (${mode})`, { ...isolationIntegration, timeout: 30_000 }, async t => {
  const f = fixture(t), prefix = join(f.home, 'prefix');
  const executable = join(prefix, 'bin/node'), sdkRoot = join(prefix, 'lib/node');
  const pkg = join(sdkRoot, '@earendil-works/pi-coding-agent');
  mkdirSync(join(prefix, 'bin'), { recursive: true }); copyFileSync(process.execPath, executable);
  const library = join(f.home, 'tool-library');
  if (mode === 'linked library parent') {
    mkdirSync(library); writeFileSync(join(library, 'unmounted-sentinel'), 'never restored');
    symlinkSync(library, join(prefix, 'lib'));
  }
  const linked = mode === 'linked SDK', source = linked ? f.linked : pkg;
  const probeCode = `const a=require('assert/strict'),f=require('fs');
    a.equal(require('@earendil-works/pi-coding-agent'),'default-prefix-sdk');
    a.throws(()=>f.writeFileSync(${JSON.stringify(join(source, 'index.js'))},'bad'));
    a.equal(f.existsSync(${JSON.stringify(join(library, 'unmounted-sentinel'))}),false);console.log('global-sdk');`;
  mkdirSync(source, { recursive: true }); mkdirSync(join(sdkRoot, '@earendil-works'), { recursive: true });
  writeFileSync(join(source, 'package.json'), '{"main":"index.js"}');
  writeFileSync(join(source, 'index.js'), "module.exports='default-prefix-sdk';");
  if (linked) symlinkSync(source, pkg);
  const script = join(f.pkg, 'prefix.mjs');
  writeFileSync(script, `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { execFile } from 'node:child_process';
    import { promisify } from 'node:util';
    import { seaSdkExecutionAssets } from ${JSON.stringify(pathToFileURL(resolve('src/backend/worker/assets.ts')).href)};
    import { nodeExecutionAssets } from ${JSON.stringify(pathToFileURL(resolve('src/isolation/node-assets.ts')).href)};
    import { prepareFilesystemIsolation } from ${JSON.stringify(pathToFileURL(resolve('src/isolation/filesystem.ts')).href)};
    import { filesystemStdioLaunch } from ${JSON.stringify(pathToFileURL(resolve('src/isolation/launcher.ts')).href)};
    const sdk='@earendil-works/pi-coding-agent';
    assert.equal(createRequire(process.execPath)(sdk),'default-prefix-sdk');
    const assets=seaSdkExecutionAssets(); assert.ok(assets.includes(${JSON.stringify(sdkRoot)}));
    const plan=await prepareFilesystemIsolation({scope:${JSON.stringify(f.scope)},command:process.execPath,
      args:['-e',${JSON.stringify(probeCode)}],
      readablePaths:[...assets,...nodeExecutionAssets(assets)],credentials:'none'});
    try { const launch=filesystemStdioLaunch(plan);
      const result=await promisify(execFile)(launch.command,launch.args,{env:plan.env,timeout:15000});
      process.stdout.write(result.stdout);
    } finally {plan.cleanup();}
  `);
  const { stdout } = await promisify(execFile)(executable, ['--experimental-strip-types', script], {
    env: { ...process.env, PATH: '/usr/bin:/bin', NODE_PATH: '' }, timeout: 25_000,
  });
  assert.equal(stdout.trim(), 'global-sdk');
});

test('logical asset destinations beneath protected ancestor aliases are refused', isolationIntegration, async t => {
  const f = fixture(t);
  const state = join(f.home, '.flow'); mkdirSync(state);
  const parentAlias = join(f.home, 'state-alias'); symlinkSync(state, parentAlias);
  const assetAlias = join(parentAlias, 'modules'); symlinkSync(f.linked, assetAlias);
  await assert.rejects(prepareFilesystemIsolation({ scope: f.scope, command: process.execPath, args: [],
    readablePaths: [assetAlias], credentials: 'none' }), /Readable execution asset would expose protected state/);
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
