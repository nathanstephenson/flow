import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Json, VisualSchema, WorkflowStep } from '../protocol/workflows.ts';
import type { ExecutorContext, WorkflowExecutor, WorkflowExecutors } from './scheduler.ts';
import { parseValue, toTypeScript } from './schema.ts';

export interface CodeExecutorOptions {
  runtimePath: string;
  nodePath: string;
  sandbox: { enabled: false } | { enabled: true; available: boolean; image: string; dockerPath?: string };
  resolveSecret?: (reference: string, signal: AbortSignal) => Promise<string>;
}
const environment = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' };
const dockerHost = 'unix:///var/run/docker.sock';

type Executors = Required<Pick<WorkflowExecutors, 'shell' | 'typescript'>>;

function probe(command: string, args: string[]): Promise<boolean> {
  if (!isAbsolute(command)) return Promise.resolve(false);
  return new Promise(resolve => {
    const child = spawn(command, args, { env: environment, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(false); }, 5000);
    child.once('error', () => { clearTimeout(timer); resolve(false); });
    child.once('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

export async function createCodeExecutors(options: CodeExecutorOptions): Promise<Executors> {
  const sandbox = options.sandbox;
  const docker = sandbox.enabled ? sandbox.dockerPath ?? '/usr/bin/docker' : '';
  const dockerArgs = ['--host', dockerHost];
  const [nodeAvailable, runtimeAvailable] = await Promise.all([
    probe(options.nodePath, ['-e', 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)']),
    !sandbox.enabled || (sandbox.available && probe(docker, [...dockerArgs, 'image', 'inspect', sandbox.image])),
  ]);
  function check(step: WorkflowStep) {
    if (!['shell', 'typescript'].includes(step.kind)) throw new Error('Unsupported executor kind');
    if (process.platform === 'win32') throw new Error('Code executors require POSIX');
    if (!isAbsolute(options.runtimePath) || !existsSync(options.runtimePath) || !statSync(options.runtimePath).isFile()) throw new Error('Workflow runtime bundle is unavailable; run build:workflow-runtime');
    if (sandbox.enabled) {
      if (!runtimeAvailable) throw new Error('External sandbox is enabled but unavailable');
    }
    if (!nodeAvailable) throw new Error('Host Node 22 or later runtime is unavailable');
    if (step.secrets && Object.keys(step.secrets).length && !options.resolveSecret) throw new Error('Secret resolver is unavailable');
    if (step.kind === 'shell' && Object.keys(step.secrets ?? {}).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || /^(PATH|OUTPUT|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|LD_.*|DYLD_.*|NODE_.*)$/.test(name))) throw new Error('Unsafe Shell secret environment name');
  }
  const executor: WorkflowExecutor = {
    check,
    async execute(context) {
      check(context.step);
      context.signal.throwIfAborted();
      const secrets: Record<string, string> = Object.create(null);
      for (const [name, reference] of Object.entries(context.step.secrets ?? {})) { secrets[name] = await options.resolveSecret!(reference, context.signal); context.signal.throwIfAborted(); }
      const inputSchema = context.inputSchema ?? context.step.inputSchema;
      const output = await executeRuntime(context, secrets, inputSchema);
      context.signal.throwIfAborted();
      return context.step.kind === 'typescript' ? parseValue(context.step.outputSchema, output) : output;
    },
  };
  async function executeRuntime(context: ExecutorContext, secrets: Record<string, string>, inputSchema?: VisualSchema): Promise<Json> {
    const scope = realpathSync(context.scope);
    const name = `flow-workflow-${randomUUID()}`;
    const args = sandbox.enabled ? [...dockerArgs, 'run', '--rm', '--log-driver=none', '--pull=never', '--name', name, '--init', '--interactive', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=64', '--ulimit=core=0', '--memory=256m', '--memory-swap=256m', '--cpus=1', '--user', `${process.getuid!()}:${process.getgid!()}`, '--network=host', '--mount', `type=bind,src=${scope},dst=/scope`, '--mount', `type=bind,src=${realpathSync(options.runtimePath)},dst=/runtime.cjs,readonly`, '--workdir=/scope', '--entrypoint=node', sandbox.image, '--max-old-space-size=128', '/runtime.cjs'] : ['--noprofile', '--norc', '-c', 'ulimit -c 0; exec "$@"', 'flow-workflow', options.nodePath, '--max-old-space-size=128', options.runtimePath];
    if (sandbox.enabled && (scope.includes(',') || options.runtimePath.includes(','))) throw new Error('Runtime mount paths cannot contain commas');
    const timeout = Math.min(context.step.timeoutMs ?? 60_000, 2_147_000_000);
    const request = JSON.stringify({ ...context.step, scope: sandbox.enabled ? '/scope' : scope, input: context.input, inputType: inputSchema ? toTypeScript(inputSchema) : 'unknown', outputType: context.step.kind === 'typescript' ? toTypeScript(context.step.outputSchema) : 'unknown', secrets, timeout });
    if (Buffer.byteLength(request) > 1_000_000) throw new Error('Runtime input limit exceeded');
    context.signal.throwIfAborted();
    const child = spawn(sandbox.enabled ? options.nodePath : '/bin/bash', sandbox.enabled ? ['--max-old-space-size=128', options.runtimePath, '--docker-supervisor'] : args, { env: environment, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stopped = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      if (stopped) return;
      stopped = true; child.stdin.end();
      if (!sandbox.enabled) killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 5000);
    };
    context.signal.addEventListener('abort', abort, { once: true });
    child.stdin.on('error', () => {});
    child.stdin.write((sandbox.enabled ? JSON.stringify({ docker, args, name, request: JSON.parse(request) }) : request) + '\n');
    const heartbeat = setInterval(() => { if (!stopped) child.stdin.write('\n'); }, 500);
    const deadline = setTimeout(abort, timeout + 1000);
    for (const [stream, label] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) stream.on('data', (chunk: Buffer) => {
      if (label === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      if (stdout.length + stderr.length > 1_000_000) { stdout = stdout.slice(0, 1_000_000); stderr = stderr.slice(0, 1000); abort(); }
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
  for (const value of Object.values(secrets)) if (value) text = text.split(value).join('[REDACTED]');
  return text;
}
