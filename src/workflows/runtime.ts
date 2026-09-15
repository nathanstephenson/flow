import { spawn } from 'node:child_process';
import { constants, mkdirSync, openSync, closeSync, readSync, writeFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import ts from 'typescript';
import { getQuickJS } from 'quickjs-emscripten';
import { libraries } from './runtime-libs.ts';

const LIMIT = 100_000;
const controller = new AbortController();
let stop = () => { controller.abort(); };
let lease = setTimeout(() => stop(), 3000);
const lines = createInterface({ input: process.stdin });
let started = false;
lines.on('close', () => stop());
lines.on('line', line => {
  clearTimeout(lease);
  lease = setTimeout(() => stop(), 3000);
  if (started) return;
  started = true;
  void (process.argv.includes('--docker-supervisor') ? dockerSupervisor(JSON.parse(line)) : run(JSON.parse(line))).then(output => finish({ output }), error => finish({ error: error instanceof Error ? error.message : String(error) }));
});
function finish(result: unknown) {
  clearTimeout(lease);
  process.stdout.write(JSON.stringify(result) + '\n', () => process.exit(0));
}

async function dockerSupervisor(config: { docker: string; args: string[]; name: string; request: { timeout: number } }) {
  const child = spawn(config.docker, config.args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', error = '', stopped = false;
  stop = () => { stopped = true; controller.abort(); child.kill('SIGKILL'); };
  const deadline = setTimeout(stop, config.request.timeout);
  child.stdin.on('error', () => {});
  child.stdin.write(JSON.stringify(config.request) + '\n');
  const heartbeat = setInterval(() => { if (!stopped) child.stdin.write('\n'); }, 500);
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 1_000_000) stop(); });
  child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000); });
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (stopped || code !== 0) throw new Error(`Docker runtime stopped (${code}): ${error}`);
    const result = JSON.parse(output);
    if (Object.hasOwn(result, 'error')) throw new Error(result.error);
    return result.output;
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline); clearTimeout(lease);
    await new Promise<void>((resolve, reject) => {
      const cleanup = spawn(config.docker, ['--host', 'unix:///var/run/docker.sock', 'rm', '--force', config.name], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 5000, killSignal: 'SIGKILL' });
      let error = '';
      cleanup.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000); });
      cleanup.once('error', reject);
      cleanup.once('close', code => code === 0 || error.includes('No such container') ? resolve() : reject(new Error(`Docker container cleanup failed: ${error}`)));
    });
  }
}

async function run(request: { kind: string; scope: string; command?: string; code?: string; input: unknown; inputType: string; outputType: string; secrets: Record<string, string>; timeout: number }) {
  const timer = setTimeout(() => stop(), request.timeout);
  try {
    if (request.kind === 'shell') return await shell(request);
    return process.argv.includes('--guest') ? await guest(request) : await supervisedGuest(request);
  } finally { clearTimeout(timer); }
}

function supervisedGuest(request: unknown) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=128', process.argv[1]!, '--guest'], { env: { PATH: '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    stop = () => { if (controller.signal.aborted) return; controller.abort(); child.stdin.end(); killTimer = setTimeout(() => child.kill('SIGKILL'), 500); };
    let output = '', error = '';
    child.stdin.on('error', () => {});
    child.stdin.write(JSON.stringify(request) + '\n');
    const heartbeat = setInterval(() => { if (!controller.signal.aborted) child.stdin.write('\n'); }, 500);
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); if (output.length > 1_000_000) stop(); });
    child.stderr.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000); });
    child.once('error', reject);
    child.once('close', code => {
      clearInterval(heartbeat); clearTimeout(killTimer);
      if (code !== 0 || controller.signal.aborted) { reject(new Error(`Guest stopped: ${error}`)); return; }
      try { const result = JSON.parse(output); if (result.error) reject(new Error(result.error)); else resolve(result.output); } catch (error) { reject(error); }
    });
  });
}

function shell(request: { scope: string; command?: string; input: unknown; secrets: Record<string, string> }) {
  return new Promise((resolveResult, reject) => {
    const child = spawn('/bin/bash', ['--noprofile', '--norc', '-c', request.command!], {
      cwd: request.scope, detached: true, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8', OUTPUT: JSON.stringify(request.input), ...request.secrets }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '', failed = false;
    const kill = () => { if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } } };
    stop = () => { failed = true; controller.abort(); kill(); };
    for (const [stream, name] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream.on('data', (data: Buffer) => {
      if (name === 'stdout') stdout += data.toString(); else stderr += data.toString();
      if (stdout.length + stderr.length > LIMIT) { stdout = stdout.slice(0, LIMIT); stderr = stderr.slice(0, LIMIT - stdout.length); stop(); }
    });
    child.on('error', reject);
    child.on('exit', kill);
    child.on('close', code => failed ? reject(new Error('Shell stopped or output limit exceeded')) : resolveResult({ stdout, stderr, exitCode: code ?? 128 }));
  });
}

function compile(code: string, inputType: string, outputType: string, names: string[]) {
  if (code.length > LIMIT) throw new Error('Code limit exceeded');
  const source = `declare const input: ${inputType};\ndeclare const secrets: {${names.map(name => `${JSON.stringify(name)}: string`).join(';')}};\ndeclare const fs: { readText(path: string): Promise<string>; writeText(path: string, text: string): Promise<void>; mkdir(path: string): Promise<void> };\ndeclare function fetch(url: string, options?: {method?: string; headers?: Record<string,string>; body?: string}): Promise<{status: number; ok: boolean; body: string; text(): Promise<string>; json(): Promise<unknown>}>;\nasync function main(): Promise<${outputType}> {\n${code}\n}\nmain();`;
  const file = ts.createSourceFile('/guest.ts', source, ts.ScriptTarget.ES2020, true);
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isImportEqualsDeclaration(node) || ts.isImportTypeNode(node) || node.kind === ts.SyntaxKind.ImportKeyword) throw new Error('Imports are not supported');
    ts.forEachChild(node, visit);
  };
  visit(file);
  const options: ts.CompilerOptions = { strict: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None, types: [], noEmitOnError: true, skipLibCheck: true };
  let javascript = '';
  const host: ts.CompilerHost = {
    getSourceFile: path => path === '/guest.ts' ? file : libraries[path.replace(/^\//, '')] === undefined ? undefined : ts.createSourceFile(path, libraries[path.replace(/^\//, '')]!, ts.ScriptTarget.ES2020, true),
    getDefaultLibFileName: () => '/lib.es2020.d.ts', writeFile: (_path, text) => { javascript = text; }, getCurrentDirectory: () => '/', getDirectories: () => [], fileExists: path => path === '/guest.ts' || libraries[path.replace(/^\//, '')] !== undefined,
    readFile: path => libraries[path.replace(/^\//, '')], getCanonicalFileName: path => path, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
  };
  const program = ts.createProgram(['/guest.ts'], options, host);
  const errors = ts.getPreEmitDiagnostics(program);
  if (errors.length) throw new Error(ts.flattenDiagnosticMessageText(errors[0]!.messageText, '\n'));
  program.emit();
  return javascript;
}

async function guest(request: { scope: string; code?: string; input: unknown; inputType: string; outputType: string; secrets: Record<string, string>; timeout: number }) {
  const deadline = Date.now() + request.timeout;
  const redactError = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const secret of Object.values(request.secrets)) if (secret) text = text.split(secret).join('[REDACTED]');
      return text;
    }
    if (Array.isArray(value)) return value.map(redactError);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactError(key), redactError(item)]));
    return value;
  };
  const errorText = (value: unknown): string => JSON.stringify(redactError(value)) ?? 'Guest execution failed';
  const code = compile(request.code!, request.inputType, request.outputType, Object.keys(request.secrets));
  const root = realpathSync(request.scope);
  const descriptors = process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd';
  const scoped = <T>(path: string, createDirectories: boolean, use: (path: string) => T): T => {
    if (!path || isAbsolute(path) || path.includes('\0')) throw new Error('Path must be Scope-relative');
    const rel = relative(root, resolve(root, path));
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Path escapes Scope');
    const parts = rel.split('/').filter(Boolean);
    const leaf = createDirectories ? '.' : parts.pop() ?? '.';
    let fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      for (const part of parts) {
        const next = `${descriptors}/${fd}/${part}`;
        if (createDirectories) {
          try { mkdirSync(next, { mode: 0o700 }); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
        }
        const child = openSync(next, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        closeSync(fd); fd = child;
      }
      return use(`${descriptors}/${fd}/${leaf}`);
    } finally { closeSync(fd); }
  };
  const operations: Record<string, (...args: any[]) => Promise<unknown>> = {
    readText: async (path: string) => {
      const fd = scoped(path, false, target => openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try { const buffer = Buffer.alloc(LIMIT + 1); const size = readSync(fd, buffer, 0, buffer.length, 0); if (size > LIMIT) throw new Error('File limit exceeded'); return buffer.subarray(0, size).toString(); } finally { closeSync(fd); }
    },
    writeText: async (path: string, text: string) => {
      if (typeof text !== 'string' || Buffer.byteLength(text) > LIMIT) throw new Error('File limit exceeded');
      const fd = scoped(path, false, target => openSync(target, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600));
      try { writeFileSync(fd, text); } finally { closeSync(fd); }
    },
    mkdir: async (path: string) => { scoped(path, true, () => {}); },
    fetch: async (address: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
      let url = new URL(address);
      for (let redirects = 0; redirects <= 5; redirects++) {
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) is supported');
        const response = await fetch(url, { ...options, redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.has('location')) {
          await response.body?.cancel();
          const next = new URL(response.headers.get('location')!, url);
          if (next.origin !== url.origin) options = { ...options, headers: {} };
          if (response.status === 303 || ((response.status === 301 || response.status === 302) && options.method === 'POST')) { options = { ...options, method: 'GET' }; delete options.body; }
          url = next; continue;
        }
        let size = 0; const chunks: Uint8Array[] = [];
        if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > LIMIT) { controller.abort(); throw new Error('Response limit exceeded'); } chunks.push(chunk); }
        return { status: response.status, body: Buffer.concat(chunks).toString() };
      }
      throw new Error('Redirect limit exceeded');
    },
  };
  const module = await getQuickJS();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(32 * 1024 * 1024);
  runtime.setMaxStackSize(512 * 1024);
  runtime.setInterruptHandler(() => controller.signal.aborted || Date.now() > deadline);
  const vm = runtime.newContext();
  const pending = new Set<Promise<void>>();
  let calls = 0;
  const bridge = vm.newFunction('__call', (name, args) => {
    if (++calls > 1000 || pending.size >= 32 || controller.signal.aborted) throw new Error('Operation limit exceeded');
    const operation = Object.hasOwn(operations, vm.getString(name)) ? operations[vm.getString(name)] : undefined;
    if (!operation) throw new Error('Unknown operation');
    const encoded = vm.getString(args);
    if (Buffer.byteLength(encoded) > LIMIT) throw new Error('Operation input limit exceeded');
    const values = JSON.parse(encoded);
    if (!Array.isArray(values)) throw new Error('Operation arguments must be an array');
    const promise = vm.newPromise();
    const work = Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(...values); }).then(value => {
      const handle = vm.newString(JSON.stringify(value ?? null)); promise.resolve(handle); handle.dispose();
    }, error => { const handle = vm.newError(String(error)); promise.reject(handle); handle.dispose(); }).finally(() => { pending.delete(work); promise.dispose(); });
    pending.add(work);
    return promise.handle;
  });
  vm.setProp(vm.global, '__call', bridge); bridge.dispose();
  try {
    const setup = vm.evalCode(`const input = JSON.parse(${JSON.stringify(JSON.stringify(request.input))}); const secrets = JSON.parse(${JSON.stringify(JSON.stringify(request.secrets))}); const fs = Object.freeze(Object.fromEntries(['readText','writeText','mkdir'].map(name => [name, async (...args) => JSON.parse(await __call(name, JSON.stringify(args)))]))); const fetch = async (...args) => { const result = JSON.parse(await __call('fetch', JSON.stringify(args))); return Object.freeze({ ...result, ok: result.status >= 200 && result.status < 300, text: async () => result.body, json: async () => JSON.parse(result.body) }); };`);
    vm.unwrapResult(setup).dispose();
    const result = vm.unwrapResult(vm.evalCode(code));
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const jobs = runtime.executePendingJobs();
        if (jobs.error) { const error = vm.dump(jobs.error); jobs.error.dispose(); throw new Error(errorText(error)); }
        const state = vm.getPromiseState(result);
        if (state.type === 'fulfilled') {
          const stringify = vm.unwrapResult(vm.evalCode('(value) => { const text = JSON.stringify(value, (_key, item) => { if (item === undefined || typeof item === "function" || typeof item === "symbol" || typeof item === "bigint" || (typeof item === "number" && !Number.isFinite(item))) throw Error("Output must be JSON"); return item; }); if (text === undefined) throw Error("Output must be JSON"); return text; }'));
          try { const encoded = vm.unwrapResult(vm.callFunction(stringify, vm.undefined, state.value)); try { const text = vm.getString(encoded); if (Buffer.byteLength(text) > LIMIT) throw new Error('Output limit exceeded'); return JSON.parse(text); } finally { encoded.dispose(); } } finally { stringify.dispose(); state.value.dispose(); }
        }
        if (state.type === 'rejected') { const error = vm.dump(state.error); state.error.dispose(); throw new Error(errorText(error)); }
        if (!pending.size) throw new Error('Guest promise cannot settle');
        await Promise.race(pending);
      }
    } finally { result.dispose(); }
  } finally {
    controller.abort();
    await Promise.allSettled(pending);
    vm.dispose(); runtime.dispose();
  }
}
