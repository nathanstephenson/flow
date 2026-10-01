import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { prepareFilesystemIsolation, type FilesystemIsolationOptions } from "../src/isolation/filesystem.ts";
import { filesystemStdioLaunch } from "../src/isolation/launcher.ts";

const execute = promisify(execFile);
const bwrap = process.env.FLOW_BWRAP_PATH ?? "/usr/bin/bwrap";
const probe = process.platform === "linux" ? spawnSync(bwrap, ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts",
  "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev", "--", "/bin/true"], { encoding: "utf8", timeout: 10_000 }) : undefined;
const unavailable = !probe || probe.error || probe.status !== 0;
const integration = { skip: unavailable ? `Bubblewrap namespaces unavailable: ${probe?.error?.message ?? probe?.stderr ?? process.platform}` : false };

function fixture(parent = tmpdir()) {
  const root = mkdtempSync(join(parent, "flow-isolation-test-"));
  const home = join(root, "home");
  const scope = join(root, "project");
  const flow = join(home, ".flow");
  const backend = join(flow, "sessions", "one", "backend");
  const outside = join(root, "outside");
  const pi = join(home, ".pi/agent");
  const claude = join(home, ".claude");
  for (const dir of [scope, backend, outside, pi, claude]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(flow, "token"), "host-token");
  writeFileSync(join(flow, "sessions/one/transcript.jsonl"), "host-transcript");
  writeFileSync(join(outside, "keep"), "outside");
  writeFileSync(join(pi, "auth.json"), '{"provider":"credential"}');
  writeFileSync(join(pi, "models.json"), '{"models":[]}');
  writeFileSync(join(pi, "settings.json"), '{"theme":"dark"}');
  writeFileSync(join(pi, "transcript.jsonl"), "pi-transcript");
  writeFileSync(join(claude, ".credentials.json"), '{"oauth":"credential"}');
  writeFileSync(join(claude, "transcript.jsonl"), "claude-transcript");
  writeFileSync(join(home, ".claude.json"), '{"auth":"config"}');
  const env = { HOME: home, FLOW_STATE_DIR: flow, FLOW_BWRAP_PATH: bwrap };
  const options = (extra: Partial<FilesystemIsolationOptions> = {}): FilesystemIsolationOptions => ({
    scope, command: process.execPath, args: [], env, ...extra,
  });
  return { root, home, scope, flow, backend, outside, pi, claude, env, options,
    cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function node(options: FilesystemIsolationOptions, code: string, payload: unknown = {}) {
  const prepared = await prepareFilesystemIsolation({ ...options, args: ["-e", code, JSON.stringify(payload)] });
  try {
    const launch = filesystemStdioLaunch(prepared);
    return await execute(launch.command, launch.args, { env: prepared.env, timeout: 15_000, maxBuffer: 64 * 1024 });
  } finally { prepared.cleanup(); }
}

// These tests always run, even on machines where the real namespace tests cannot run.
describe("filesystem isolation fails closed", () => {
  it("refuses a missing launcher without executing the requested command", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const marker = join(f.scope, "escaped");
    await assert.rejects(prepareFilesystemIsolation(f.options({
      env: { ...f.env, FLOW_BWRAP_PATH: join(f.root, "missing-bwrap") },
      args: ["-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad')`],
    })), /isolation unavailable.*unrestricted launch refused/i);
    assert.equal(existsSync(marker), false);
  });

  it("refuses failed namespace/mount probes and removes staging directories", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const marker = join(f.outside, 'owned-staging'), launcher = join(f.outside, 'failed-probe');
    // Observe this probe's private home fd, not all /tmp staging roots: other test files
    // may legitimately create/remove their own boundaries while this asynchronous probe runs.
    writeFileSync(launcher, `#!${process.execPath}\nconst f=require('fs'),args=process.argv.slice(2);
      const i=args.findIndex((arg,index)=>arg==='--bind-fd'&&args[index+2]==='/tmp/flow-isolation/home');
      f.writeFileSync(${JSON.stringify(marker)},f.readlinkSync('/proc/self/fd/'+args[i+1]));process.exit(1);`, { mode: 0o700 });
    await assert.rejects(prepareFilesystemIsolation(f.options({ env: { ...f.env, FLOW_BWRAP_PATH: launcher, ANTHROPIC_API_KEY: "never-log-this" } })),

      (error: Error) => {
        assert.match(error.message, /isolation unavailable.*unrestricted launch refused/i);
        assert.equal(String(error).includes("never-log-this"), false);
        assert.equal(String(error.cause).includes("never-log-this"), false);
        return true;
      });
    if (process.platform === 'linux') assert.equal(existsSync(dirname(readFileSync(marker, 'utf8'))), false);
    else assert.equal(existsSync(marker), false);
  });

  it("refuses a Scope redirected after its canonical binding was selected", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const original = join(f.root, "original-scope"); renameSync(f.scope, original);
    symlinkSync(f.outside, f.scope);
    await assert.rejects(prepareFilesystemIsolation(f.options({ expectedScope: f.scope })), /Scope changed since selection/);
    assert.equal(readFileSync(join(f.outside, "keep"), "utf8"), "outside");
  });

  it("refuses a launcher in writable backend state before executing even its probe", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const launcher = join(f.backend, "bwrap");
    const marker = join(f.outside, "unrestricted-probe");
    writeFileSync(launcher, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    const alias = join(f.root, "launcher-alias"); symlinkSync(launcher, alias);
    const otherBackend = join(f.flow, 'sessions/two/backend'); mkdirSync(otherBackend, { recursive: true });
    const otherLauncher = join(otherBackend, 'bwrap');
    writeFileSync(otherLauncher, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o700 });
    for (const path of [launcher, alias, otherLauncher]) {
      await assert.rejects(prepareFilesystemIsolation(f.options({ stateDir: f.backend,
        env: { ...f.env, FLOW_BWRAP_PATH: path } })), /Trusted launch executable.*writable backend state/);
      assert.equal(existsSync(marker), false);
    }
  });

  it("refuses broad PATH restoration and explicit protected launch targets", { skip: process.platform !== 'linux' }, async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const bin = join(f.home, 'bin'); mkdirSync(bin);
    const tool = join(f.pi, 'private-tool'); writeFileSync(tool, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    symlinkSync(tool, join(bin, 'credential-tool'));
    for (const [path, command] of [[f.home, process.execPath], [f.pi, tool], [bin, join(bin, 'credential-tool')]] as const) {
      await assert.rejects(prepareFilesystemIsolation(f.options({ command,
        env: { ...f.env, PATH: path, FLOW_BWRAP_PATH: '/bin/true' },
      })), /Readable execution asset would expose protected state/);
    }
  });

  it("refuses a missing protected root without a safe existing ancestor", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    await assert.rejects(prepareFilesystemIsolation(f.options({
      env: { ...f.env, FLOW_BWRAP_PATH: "/bin/true" }, protectedPaths: [`/flow-absent-protected-${process.pid}/token`],
    })), /no safe existing ancestor/);
  });

  it("refuses unsupported platforms", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "darwin" });
      await assert.rejects(prepareFilesystemIsolation(f.options()), /unrestricted launch refused.*requires Linux/);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("rejects root, home, protected ancestors and secret/session Scopes before launch", { skip: process.platform !== "linux" }, async (t) => {
    const f = fixture(); t.after(f.cleanup);
    for (const scope of ["/", homedir(), f.home, f.root, f.flow, join(f.flow, "sessions"), f.backend, f.pi, f.claude]) {
      await assert.rejects(prepareFilesystemIsolation(f.options({ scope })), /Unsafe Scope|protected host state/);
    }
    const alias = join(f.root, "secret-alias");
    symlinkSync(f.flow, alias);
    await assert.rejects(prepareFilesystemIsolation(f.options({ scope: alias })), /protected host state/);
  });
});

describe("real Bubblewrap filesystem boundary", integration, () => {
  it("preserves masked PATH toolchains, package-relative launch scripts and directory aliases without exposing later credentials", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const toolchain = join(f.home, 'toolchain');
    const bin = join(toolchain, 'bin'), pkg = join(toolchain, 'lib/node_modules/tool');
    const alias = join(f.home, 'current');
    mkdirSync(bin, { recursive: true }); mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, 'package.json'), '{}');
    const dependency = join(f.home, 'node_modules/hoisted-tool-test'); mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), '{"main":"index.cjs"}');
    writeFileSync(join(dependency, 'index.cjs'), "module.exports='selected-toolchain';");
    writeFileSync(join(pkg, 'value.cjs'), "module.exports=require('hoisted-tool-test');");
    writeFileSync(join(pkg, 'cli.cjs'), "#!/usr/bin/env node\nconsole.log(require('./value.cjs'));", { mode: 0o700 });
    symlinkSync('../lib/node_modules/tool/cli.cjs', join(bin, 'flow-test-npm'));
    symlinkSync(toolchain, alias);
    const publicBin = join(f.scope, 'bin'); mkdirSync(publicBin);
    symlinkSync(join(pkg, 'cli.cjs'), join(publicBin, 'flow-test-public-tool'));
    const prepared = await prepareFilesystemIsolation(f.options({
      env: { ...f.env, PATH: `${publicBin}:${alias}/bin:${process.env.PATH}` },
      args: ['-e', `const a=require('assert/strict'),f=require('fs'),c=require('child_process');
        const result=c.spawnSync('flow-test-npm',[],{encoding:'utf8'});
        a.equal(result.status,0,result.stderr);a.equal(result.stdout.trim(),'selected-toolchain');
        const linked=c.spawnSync('flow-test-public-tool',[],{encoding:'utf8'});
        a.equal(linked.status,0,linked.stderr);a.equal(linked.stdout.trim(),'selected-toolchain');
        a.equal(f.existsSync(${JSON.stringify(join(f.home, '.netrc'))}),false);
        a.throws(()=>f.writeFileSync(${JSON.stringify(join(pkg, 'value.cjs'))},'bad'));
        console.log('selected');`],
    }));
    t.after(prepared.cleanup);
    writeFileSync(join(f.home, '.netrc'), 'future-host-credential');
    const launch = filesystemStdioLaunch(prepared);
    const { stdout } = await execute(launch.command, launch.args, { env: prepared.env, timeout: 15_000 });
    assert.equal(stdout.trim(), 'selected');
    assert.equal(readFileSync(join(f.home, '.netrc'), 'utf8'), 'future-host-credential');
  });

  it("keeps the host-selected npm and npx versions rather than silently switching to system tools", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    for (const tool of ['npm', 'npx']) {
      const host = spawnSync(tool, ['--version'], { encoding: 'utf8' });
      if ((host.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') { t.skip(`${tool} unavailable on host`); return; }
      assert.equal(host.status, 0, host.stderr);
      const { stdout } = await node(f.options(), `const a=require('assert/strict'),c=require('child_process');
        const result=c.spawnSync(${JSON.stringify(tool)},['--version'],{encoding:'utf8'});
        a.equal(result.status,0,result.stderr);console.log(result.stdout.trim());`);
      assert.equal(stdout.trim(), host.stdout.trim());
    }
  });

  it("allows write/edit/delete only in Scope; denies symlink and descendant process escapes", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    symlinkSync(join(f.outside, "keep"), join(f.scope, "outside-link"));
    const { stdout } = await node(f.options({ readablePaths: [f.outside] }), String.raw`
      const fs = require('node:fs'), assert = require('node:assert/strict'), cp = require('node:child_process');
      const p = JSON.parse(process.argv[1]);
      assert.equal(process.cwd(), p.scope);
      fs.writeFileSync(p.scope + '/write', 'first');
      fs.appendFileSync(p.scope + '/write', '-edited');
      assert.equal(fs.readFileSync(p.scope + '/write', 'utf8'), 'first-edited');
      fs.mkdirSync(p.scope + '/remove/nested', {recursive:true});
      fs.writeFileSync(p.scope + '/remove/nested/file', 'delete-me');
      fs.rmSync(p.scope + '/remove', {recursive:true});
      assert.equal(fs.readFileSync(p.outside + '/keep', 'utf8'), 'outside');
      for (const target of [p.outside + '/keep', p.scope + '/outside-link']) {
        assert.throws(() => fs.writeFileSync(target, 'bad'), {code:'EROFS'});
        assert.throws(() => fs.appendFileSync(target, 'bad'), {code:'EROFS'});
      }
      assert.throws(() => fs.rmSync(p.outside, {recursive:true,force:true}));
      const child = cp.spawnSync(process.execPath, ['-e',
        'const f=require("fs");try{f.writeFileSync(process.argv[1],"bad");process.exit(2)}catch(e){if(e.code!=="EROFS")throw e}',
        p.outside + '/keep'], {encoding:'utf8'});
      assert.equal(child.status, 0, child.stderr);
      console.log('confined');
    `, f);
    assert.equal(stdout.trim(), "confined");
    assert.equal(readFileSync(join(f.outside, "keep"), "utf8"), "outside");
    assert.equal(readFileSync(join(f.scope, "write"), "utf8"), "first-edited");
    assert.equal(existsSync(join(f.scope, "remove")), false);
  });

  it("hides host state/auth/socket scratch and host /proc; scrubs overrides even if launcher merges env", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const hostScratch = join(f.root, "host-socket");
    const socket = createServer();
    await new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.listen(hostScratch, resolve); });
    t.after(() => new Promise<void>((resolve) => socket.close(() => resolve())));
    const injection = join(f.scope, "inject.cjs");
    writeFileSync(injection, "require('fs').writeFileSync(__dirname + '/injected', 'bad')");
    const prepared = await prepareFilesystemIsolation(f.options({
      env: { ...f.env, NODE_OPTIONS: `--require ${injection}`, NODE_PATH: f.root,
        FLOW_TOKEN: "host-env-token", FLOW_OIDC_CLIENT_SECRET: "host-secret", ANTHROPIC_API_KEY: "provider-key",
        SSH_AUTH_SOCK: hostScratch, XDG_RUNTIME_DIR: f.root },
      args: ["-e", String.raw`
        const fs=require('fs'), assert=require('assert/strict'), p=JSON.parse(process.argv[1]);
        for (const path of p.hidden) { assert.equal(fs.existsSync(path), false, path); assert.throws(() => fs.readFileSync(path), path); }
        assert.equal(fs.existsSync('/proc/' + p.hostPid + '/environ'), false);
        assert.throws(() => fs.writeFileSync('/proc/self/comm', 'model'), /EROFS/);
        const pids=fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p));
        assert.ok(pids.length < 10, pids.join(','));
        assert.equal(process.env.FLOW_TOKEN, undefined);
        assert.equal(process.env.FLOW_STATE_DIR, undefined);
        assert.equal(process.env.FLOW_OIDC_CLIENT_SECRET, undefined);
        assert.equal(process.env.NODE_OPTIONS, undefined);
        assert.equal(process.env.NODE_PATH, undefined);
        assert.equal(process.env.SSH_AUTH_SOCK, undefined);
        assert.equal(process.env.ANTHROPIC_API_KEY, 'provider-key');
        assert.notEqual(process.env.HOME, p.home);
        for(const dir of [process.env.HOME, '/tmp', '/var/tmp', process.env.XDG_RUNTIME_DIR]) {
          fs.writeFileSync(dir+'/private', 'ephemeral');
        }
        assert.deepEqual(fs.readdirSync('/run'), []);
        if(fs.existsSync('/var/run')) assert.deepEqual(fs.readdirSync('/var/run'), []);
        console.log('hidden');
      `, JSON.stringify({ hidden: [join(f.flow, "token"), join(f.flow, "sessions/one/transcript.jsonl"),
        join(f.pi, "auth.json"), join(f.pi, "transcript.jsonl"), join(f.claude, ".credentials.json"),
        join(f.home, ".claude.json"), hostScratch], home: f.home, hostPid: process.pid })],
    }));
    try {
      // Mirrors launchWorker's env merge, deliberately reintroducing a host value at spawn time.
      const stdout = await new Promise<string>((resolve, reject) => {
        const child = spawn(prepared.command, prepared.args, {
          env: { ...process.env, ...prepared.env, FLOW_TOKEN: "reintroduced", NODE_OPTIONS: `--require ${injection}` },
          stdio: ["ignore", "pipe", "pipe", ...prepared.stdioFds],
        });
        let output = "", errors = "";
        child.stdout!.on("data", (chunk) => { output += chunk; });
        child.stderr!.on("data", (chunk) => { errors += chunk; });
        child.once("error", reject);
        child.once("close", (code) => code === 0 ? resolve(output) : reject(new Error(errors)));
      });
      assert.equal(stdout.trim(), "hidden");
    } finally { prepared.cleanup(); prepared.cleanup(); }
    assert.equal(existsSync(join(f.scope, "injected")), false);
    assert.equal(existsSync(join(f.home, "private")), false);
    assert.equal(readFileSync(join(f.flow, "token"), "utf8"), "host-token");
  });

  it("mounts only the selected Worktree beneath masked host state and leaves external Git metadata read-only", async (t) => {
    // A mkdtemp-owned fixture outside /tmp exercises real protected-state masks, not just the
    // scratch mount hiding everything. Cleanup only ever removes this unique fixture directory.
    const f = fixture(homedir()); t.after(f.cleanup);
    const scope = join(f.flow, "worktrees/repo/branch");
    const sibling = join(f.flow, "worktrees/repo/other");
    const git = join(f.outside, ".git");
    for (const dir of [scope, sibling, git]) mkdirSync(dir, { recursive: true });
    writeFileSync(join(sibling, "secret"), "other-worktree");
    writeFileSync(join(f.backend, "private"), "backend-context");
    writeFileSync(join(git, "HEAD"), "ref: refs/heads/branch");
    writeFileSync(join(scope, ".git"), `gitdir: ${git}\n`);
    const alias = join(f.root, "scope-alias"); symlinkSync(scope, alias);
    await node(f.options({ scope: alias, stateDir: f.backend, readablePaths: [git] }), String.raw`
      const f=require('fs'),a=require('assert/strict'),p=JSON.parse(process.argv[1]);
      a.equal(process.cwd(),p.scope);
      f.writeFileSync(p.scope+'/allowed','yes');
      for(const x of [p.token,p.sibling,p.transcript,p.originalBackend])a.throws(()=>f.readFileSync(x));
      a.equal(f.readFileSync('/tmp/flow-isolation/state/private','utf8'),'backend-context');
      a.equal(f.readFileSync(p.git+'/HEAD','utf8'),'ref: refs/heads/branch');
      a.throws(()=>f.writeFileSync(p.git+'/HEAD','bad'),{code:'EROFS'});
    `, { scope, token: join(f.flow, "token"), sibling: join(sibling, "secret"), git,
      transcript: join(f.flow, "sessions/one/transcript.jsonl"), originalBackend: join(f.backend, "private") });
    assert.equal(readFileSync(join(scope, "allowed"), "utf8"), "yes");
  });

  it("keeps initially missing credentials and configured state hidden after host creation", { timeout: 10_000 }, async (t) => {
    // Outside scratch: a read-only root bind would expose files created after launch.
    const f = fixture(homedir()); t.after(f.cleanup);
    const config = join(f.home, ".claude.json"); rmSync(config);
    const cloud = join(f.home, ".config/gcloud/credentials.db");
    const state = join(f.outside, "future-state/token");
    const hidden = [config, cloud, state];
    const prepared = await prepareFilesystemIsolation(f.options({ protectedPaths: [join(f.outside, "future-state")],
      args: ["-e", String.raw`
        const f=require('fs'),a=require('assert/strict'),paths=JSON.parse(process.argv[1]);
        for(const p of paths)a.throws(()=>f.readFileSync(p));
        process.stdout.write('ready\n');
        process.stdin.once('data',()=>{
          for(const p of paths)a.throws(()=>f.readFileSync(p),p);
          f.writeFileSync(process.cwd()+'/allowed','yes');
          process.exit(0);
        });
      `, JSON.stringify(hidden)] }));
    const child = spawn(prepared.command, prepared.args, { env: prepared.env,
      stdio: ["pipe", "pipe", "pipe", ...prepared.stdioFds] });
    const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
    let exited: Promise<void> | undefined;
    try {
      let errors = ''; child.stderr!.on('data', chunk => { errors += chunk; });
      exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(errors)));
      });
      void exited.catch(() => {}); // Observe teardown failures even if an earlier host assertion fails.
      await Promise.race([new Promise<void>(resolve => child.stdout!.once('data', () => resolve())), exited]);
      for (const path of hidden) {
        mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'new-host-secret');
      }
      child.stdin!.end('\n');
      await exited;
      assert.equal(readFileSync(join(f.scope, 'allowed'), 'utf8'), 'yes');
      for (const path of hidden) assert.equal(readFileSync(path, 'utf8'), 'new-host-secret');
    } finally { child.kill('SIGKILL'); await closed; await exited?.catch(() => {}); prepared.cleanup(); }
  });

  it("persists only the supplied backend directory for Revive and cleans ephemeral backend state", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    await node(f.options({ stateDir: f.backend }), String.raw`
      const f=require('fs'),d=process.env.PI_CODING_AGENT_SESSION_DIR; f.mkdirSync(d,{recursive:true}); f.writeFileSync(d+'/context','durable');
    `);
    await node(f.options({ stateDir: f.backend }), String.raw`
      require('assert/strict').equal(require('fs').readFileSync(process.env.PI_CODING_AGENT_SESSION_DIR+'/context','utf8'),'durable');
    `);
    assert.equal(readFileSync(join(f.backend, "sessions/context"), "utf8"), "durable");
    for (const stateDir of [f.flow, join(f.flow, "sessions"), join(f.flow, "sessions/one"), f.scope, f.home]) {
      await assert.rejects(prepareFilesystemIsolation(f.options({ stateDir })), /stateDir/);
    }
    for (const readablePaths of [[f.flow], [f.home], [f.root], [f.pi]]) {
      await assert.rejects(prepareFilesystemIsolation(f.options({ readablePaths })), /expose protected state/);
    }
    const prepared = await prepareFilesystemIsolation(f.options());
    const bind = prepared.args.indexOf(prepared.stateDir);
    const fd = prepared.stdioFds[Number(prepared.args[bind - 1]) - 3]!;
    const hostBackend = realpathSync(`/proc/self/fd/${fd}`);
    const hostScratch = join(hostBackend, "..");
    assert.ok(existsSync(hostBackend));
    prepared.cleanup(); prepared.cleanup();
    assert.equal(existsSync(hostBackend), false);
    assert.equal(existsSync(hostScratch), false);
    assert.ok(existsSync(f.backend));
  });

  it("stages narrow Pi credentials from an explicit agent directory, with read-only resources and no host transcripts", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const customPi = join(f.root, "configured-agent");
    mkdirSync(join(customPi, "skills"), { recursive: true });
    writeFileSync(join(customPi, "auth.json"), "custom-auth");
    writeFileSync(join(customPi, "models.json"), "custom-models");
    writeFileSync(join(customPi, "settings.json"), "custom-settings");
    writeFileSync(join(customPi, "transcript.jsonl"), "private");
    writeFileSync(join(customPi, "skills/skill.md"), "readonly-skill");
    await node(f.options({ credentials: "pi", env: { ...f.env, PI_CODING_AGENT_DIR: customPi } }), String.raw`
      const f=require('fs'),a=require('assert/strict'),p=JSON.parse(process.argv[1]),d=process.env.PI_CODING_AGENT_DIR;
      for(const [file,value]of [['auth.json','custom-auth'],['models.json','custom-models'],['settings.json','custom-settings']]) {
        a.equal(f.readFileSync(d+'/'+file,'utf8'),value);
        f.writeFileSync(d+'/'+file+'.new','refreshed');
        f.renameSync(d+'/'+file+'.new',d+'/'+file);
      }
      a.equal(f.readFileSync(d+'/skills/skill.md','utf8'),'readonly-skill');
      a.throws(()=>f.writeFileSync(d+'/skills/skill.md','bad'),{code:'EROFS'});
      a.throws(()=>f.readFileSync(d+'/transcript.jsonl'));
      a.throws(()=>f.readFileSync(p.original+'/auth.json'));
      f.writeFileSync(d+'/sdk-private','scratch');
    `, { original: customPi });
    assert.equal(existsSync(join(customPi, "sdk-private")), false);
    assert.equal(readFileSync(join(customPi, "auth.json"), "utf8"), "custom-auth");
    assert.equal(readFileSync(join(customPi, "settings.json"), "utf8"), "custom-settings");
  });

  it("never stages credentials beneath an operator TMPDIR inside writable Scope", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = f.scope;
    let prepared: Awaited<ReturnType<typeof prepareFilesystemIsolation>> | undefined;
    try {
      prepared = await prepareFilesystemIsolation(f.options({ credentials: "pi" }));
      assert.deepEqual(readdirSync(f.scope), []);
    } finally {
      prepared?.cleanup();
      if (saved === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = saved;
    }
  });

  for (const backend of ["pi", "claude"] as const) it(`rejects ${backend} resource directories containing protected host state`, async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const resource = join(backend === "pi" ? f.pi : f.claude, backend === "pi" ? "skills" : "commands");
    const state = join(resource, "host-state"); mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "token"), "private");
    await assert.rejects(prepareFilesystemIsolation(f.options({ credentials: backend, stateRoot: state })), /Unsafe .* resource/);
  });

  it("rejects credential/resource symlinks that could stage tokens or transcripts", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    rmSync(join(f.pi, "auth.json"));
    symlinkSync(join(f.flow, "token"), join(f.pi, "auth.json"));
    await assert.rejects(prepareFilesystemIsolation(f.options({ credentials: "pi" })), /non-symlink file/);
    rmSync(join(f.pi, "auth.json")); writeFileSync(join(f.pi, "auth.json"), "auth");
    mkdirSync(join(f.pi, "sessions"));
    symlinkSync(join(f.pi, "sessions"), join(f.pi, "skills"));
    await assert.rejects(prepareFilesystemIsolation(f.options({ credentials: "pi" })), /Unsafe Pi resource/);
  });

  it("stages Claude auth/config but no original transcripts", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    await node(f.options({ credentials: "claude", stateDir: f.backend }), String.raw`
      const f=require('fs'),a=require('assert/strict'),d=process.env.CLAUDE_CONFIG_DIR;
      a.equal(f.readFileSync(d+'/.credentials.json','utf8'),'{'+'"oauth":"credential"}');
      a.equal(f.readFileSync(process.env.HOME+'/.claude.json','utf8'),'{'+'"auth":"config"}');
      a.equal(f.readFileSync(d+'/.claude.json','utf8'),'{'+'"auth":"config"}');
      a.throws(()=>f.readFileSync(d+'/transcript.jsonl'));
      f.writeFileSync(d+'/.credentials.json.new','refreshed');
      f.renameSync(d+'/.credentials.json.new',d+'/.credentials.json');
      f.writeFileSync(d+'/projects/resume-marker','saved');
    `);
    assert.equal(readFileSync(join(f.claude, ".credentials.json"), "utf8"), '{"oauth":"credential"}');
    assert.equal(existsSync(join(f.backend, "claude/.credentials.json")), false);
    await node(f.options({ credentials: "claude", stateDir: f.backend }), String.raw`
      const f=require('fs'),a=require('assert/strict'),d=process.env.CLAUDE_CONFIG_DIR;
      a.equal(f.readFileSync(d+'/projects/resume-marker','utf8'),'saved');
      a.equal(f.readFileSync(d+'/.credentials.json','utf8'),'{'+'"oauth":"credential"}');
    `);
  });

  it("pins writable mount sources against Scope symlink swaps and consumes mount descriptors before exec", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    writeFileSync(join(f.home, "keep"), "intact");
    const prepared = await prepareFilesystemIsolation(f.options({ args: ["-e", `
      const f=require('fs'),a=require('assert/strict');
      f.writeFileSync('pinned-marker','approved inode');
      for(const fd of f.readdirSync('/proc/self/fd')) {
        try { a.equal(f.fstatSync(Number(fd)).isDirectory(),false,'inherited directory capability'); }
        catch(error) { if(error.code!=='ENOENT' && error.code!=='EBADF') throw error; }
      }
    `] }));
    try {
      const oldScope = join(f.root, "selected-inode");
      renameSync(f.scope, oldScope);
      symlinkSync(f.home, f.scope);
      const launch = filesystemStdioLaunch(prepared);
      await execute(launch.command, launch.args, { env: prepared.env, timeout: 15_000 });
      assert.equal(readFileSync(join(oldScope, "pinned-marker"), "utf8"), "approved inode");
      assert.equal(readFileSync(join(f.home, "keep"), "utf8"), "intact");
      assert.equal(existsSync(join(f.home, "pinned-marker")), false);
    } finally { prepared.cleanup(); }
  });

  it("preserves Node IPC fd3 and read-only runtime assets under masked /tmp", async (t) => {
    const f = fixture(); t.after(f.cleanup);
    const asset = join(f.root, "entry.cjs");
    writeFileSync(asset, "process.send({ready:true});process.on('message',m=>{process.send({echo:m});process.disconnect()});");
    const prepared = await prepareFilesystemIsolation(f.options({ ipc: true, args: [asset], readablePaths: [asset] }));
    try {
      assert.ok(prepared.args.includes("NODE_CHANNEL_FD"));
      await new Promise<void>((resolve, reject) => {
        const child = spawn(prepared.command, prepared.args, { env: prepared.env, detached: true,
          stdio: ["ignore", "ignore", "pipe", "ipc", ...prepared.stdioFds], serialization: "advanced" });
        const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("IPC timeout")); }, 10_000);
        let echoed = false;
        let diagnostics = "";
        child.stderr!.on("data", (chunk) => { diagnostics += chunk; });
        child.on("error", reject);
        child.on("message", (message) => {
          const m = message as { ready?: boolean; echo?: string };
          if (m.ready) child.send("hello");
          if (m.echo === "hello") echoed = true;
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0 && echoed) resolve(); else reject(new Error(`IPC failed (${code}): ${diagnostics}`));
        });
      });
    } finally { prepared.cleanup(); }
  });
});
