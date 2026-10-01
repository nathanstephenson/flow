import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { Json, VisualSchema, WorkflowStep } from '../protocol/workflows.ts';
import type { ExecutorContext, WorkflowExecutor, WorkflowExecutors } from './scheduler.ts';
import { parseValue, toTypeScript } from './schema.ts';
import { prepareFilesystemIsolation, validateFilesystemScope, type FilesystemIsolation } from '../isolation/filesystem.ts';

export interface CodeExecutorOptions {
  runtimePath: string;
  nodePath: string;
  /** Host-resolved launch policy. Defaults to restricted; no fallback on preparation failure. */
  isolationEnabled?: boolean;
  /** The owning Session Host state root, including programmatically configured roots. */
  stateRoot?: string;
  /** Known before availability probes in production Workflow Executions. */
  scope?: string;
  resolveSecret?: (reference: string, signal: AbortSignal) => Promise<string>;
}
const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };

type Executors = Required<Pick<WorkflowExecutors, 'shell' | 'typescript'>>;

function probe(command: string, args: string[], stdioFds: number[] = [], env: NodeJS.ProcessEnv = environment): Promise<boolean> {
  if (!isAbsolute(command)) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'ignore', 'ignore', ...stdioFds] });
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

export async function createCodeExecutors(options: CodeExecutorOptions): Promise<Executors> {
  const isolationEnabled = options.isolationEnabled ?? true;
  function canonicalScope(scope: string): string {
    if (isolationEnabled) return validateFilesystemScope({ scope, expectedScope: resolve(scope),
      ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}) });
    const canonical = realpathSync(scope);
    if (!statSync(canonical).isDirectory()) throw new Error('Scope must be a directory');
    return canonical;
  }
  if (options.scope) canonicalScope(options.scope);
  let boundaryError: string | undefined;
  async function probeNode(): Promise<boolean> {
    const args = ['-e', 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'];
    if (!isolationEnabled) return probe(options.nodePath, args);
    const scope = mkdtempSync(join(realpathSync('/tmp'), 'flow-runtime-probe-'));
    let isolation: FilesystemIsolation | undefined;
    try {
      isolation = await prepareFilesystemIsolation({ scope, command: options.nodePath, args, credentials: 'none',
        env: { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...environment,
          FLOW_BWRAP_PATH: process.env.FLOW_BWRAP_PATH }, readablePaths: [options.nodePath],
        ...(options.stateRoot ? { stateRoot: options.stateRoot } : {}) });
      return await probe(isolation.command, isolation.args, isolation.stdioFds, isolation.env);
    } catch (error) { boundaryError = (error as Error).message; return false; }
    finally { isolation?.cleanup(); rmSync(scope, { recursive: true, force: true }); }
  }
  const nodeAvailable = await probeNode();
  function check(step: WorkflowStep) {
    if (!['shell', 'typescript'].includes(step.kind)) throw new Error('Unsupported executor kind');
    if (process.platform === 'win32') throw new Error('Code executors require POSIX');
    if (!isAbsolute(options.runtimePath) || !existsSync(options.runtimePath) || !statSync(options.runtimePath).isFile()) throw new Error('Workflow runtime bundle is unavailable; run build:workflow-runtime');
    if (!nodeAvailable) throw new Error(boundaryError ?? 'Host Node 22 or later runtime is unavailable');
    if (step.secrets && Object.keys(step.secrets).length && !options.resolveSecret) throw new Error('Secret resolver is unavailable');
    if (step.kind === 'shell' && Object.keys(step.secrets ?? {}).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(PATH|OUTPUT|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|LD_.*|DYLD_.*|NODE_.*)$/.test(name))) throw new Error('Unsafe Shell secret environment name');
  }
  const executor: WorkflowExecutor = {
    check,
    async execute(context) {
      canonicalScope(context.scope);
      check(context.step);
      context.signal.throwIfAborted();
      const secrets: Record<string, string> = Object.create(null);
      for (const [name, reference] of Object.entries(context.step.secrets ?? {})) { secrets[name] = await options.resolveSecret!(reference, context.signal); context.signal.throwIfAborted(); }
      const inputSchema = context.inputSchema ?? context.step.inputSchema;
      try {
        const output = await executeRuntime(context, secrets, inputSchema);
        context.signal.throwIfAborted();
        return context.step.kind === 'typescript' ? parseValue(context.step.outputSchema, output) : output;
      } catch (error) {
        throw new Error(redact(error instanceof Error ? error.message : String(error), secrets));
      }
    },
  };
  async function executeRuntime(context: ExecutorContext, secrets: Record<string, string>, inputSchema?: VisualSchema): Promise<Json> {
    const stateRoot = options.stateRoot ? { stateRoot: options.stateRoot } : {};
    const scope = canonicalScope(context.scope);
    const runtimePath = realpathSync(options.runtimePath);
    const nodePath = realpathSync(options.nodePath);
    const args = ['--noprofile', '--norc', '-c', 'ulimit -c 0; exec "$@"', 'flow-workflow', nodePath, '--max-old-space-size=128', runtimePath];
    const timeout = Math.min(context.step.timeoutMs ?? 60_000, 2_147_000_000);
    const request = JSON.stringify({ ...context.step, scope, input: context.input, inputType: inputSchema ? toTypeScript(inputSchema) : 'unknown', outputType: context.step.kind === 'typescript' ? toTypeScript(context.step.outputSchema) : 'unknown', secrets, timeout });
    context.signal.throwIfAborted();
    // When enabled, the local supervisor, QuickJS guest and Shell descendants share a boundary.
    // Explicitly unset inherited variables before the isolation launcher merges environments.
    const env = { ...Object.fromEntries(Object.keys(process.env).map(key => [key, undefined])), ...environment,
      FLOW_BWRAP_PATH: process.env.FLOW_BWRAP_PATH, FLOW_STATE_DIR: process.env.FLOW_STATE_DIR,
      HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
      CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
    const isolation = isolationEnabled ? await prepareFilesystemIsolation({ scope, expectedScope: resolve(context.scope),
      ...stateRoot, command: '/bin/bash', args, env, readablePaths: [nodePath, runtimePath], credentials: 'none' }) : undefined;
    try {
      context.signal.throwIfAborted();
      const child = spawn(isolation?.command ?? '/bin/bash', isolation?.args ?? args,
        { env: isolation?.env ?? environment, ...(!isolation ? { cwd: scope } : {}), detached: true,
          stdio: ['pipe', 'pipe', 'pipe', ...(isolation?.stdioFds ?? [])] });
      let stdout = '', stderr = '', stopped = false;
      // Restricted launches also end the PID namespace. Unrestricted detached descendants
      // can escape the process group; this lifecycle supervision is not confinement.
      const kill = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      };
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        if (stopped) return;
        stopped = true; child.stdin!.end();
        killTimer = setTimeout(kill, 5000);
      };
      context.signal.addEventListener('abort', abort, { once: true });
      child.stdin!.on('error', () => {});
      if (context.signal.aborted) abort();
      if (!stopped) child.stdin!.write(request + '\n');
      const heartbeat = setInterval(() => { if (!stopped) child.stdin!.write('\n'); }, 500);
      const deadline = setTimeout(abort, timeout + 1000);
      for (const [stream, label] of [[child.stdout!, 'stdout'], [child.stderr!, 'stderr']] as const) stream.setEncoding('utf8').on('data', (chunk: string) => {
        if (label === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      });
      try {
        const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        if (code !== 0) throw new Error(`Workflow runtime exited (${code}): ${stderr.slice(0, 1000)}`);
        const response = JSON.parse(stdout) as { error?: string; output: Json };
        if (Object.hasOwn(response, 'error')) throw new Error(redact(response.error!, secrets));
        if (stopped || context.signal.aborted) throw new Error('Code execution stopped');
        return redactValue(response.output, secrets);
      } finally {
        clearInterval(heartbeat); clearTimeout(deadline); clearTimeout(killTimer);
        context.signal.removeEventListener('abort', abort);
        kill();
      }
    } finally {
      isolation?.cleanup();
    }
  }
  return { shell: executor, typescript: executor };
}
function redactValue(value: Json, secrets: Record<string, string>): Json {
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key, secrets), redactValue(item, secrets)]));
  return value;
}
function redact(text: string, secrets: Record<string, string>): string {
  const patterns = Object.values(secrets).filter(Boolean).flatMap(value => [value, JSON.stringify(value).slice(1, -1), JSON.stringify(JSON.stringify(value).slice(1, -1)).slice(1, -1)]).sort((a, b) => b.length - a.length);
  for (const value of patterns) text = text.split(value).join('[REDACTED]');
  return text;
}
