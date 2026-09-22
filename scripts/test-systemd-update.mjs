#!/usr/bin/env node
/**
 * REAL systemd updater integration test. Never run against a workstation or the live Flow host.
 *
 * Usage (disposable GitHub-hosted ubuntu-24.04 VM, setup-node Node 22, npm ci already done):
 *   FLOW_SYSTEMD_VM_TEST=1 node scripts/test-systemd-update.mjs
 * Optional: FLOW_SYSTEMD_TEST_ARTIFACTS=/absolute/artifact/directory
 * Upload build/systemd-update-test/ with actions/upload-artifact using `if: always()`.
 * Install the playwright npm library (no browser download); the browser probe uses the VM's
 * google-chrome, overridable with FLOW_TEST_CHROME. Allow ~25 minutes for the entire CI job.
 * No npm publishing, provider credentials, Docker, fake systemctl, or changes to existing Flow
 * services are required.
 *
 * Requires passwordless sudo, systemd as PID 1, polkit (pkcheck), npm, and network access to the
 * public npm registry for ordinary dependencies. All Flow installs/lifecycle scripts run as a new
 * unprivileged system account in its private prefix. Only setup/diagnostics/cleanup use sudo.
 * A loopback registry serves repacked builds of THIS checkout; the @nathanstephenson scope is
 * routed there with a private npmrc. No Flow release is fetched from the public registry.
 *
 * Coverage: authenticated web API confirmation/pinning despite latest-tag drift; real system
 * Type=simple User= host and separate Type=oneshot User= updater; MainPID/UID/cgroup ownership;
 * default KillMode=control-group and Restart=always; busy refusal; polkit stop refusal followed
 * by admission recovery; real npm HTTP failure + rollback; verified package whose foreground
 * startup fails + rollback; persistent Agent Session, cookie, HTTP endpoint and SSE reconnect.
 * The fake Backend Adapter holds a real host turn without an external model. HTTP/SSE assertions
 * cover each transaction; a final real Chromium Settings update verifies rendered success and
 * reconnection through scripts/systemd-update-browser.mjs, without manually reloading the page.
 *
 * Fault fixtures change only package version/build ID, add a postinstall UID/cgroup audit, and
 * (for the startup-failure version) exit 86 on `serve` while allowing fresh --version verification.
 * Host restart rate limiting is left at the real manager defaults. No administrator
 * reset-failed or restart is permitted to rescue a scenario under test.
 * Cleanup touches only this run's unique units, polkit rule, account and /var/tmp directory.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync,
  readFileSync, realpathSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// These checks MUST precede even mkdir/build/user creation. An opt-in alone is insufficient.
if (process.env.FLOW_SYSTEMD_VM_TEST !== '1' || process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.CI !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' ||
    process.env.RUNNER_OS !== 'Linux' || process.platform !== 'linux' || process.getuid?.() === 0) {
  throw new Error('REFUSING systemd test: requires FLOW_SYSTEMD_VM_TEST=1, a non-root GitHub-hosted Linux Actions CI runner, and a disposable ubuntu-24.04 VM. No changes made.');
}
assert.match(readFileSync('/etc/os-release', 'utf8'), /^ID=ubuntu$/m, 'Only disposable Ubuntu runners are supported');
assert.match(readFileSync('/etc/os-release', 'utf8'), /^VERSION_ID="24\.04"$/m, 'Use ubuntu-24.04');
assert.equal(readFileSync('/proc/1/comm', 'utf8').trim(), 'systemd', 'Must exercise real systemd, not a container shim');
assert.equal(Number(process.versions.node.split('.')[0]), 22, 'Use setup-node Node 22');

const repo = resolve(import.meta.dirname, '..');
const metadata = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
assert.equal(metadata.name, '@nathanstephenson/flow');
const id = randomUUID().replaceAll('-', '').slice(0, 12);
const user = `flowit${id}`;
const service = `flow-it-${id}.service`;
const updater = `flow-it-${id}-update.service`;
const rule = `/etc/polkit-1/rules.d/00-flow-it-${id}.rules`;
const units = [service, updater];
const artifacts = resolve(process.env.FLOW_SYSTEMD_TEST_ARTIFACTS ?? join(repo, 'build/systemd-update-test', id));
mkdirSync(artifacts, { recursive: true });
const temp = realpathSync(mkdtempSync('/var/tmp/flow-systemd-it-'));
chmodSync(temp, 0o755);
const work = join(temp, 'work');
mkdirSync(work, { mode: 0o755 });
const home = join(temp, 'home');
const state = join(home, 'state');
const prefix = join(home, 'prefix');
const scope = join(home, 'scope');
const slot = join(prefix, 'lib/node_modules', metadata.name);
const entry = join(slot, 'dist/cli/bootstrap.js');
const node = realpathSync(process.execPath);
const npm = realpathSync(join(dirname(node), 'npm'));
const path = `${prefix}/bin:${dirname(node)}:/usr/local/bin:/usr/bin:/bin`;
const versions = { base: '91.0.0', good: '91.0.1', npmFailure: '91.0.2', startupFailure: '91.0.3', decoy: '91.0.4', browser: '91.0.5' };
const builds = new Map();
const records = [];
const requests = [];
let uid, accountCreated = false, ruleCreated = false;
const installedUnits = [];
let cookie, endpoint, registry, registryUrl;
let latest = versions.good;
let driftOnNextCheck = false;
let gateVersion, releaseGate, gateHits = 0, gateTimedOut = false;
let stream, browserProbe;
let finished = false;
const controller = new AbortController();
const watchdog = setTimeout(() => controller.abort(new Error('Overall 25 minute test deadline exceeded')), 25 * 60_000);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort(new Error(`Received ${signal}`)));

function log(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stdout.write(line);
  appendFileSync(join(artifacts, 'harness.log'), line);
}
function save(name, value) {
  writeFileSync(join(artifacts, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
}
function redacted(value) {
  return JSON.parse(JSON.stringify(value, (key, item) => /token|capability/i.test(key) ? '[redacted]' : item));
}
async function run(command, args, options = {}) {
  const { quiet = false, cleanup = false, timeout = 60_000, cwd = temp, ...rest } = options;
  const result = await new Promise((resolvePromise, reject) => {
    execFile(command, args, {
      cwd, encoding: 'utf8', timeout, maxBuffer: 32 * 1024 * 1024,
      ...(cleanup ? {} : { signal: controller.signal }), ...rest,
    }, (error, stdout, stderr) => {
      if (!quiet) appendFileSync(join(artifacts, 'commands.log'),
        `$ ${command} ${args.join(' ')}\n${stdout}${stderr}\nexit=${error?.code ?? 0}\n`);
      if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
      else resolvePromise(stdout.trim());
    });
  });
  return result;
}
const sudo = (args, options) => run('/usr/bin/sudo', ['-n', '--', ...args], options);
const asUser = (command, args = [], options = {}) => {
  const { cwd = work, ...rest } = options;
  // The runner cannot chdir into the private service home before sudo executes. Change directory
  // only after dropping to the service account; all command/argument values stay positional.
  return run('/usr/bin/sudo', [
    '-n', '-u', user, '--', '/usr/bin/env', '-i', `HOME=${home}`, `USER=${user}`, `LOGNAME=${user}`,
    `PATH=${path}`, `FLOW_STATE_DIR=${state}`, `npm_config_prefix=${prefix}`,
    `npm_config_userconfig=${home}/.npmrc`, `npm_config_cache=${home}/npm-cache`,
    'npm_config_audit=false', 'npm_config_fund=false', 'npm_config_fetch_retries=0',
    'npm_config_fetch_timeout=60000', '/bin/sh', '-c', 'umask 077; cd "$1" && shift && exec "$@"',
    'flow-it-cwd', cwd, command, ...args,
  ], { ...rest, cwd: work });
};
const userJS = (code, args = [], options = {}) => asUser(node, ['--input-type=commonjs', '-e', code, ...args], { quiet: true, ...options });
const userFile = (file, options) => userJS('process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', [file], options);
const userJSON = async file => JSON.parse(await userFile(file));
const property = (unit, key) => run('/usr/bin/systemctl', ['--system', 'show', unit, `--property=${key}`, '--value'], { quiet: true });
async function poll(label, check, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    controller.signal.throwIfAborted();
    try { const result = await check(); if (result) return result; }
    catch (error) { last = error; }
    await delay(250, undefined, { signal: controller.signal });
  }
  throw new Error(`Timed out: ${label}${last ? `; last observation: ${last.stack ?? last}` : ''}`);
}
async function http(route, { method = 'GET', body, status = 200 } = {}) {
  const response = await fetch(`${endpoint}${route}`, {
    method, headers: { cookie, origin: endpoint, 'content-type': 'application/json',
      ...(route === '/api/host' ? { authorization: `Bearer ${cookie.slice('flow='.length)}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${route}: ${text}`);
  return { response, text, json: () => JSON.parse(text) };
}
const api = async (route, options) => (await http(route, options)).json();
const command = body => api('/api/command', { method: 'POST', body });
const submit = (version, status = 202) => api('/api/update', { method: 'POST', body: { confirmed: true, version }, status });
async function snapshot(label) {
  for (const unit of installedUnits) {
    try {
      save(`${label}-${unit}.journal.txt`, await sudo(['journalctl', '--no-pager', '-o', 'short-precise', '-u', unit], { cleanup: true, timeout: 20_000 }));
      save(`${label}-${unit}.show.txt`, await run('/usr/bin/systemctl', ['show', unit], { cleanup: true, timeout: 20_000 }));
    } catch (error) { log(`Diagnostic ${unit}: ${error.message}`); }
  }
  if (endpoint && cookie) {
    try { save(`${label}-update-status.json`, await api('/api/update')); } catch { /* Host may be intentionally down. */ }
  }
  if (accountCreated) {
    for (const file of ['daemon.json', 'web-update.json', 'systemd-update-request.json', 'npm-probes.jsonl', 'startup-failures.jsonl']) {
      try {
        const text = await userFile(join(state, file), { cleanup: true });
        save(`${label}-${file}`, file.endsWith('.json') ? redacted(JSON.parse(text)) : text);
      } catch { /* Some records are absent precisely when the transaction finished correctly. */ }
    }
  }
}
async function checkOwner(version, previous) {
  const host = await api('/api/host');
  assert.equal(host.version, version);
  assert.equal(host.mode, 'foreground');
  assert.equal(host.stopping, false);
  assert.equal(host.url, endpoint);
  assert.equal(host.settings.cwd, scope);
  assert.equal(host.settings.port, Number(new URL(endpoint).port));
  assert.equal(host.settings.address, '127.0.0.1');
  assert.equal(await property(service, 'MainPID'), String(host.pid));
  assert.equal(await property(service, 'User'), user);
  assert.equal(await property(service, 'Type'), 'simple');
  assert.equal(await property(service, 'KillMode'), 'control-group');
  assert.equal(await property(service, 'Restart'), 'always');
  assert.equal(await property(service, 'ActiveState'), 'active');
  assert.equal(await property(service, 'Job'), '');
  const status = readFileSync(`/proc/${host.pid}/status`, 'utf8');
  assert.match(status, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, 'm'));
  const args = readFileSync(`/proc/${host.pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  assert.deepEqual(args, [node, entry, ...hostArgs]);
  const group = await property(service, 'ControlGroup');
  assert.ok(group.endsWith(`/${service}`));
  assert.ok(readFileSync(`/proc/${host.pid}/cgroup`, 'utf8').includes(group));
  const owner = await userJSON(join(state, 'daemon.json'));
  assert.equal(owner.pid, host.pid);
  assert.equal(owner.token, cookie.slice('flow='.length), 'Browser cookie must survive updates');
  if (previous) {
    assert.notEqual(host.pid, previous.pid);
    assert.notEqual(host.instanceId, previous.instanceId);
    assert.deepEqual(host.settings, previous.settings);
    assert.equal(existsSync(`/proc/${previous.pid}`), false, 'Old foreground process must have exited');
  }
  records.push({ kind: 'owner', version, host, group, uid, args });
  return host;
}
async function settled(version, expectedState) {
  const result = await poll(`web operation ${expectedState}, restored ${version}`, async () => {
    const status = await api('/api/update');
    if (status.operation?.state === 'updating') return false;
    if (!['inactive', 'failed'].includes(await property(updater, 'ActiveState'))) return false;
    return status;
  }, 180_000);
  assert.equal(result.operation?.state, expectedState, JSON.stringify(result));
  assert.equal(result.installedVersion, version, JSON.stringify(result));
  assert.equal(result.eligibility.state, 'eligible', JSON.stringify(result));
  assert.equal(await property(updater, 'MainPID'), '0');
  const leftovers = JSON.parse(await userJS(`
    const fs = require('node:fs'), path = require('node:path');
    const state = process.argv[1], prefix = process.argv[2];
    const registry = path.join(prefix, '.flow-installations');
    const barriers = fs.readdirSync(registry).filter(name => fs.existsSync(path.join(registry, name, 'update.json')));
    console.log(JSON.stringify({ barriers, request: fs.existsSync(path.join(state, 'systemd-update-request.json')),
      capability: fs.existsSync(path.join(state, 'systemd-update-capability')) }));
  `, [state, prefix]));
  assert.deepEqual(leftovers, { barriers: [], request: false, capability: false });
  records.push({ kind: 'settled', result });
  return result;
}
async function setPolicy(allowStop) {
  const text = `polkit.addRule(function(action, subject) {
  if (subject.user !== ${JSON.stringify(user)}) return;
  if (action.id !== "org.freedesktop.systemd1.manage-units") return polkit.Result.NO;
  var unit = action.lookup("unit"), verb = action.lookup("verb");
  if ((unit === ${JSON.stringify(updater)} && verb === "start") ||
      (unit === ${JSON.stringify(service)} && (verb === "start"${allowStop ? ' || verb === "stop"' : ''}))) return polkit.Result.YES;
  return polkit.Result.NO;
});\n`;
  const source = join(work, 'policy.rules');
  writeFileSync(source, text);
  // A failed install may still leave a file; include it in cleanup from this point on.
  ruleCreated = true;
  await sudo(['install', '-o', 'root', '-g', 'root', '-m', '0644', source, rule]);
  save(`polkit-${allowStop ? 'normal' : 'deny-stop'}.rules`, text);
  await poll(`polkit has reloaded (stop allowed=${allowStop})`, async () => {
    const check = async verb => {
      try {
        // Modern polkit accepts action details only from trusted callers. Ask as root ABOUT
        // the unprivileged host process; real systemctl calls below still run as the test user.
        const pid = Number(await property(service, 'MainPID'));
        assert.ok(pid > 0);
        const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
        const started = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
        await sudo(['/usr/bin/pkcheck', '--action-id', 'org.freedesktop.systemd1.manage-units',
          '--process', `${pid},${started},${uid}`, '--detail', 'unit', service, '--detail', 'verb', verb],
        { quiet: true, timeout: 5000 });
        return true;
      } catch (error) { if (error.code === 1 || error.code === 2) return false; throw error; }
    };
    return await check('start') && (await check('stop')) === allowStop;
  }, 20_000);
}
async function beginStream(sessionId) {
  const abort = new AbortController();
  const response = await fetch(`${endpoint}/api/sessions/${sessionId}/events?since=0`, {
    headers: { cookie }, signal: AbortSignal.any([abort.signal, controller.signal]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const observed = { closed: false, bytes: 0, abort };
  observed.done = (async () => {
    try {
      for await (const chunk of response.body) observed.bytes += chunk.length;
    } catch (error) { observed.error = String(error); }
    finally { observed.closed = true; }
  })();
  await poll('SSE replay data', () => observed.bytes > 0, 10_000);
  return observed;
}

let hostArgs;
try {
  log(`Disposable test ${id}; artifacts: ${artifacts}`);
  save('environment.json', { id, user, service, updater, temp, prefix, state, node, npm, versions, commit: process.env.GITHUB_SHA });
  await sudo(['true']);
  await run('/usr/bin/systemctl', ['--version']);
  await run('/usr/bin/pkcheck', ['--version']);
  await sudo(['test', '-d', '/etc/polkit-1/rules.d']);
  await sudo(['useradd', '--system', '--user-group', '--no-create-home', '--home-dir', home, '--shell', '/usr/sbin/nologin', user]);
  accountCreated = true;
  uid = Number(await run('/usr/bin/id', ['-u', user]));
  assert.ok(uid > 0);
  for (const directory of [home, state, prefix, scope]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(state, 'config.json'), JSON.stringify({ workflowRuntime: { externalSandbox: false, nodePath: node } }), { mode: 0o600 });

  // Only the Flow scope is private. Normal dependencies go directly to npm, just like npm ci.
  registry = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const record = { at: new Date().toISOString(), method: request.method, pathname };
    requests.push(record);
    const json = body => {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    try {
      if (pathname === `/${metadata.name}/latest`) {
        record.version = latest;
        json({ name: metadata.name, version: latest });
        if (driftOnNextCheck) { driftOnNextCheck = false; latest = versions.decoy; }
      } else if (pathname === `/${metadata.name}`) {
        record.latest = latest;
        json({ name: metadata.name, 'dist-tags': { latest }, versions: Object.fromEntries(
          [...builds].map(([version, build]) => [version, {
            ...build.metadata, _id: `${metadata.name}@${version}`, dist: {
              tarball: `${registryUrl}/tarballs/${version}.tgz`,
              shasum: createHash('sha1').update(build.bytes).digest('hex'),
              integrity: `sha512-${createHash('sha512').update(build.bytes).digest('base64')}`,
            },
          }]),
        ) });
      } else if (pathname.startsWith('/tarballs/')) {
        const version = pathname.slice('/tarballs/'.length).replace(/\.tgz$/, '');
        record.version = version;
        assert.ok(builds.has(version), `Unknown fixture ${version}`);
        if (version === gateVersion) {
          gateHits++;
          await new Promise(resolvePromise => {
            const timer = setTimeout(() => { gateTimedOut = true; resolvePromise(); }, 45_000);
            releaseGate = () => { clearTimeout(timer); resolvePromise(); };
          });
        }
        if (version === versions.npmFailure) {
          record.failure = 'controlled HTTP 503';
          response.writeHead(503, { 'content-type': 'text/plain' });
          response.end('Deliberate systemd integration test tarball failure.\n');
        } else {
          const bytes = builds.get(version).bytes;
          response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': bytes.length });
          response.end(bytes);
        }
      } else {
        record.failure = 'unexpected registry path';
        response.writeHead(404); response.end('This registry only serves the local Flow fixture.');
      }
    } catch (error) {
      record.failure = String(error);
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  registry.requestTimeout = 60_000;
  await new Promise(resolvePromise => registry.listen(0, '127.0.0.1', resolvePromise));
  registryUrl = `http://127.0.0.1:${registry.address().port}`;
  writeFileSync(join(home, '.npmrc'), `registry=https://registry.npmjs.org/\n@nathanstephenson:registry=${registryUrl}/\n`, { mode: 0o600 });
  await sudo(['chown', '-R', `${user}:${user}`, home]);
  // Installation guards reject ancestors owned by a different non-root account. Keep the
  // prefix below root-owned temp + account-owned home, with runner-owned build work separate.
  await sudo(['chown', 'root:root', temp]);
  assert.equal(await asUser(node, ['--version']), process.version);
  await asUser(npm, ['--version']);
  assert.equal(await asUser(npm, ['prefix', '--global']), prefix);

  log('Building real distributable once (npm pack runs the normal prepack builds)');
  const packDir = join(work, 'packed'); mkdirSync(packDir);
  await run(npm, ['pack', '--pack-destination', packDir], { cwd: repo, timeout: 600_000 });
  const packed = (await import('node:fs')).readdirSync(packDir).filter(file => file.endsWith('.tgz'));
  assert.equal(packed.length, 1);
  const unpacked = join(work, 'unpacked'); mkdirSync(unpacked);
  await run('/usr/bin/tar', ['-xzf', join(packDir, packed[0]), '-C', unpacked]);
  const original = join(unpacked, 'package');
  const originalBuild = readFileSync(join(original, 'dist/build-id'), 'utf8').trim();
  for (const version of Object.values(versions)) {
    const directory = join(work, `fixture-${version}`);
    mkdirSync(directory);
    const fixture = join(directory, 'package'); cpSync(original, fixture, { recursive: true });
    const fixtureMetadata = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
    fixtureMetadata.version = version;
    fixtureMetadata.scripts = { postinstall: 'node dist/systemd-test-postinstall.cjs' };
    writeFileSync(join(fixture, 'package.json'), JSON.stringify(fixtureMetadata, null, 2));
    writeFileSync(join(fixture, 'dist/systemd-test-postinstall.cjs'), `
const fs = require('node:fs');
const version = require('../package.json').version;
if (!process.getuid()) throw new Error('The test npm lifecycle script must NEVER run as root');
fs.appendFileSync(process.env.FLOW_STATE_DIR + '/npm-probes.jsonl', JSON.stringify({
  version, uid: process.getuid(), pid: process.pid, cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8')
}) + '\\n');
`);
    const buildId = randomUUID();
    const bootstrapPath = join(fixture, 'dist/cli/bootstrap.js');
    let bootstrap = readFileSync(bootstrapPath, 'utf8');
    assert.ok(bootstrap.includes(originalBuild), 'Build ID must really be compiled into bootstrap');
    bootstrap = bootstrap.replaceAll(originalBuild, buildId);
    writeFileSync(join(fixture, 'dist/build-id'), buildId);
    if (version === versions.startupFailure) {
      const injection = `
if (process.argv[2] === 'serve') {
  const fs = await import('node:fs');
  fs.appendFileSync(process.env.FLOW_STATE_DIR + '/startup-failures.jsonl', JSON.stringify({
    version: ${JSON.stringify(version)}, uid: process.getuid(), pid: process.pid,
    cgroup: fs.readFileSync('/proc/self/cgroup', 'utf8')
  }) + '\\n');
  console.error('FLOW_SYSTEMD_TEST_STARTUP_FAILURE ${version}');
  process.exit(86);
}
`;
      const shebangEnd = bootstrap.startsWith('#!') ? bootstrap.indexOf('\n') + 1 : 0;
      bootstrap = bootstrap.slice(0, shebangEnd) + injection + bootstrap.slice(shebangEnd);
    }
    writeFileSync(bootstrapPath, bootstrap);
    // npm pack, not a handmade install tree: normal published-package selection and bin handling.
    await run(npm, ['pack', '--ignore-scripts', '--pack-destination', directory], { cwd: fixture });
    const archive = (await import('node:fs')).readdirSync(directory).find(file => file.endsWith('.tgz'));
    assert.ok(archive);
    builds.set(version, { metadata: fixtureMetadata, buildId, bytes: readFileSync(join(directory, archive)) });
  }
  save('fixtures.json', [...builds].map(([version, build]) => ({ version, buildId: build.buildId, bytes: build.bytes.length })));

  log('Installing baseline with real non-root npm through the private registry');
  await asUser(npm, ['install', '--global', '--omit=dev', `${metadata.name}@${versions.base}`], { cwd: '/', timeout: 600_000 });
  save('installation-paths.json', JSON.parse(await userJS(`
    const fs = require('node:fs'), p = require('node:path');
    const paths = []; let current = process.argv[1];
    for (;;) { const s = fs.lstatSync(current); paths.push({ path: current, uid: s.uid, mode: (s.mode & 0o7777).toString(8), symlink: s.isSymbolicLink() }); if (p.dirname(current) === current) break; current = p.dirname(current); }
    console.log(JSON.stringify({ uid: process.getuid(), paths }));
  `, [slot])));
  assert.equal(await asUser(node, [entry, '--version'], { cwd: scope }), versions.base);
  assert.equal(JSON.parse(await userJS('console.log(JSON.stringify(require("node:fs").statSync(process.argv[1]).uid))', [slot])), uid);

  // Reserve an unused fixed endpoint; release immediately before creating the isolated unit.
  const portReservation = createServer();
  await new Promise(resolvePromise => portReservation.listen(0, '127.0.0.1', resolvePromise));
  const port = portReservation.address().port;
  await new Promise(resolvePromise => portReservation.close(resolvePromise));
  endpoint = `http://127.0.0.1:${port}`;
  hostArgs = ['serve', '--port', String(port), '--address', '127.0.0.1'];
  await userJS('require("node:fs").writeFileSync(process.argv[1], process.argv[2], {mode: 0o600})', [
    join(state, 'systemd-update.json'), JSON.stringify({ scope: 'system', service, updater, hostArgs }),
  ]);
  const common = `User=${user}\nGroup=${user}\nWorkingDirectory=${scope}\n` + [
    `HOME=${home}`, `PATH=${path}`, `FLOW_STATE_DIR=${state}`, `npm_config_prefix=${prefix}`,
    `npm_config_userconfig=${home}/.npmrc`, `npm_config_cache=${home}/npm-cache`,
    'npm_config_audit=false', 'npm_config_fund=false', 'npm_config_fetch_retries=0',
    'npm_config_fetch_timeout=60000', `FLOW_UPDATE_REGISTRY_URL=${registryUrl}/${metadata.name}/latest`,
  ].map(value => `Environment=${value}\n`).join('');
  for (const unit of units) {
    const worker = unit === updater;
    const text = `[Unit]\nDescription=Disposable Flow updater integration ${id}\n\n[Service]\n` +
      `Type=${worker ? 'oneshot' : 'simple'}\n${common}` +
      `Environment=FLOW_SYSTEMD_${worker ? 'WORKER' : 'HOST'}=1\n` +
      `ExecStart=${node} ${entry} ${worker ? 'update' : hostArgs.join(' ')}\n` +
      `Restart=${worker ? 'no' : 'always'}\n${worker ? 'TimeoutStartSec=180\n' : 'RestartSec=1\n'}TimeoutStopSec=20\n`;
    const source = join(work, unit); writeFileSync(source, text); save(unit, text);
    installedUnits.push(unit);
    await sudo(['install', '-o', 'root', '-g', 'root', '-m', '0644', source, `/etc/systemd/system/${unit}`]);
  }
  await sudo(['systemctl', 'daemon-reload']);
  // One-time administrator startup, as documented. All update service-control remains non-root.
  await sudo(['systemctl', 'start', service]);
  await setPolicy(true);
  log('Verifying baseline control through REAL non-root systemctl and narrow polkit authority');
  await asUser('/usr/bin/systemctl', ['--system', '--no-ask-password', 'start', service]);
  await poll('baseline daemon identity', async () => {
    const identity = await userJSON(join(state, 'daemon.json'));
    cookie = `flow=${identity.token}`;
    return (await api('/api/host')).version === versions.base;
  });
  const baseline = await checkOwner(versions.base);
  const handoff = await fetch(`${endpoint}/auth?token=${encodeURIComponent(cookie.slice(5))}`, {
    redirect: 'manual', signal: AbortSignal.timeout(10_000),
  });
  assert.equal(handoff.status, 302);
  assert.equal(handoff.headers.get('set-cookie').split(';')[0], cookie);
  assert.equal((await fetch(`${endpoint}/api/update`, { signal: AbortSignal.timeout(10_000) })).status, 401);
  const html = (await http('/')).text;
  assert.match(html, /<html/);
  const asset = /src="([^"]+\.js)"/.exec(html)?.[1]; assert.ok(asset);
  assert.match((await http(asset)).response.headers.get('content-type'), /javascript/);
  const baselineUpdate = await api('/api/update?refresh=1');
  save('01-baseline-update-status.json', baselineUpdate);
  assert.equal(baselineUpdate.latestVersion, versions.good);
  assert.equal(baselineUpdate.eligibility.state, 'eligible', JSON.stringify(baselineUpdate));
  // No restart privilege: a regression in this rule can only restart this disposable host.
  await assert.rejects(asUser('/usr/bin/systemctl', ['--system', '--no-ask-password', 'restart', service]), /Command failed/);
  assert.equal((await api('/api/host')).pid, baseline.pid);
  await snapshot('01-baseline');

  log('Busy work refuses the WEB update without stopping the host or its event stream');
  await command({ type: 'create', scope, backend: 'fake' });
  const sessions = await api('/api/sessions'); assert.equal(sessions.length, 1);
  const sessionId = sessions[0].id;
  await command({ type: 'send', sessionId, text: 'systemd integration: hold this real host turn', when: 'now' });
  stream = await beginStream(sessionId);
  await poll('active-work eligibility block', async () => (await api('/api/update')).eligibility.state === 'blocked');
  const beforeBusy = requests.filter(r => r.pathname.startsWith('/tarballs/')).length;
  const busy = await submit(versions.good, 409);
  assert.match(busy.error, /active|finish/i);
  assert.equal((await api('/api/host')).pid, baseline.pid);
  assert.equal(await property(updater, 'MainPID'), '0');
  assert.equal(requests.filter(r => r.pathname.startsWith('/tarballs/')).length, beforeBusy);
  assert.equal(stream.closed, false);
  await command({ type: 'abort', sessionId });
  await poll('idle again', async () => (await api('/api/update')).eligibility.state === 'eligible');
  records.push({ kind: 'busy-refusal', result: busy });
  await snapshot('02-busy-refusal');

  log('Denying ONLY host stop via polkit; worker must fail safely and reopen host admission');
  await setPolicy(false);
  await submit(versions.good);
  const permission = await settled(versions.base, 'failed');
  assert.match(permission.operation.message, /accepting requests again/i);
  assert.equal(requests.filter(r => r.pathname.startsWith('/tarballs/')).length, beforeBusy);
  assert.equal((await checkOwner(versions.base)).pid, baseline.pid);
  assert.equal((await api('/api/host')).instanceId, baseline.instanceId);
  assert.equal(stream.closed, false, 'Permission refusal must not disconnect the browser');
  // A readable HTTP endpoint alone would miss admission remaining closed. Start a new real turn.
  await command({ type: 'send', sessionId, text: 'admission is open after denied stop', when: 'now' });
  await poll('admission accepted a new turn', async () => (await api('/api/update')).eligibility.state === 'blocked');
  await command({ type: 'abort', sessionId });
  await poll('idle after resumed admission', async () => (await api('/api/update')).eligibility.state === 'eligible');
  await setPolicy(true);
  await snapshot('03-permission-refusal');

  log('Successful WEB update; tag changes after confirmation, pinned tarball pauses with host stopped');
  gateVersion = versions.good;
  driftOnNextCheck = true;
  const accepted = await submit(versions.good);
  assert.equal(accepted.operation.targetVersion, versions.good);
  await poll('pinned tarball requested', () => gateHits > 0, 60_000);
  assert.equal(latest, versions.decoy);
  assert.equal(await property(service, 'MainPID'), '0');
  assert.equal(await property(service, 'ActiveState'), 'inactive');
  assert.equal(existsSync(`/proc/${baseline.pid}`), false);
  const workerPid = Number(await property(updater, 'MainPID'));
  assert.ok(workerPid > 0);
  assert.equal(await property(updater, 'Type'), 'oneshot');
  assert.equal(await property(updater, 'User'), user);
  assert.equal(await property(updater, 'KillMode'), 'control-group');
  const workerGroup = await property(updater, 'ControlGroup');
  assert.ok(workerGroup.endsWith(`/${updater}`));
  const workerStatus = readFileSync(`/proc/${workerPid}/status`, 'utf8');
  assert.match(workerStatus, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, 'm'));
  assert.deepEqual(readFileSync(`/proc/${workerPid}/cmdline`, 'utf8').split('\0').filter(Boolean), [node, entry, 'update']);
  const cgroupPids = readFileSync(`/sys/fs/cgroup${workerGroup}/cgroup.procs`, 'utf8').trim().split(/\s+/).map(Number);
  const processes = cgroupPids.map(pid => ({ pid, args: readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' '),
    status: readFileSync(`/proc/${pid}/status`, 'utf8'), cgroup: readFileSync(`/proc/${pid}/cgroup`, 'utf8') }));
  assert.ok(processes.some(p => p.pid !== workerPid && /npm/.test(p.args)), 'Actual npm must survive in the updater cgroup');
  for (const p of processes) {
    assert.match(p.status, new RegExp(`^Uid:\\s+${uid}\\s+${uid}\\s+${uid}\\s+${uid}$`, 'm'));
    assert.ok(p.cgroup.includes(workerGroup));
  }
  const request = await userJSON(join(state, 'systemd-update-request.json'));
  assert.equal(request.version, versions.good);
  assert.equal(request.force, false);
  assert.equal(request.id, accepted.operation.id);
  save('04-updater-survival.json', { workerPid, workerGroup, processes, request });
  await poll('old browser SSE disconnected', () => stream.closed, 10_000);
  // Restart=always must NOT resurrect the explicitly stopped service while npm owns the prefix.
  await delay(1500, undefined, { signal: controller.signal });
  assert.equal(await property(service, 'MainPID'), '0');
  assert.equal(await property(updater, 'MainPID'), String(workerPid));
  assert.equal(gateTimedOut, false);
  releaseGate(); gateVersion = undefined;
  const success = await settled(versions.good, 'succeeded');
  assert.equal(success.operation.targetVersion, versions.good);
  assert.equal(success.operation.installedVersion, versions.good);
  const upgraded = await checkOwner(versions.good, baseline);
  assert.equal(await property(updater, 'Result'), 'success');
  assert.equal(requests.some(r => r.pathname === `/tarballs/${versions.decoy}.tgz`), false, 'Never install a changed latest tag');
  assert.equal((await api('/api/sessions')).find(s => s.id === sessionId)?.status, 'dormant');
  const reconnected = await beginStream(sessionId);
  reconnected.abort.abort(); await reconnected.done;
  assert.match((await http('/')).text, /<html/);
  await http(asset);
  await snapshot('04-success');

  log('Real npm tarball HTTP 503 must reinstall and verify the prior version, then restore the same endpoint');
  latest = versions.npmFailure;
  await submit(versions.npmFailure);
  const installFailure = await settled(versions.good, 'failed');
  assert.match(installFailure.operation.message, /npm installation failed/i);
  assert.match(installFailure.operation.message, /Reinstalled and verified 91\.0\.1/);
  assert.ok(requests.some(r => r.version === versions.npmFailure && r.failure === 'controlled HTTP 503'));
  const afterNpmFailure = await checkOwner(versions.good, upgraded);
  assert.equal(await property(updater, 'Result'), 'exit-code');
  await snapshot('05-npm-rollback');

  log('Fresh version verification succeeds, but broken new foreground startup must roll back through systemd');
  latest = versions.startupFailure;
  await submit(versions.startupFailure);
  const startupFailure = await settled(versions.good, 'failed');
  assert.match(startupFailure.operation.message, /startup timed out/i);
  assert.match(startupFailure.operation.message, /Reinstalled and verified 91\.0\.1/);
  const restored = await checkOwner(versions.good, afterNpmFailure);
  const attempts = (await userFile(join(state, 'startup-failures.jsonl'))).split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(attempts.length >= 1, 'New version must actually attempt foreground startup');
  for (const attempt of attempts) {
    assert.equal(attempt.version, versions.startupFailure);
    assert.equal(attempt.uid, uid);
    assert.ok(attempt.cgroup.includes(`/${service}`));
    assert.equal(existsSync(`/proc/${attempt.pid}`), false);
  }
  const probes = (await userFile(join(state, 'npm-probes.jsonl'))).split('\n').filter(Boolean).map(JSON.parse);
  assert.ok(probes.some(p => p.version === versions.base));
  assert.ok(probes.some(p => p.version === versions.startupFailure), 'Broken startup package must have installed successfully');
  assert.ok(probes.filter(p => p.version === versions.good).length >= 3, 'Successful install and both real rollback installations must execute npm lifecycle scripts');
  for (const probe of probes) {
    assert.equal(probe.uid, uid, 'No root npm lifecycle scripts');
    if (probe.version !== versions.base) assert.ok(probe.cgroup.includes(`/${updater}`));
  }
  assert.equal((await userJSON(join(slot, 'package.json'))).version, versions.good);
  assert.equal(await userFile(join(slot, 'dist/build-id')), builds.get(versions.good).buildId);
  assert.equal((await api('/api/sessions')).some(s => s.id === sessionId), true);
  await command({ type: 'create', scope, backend: 'fake' });
  assert.equal((await api('/api/host')).pid, restored.pid);
  save('06-npm-lifecycle-audit.json', probes);
  save('06-startup-failure-audit.json', attempts);
  await snapshot('06-startup-rollback');

  log('Real Chromium Settings confirmation and automatic UI reconnect after another actual systemd update');
  latest = versions.browser;
  const { beginBrowserUpdate } = await import('./systemd-update-browser.mjs');
  browserProbe = await beginBrowserUpdate({ url: endpoint, token: cookie.slice(5), version: versions.browser,
    artifactDir: join(artifacts, 'browser') });
  const browserResult = await browserProbe.waitForSuccess(180_000);
  const browserOperation = await settled(versions.browser, 'succeeded');
  assert.equal(browserOperation.operation.targetVersion, versions.browser);
  await checkOwner(versions.browser, restored);
  assert.equal((await api('/api/sessions')).some(s => s.id === sessionId), true);
  records.push({ kind: 'browser-settings-reconnect', result: browserResult });
  await browserProbe.close(); browserProbe = undefined;
  await snapshot('07-browser-success');
  finished = true;
  log('PASS: real systemd ownership, web pinning/reconnect, busy/permission refusal, npm rollback, startup rollback, Chromium Settings reconnect');
} catch (error) {
  log(`FAIL: ${error.stack ?? error}`);
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
  releaseGate?.();
  stream?.abort.abort();
  try { await browserProbe?.close(); } catch (error) { log(`Browser cleanup: ${error.message}`); }
  await snapshot('final');
  save('registry-requests.json', requests);
  save('assertions.json', records);
  if (accountCreated) {
    try {
      const npmLogs = await userJS(`
        const fs = require('node:fs'), path = require('node:path');
        const directory = path.join(process.argv[1], 'npm-cache/_logs');
        console.log(JSON.stringify(fs.existsSync(directory) ? Object.fromEntries(fs.readdirSync(directory)
          .filter(name => name.endsWith('.log')).map(name => [name, fs.readFileSync(path.join(directory, name), 'utf8')])) : {}));
      `, [home], { cleanup: true });
      save('npm-logs.json', JSON.parse(npmLogs));
    } catch (error) { log(`npm log collection failed: ${error.message}`); }
  }
  let cleanupOK = true;
  async function clean(args) {
    try { await sudo(args, { cleanup: true, timeout: 60_000 }); return true; }
    catch (error) { cleanupOK = false; log(`Cleanup failed: ${args.join(' ')}: ${error.message}`); return false; }
  }
  // Stop updater FIRST: never remove a prefix or allow rollback to race cleanup.
  let stopped = true;
  for (const unit of [updater, service].filter(unit => installedUnits.includes(unit))) {
    if (!await clean(['systemctl', 'stop', unit])) stopped = false;
  }
  if (stopped) {
    for (const unit of installedUnits) {
      await clean(['rm', '-f', `/etc/systemd/system/${unit}`]);
      // reset-failed is not required for an already successful unit and may return nonzero.
      try { await sudo(['systemctl', 'reset-failed', unit], { cleanup: true }); } catch {}
    }
    if (installedUnits.length) await clean(['systemctl', 'daemon-reload']);
    if (ruleCreated) await clean(['rm', '-f', rule]);
    if (accountCreated) await clean(['userdel', user]);
    assert.ok(temp.startsWith('/var/tmp/flow-systemd-it-') && temp !== '/var/tmp/flow-systemd-it-');
    await clean(['rm', '-rf', '--', temp]);
  } else {
    cleanupOK = false;
    log(`Retaining ${temp} and test configuration because a unit did not stop. Destroy this disposable VM.`);
  }
  registry?.closeAllConnections();
  if (registry) await new Promise(resolvePromise => registry.close(resolvePromise));
  save('summary.json', { passed: finished && cleanupOK, assertionsPassed: finished, cleanupOK, id, user, units,
    caveats: ['Fake Backend Adapter only for deterministic busy work; real built host, npm, polkit, and systemd.',
      'Startup fixture modifies bootstrap only to exit on serve; manager restart rate limits remain enabled.',
      'No power-loss/SIGKILL/rollback-registry-outage guarantee; dependency resolution still needs public npm.'] });
  if (!cleanupOK) process.exitCode = 1;
  log(`Artifacts: ${artifacts}`);
}
