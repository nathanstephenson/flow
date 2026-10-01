import { isSea } from 'node:sea';

const flag = '--flow-docker-supervisor';

/** Launch trusted, already-loaded code without reopening a script in a writable Scope. */
export function dockerSupervisorLaunch(): { command: string; args: string[] } {
  if (isSea()) return { command: process.execPath, args: [flag] };
  const program = `(${runDockerSupervisor.toString()})().catch(error=>{console.error(error.message);process.exitCode=1})`;
  return { command: process.execPath, args: ['-e', program] };
}

export function isDockerSupervisor(): boolean { return process.argv[2] === flag; }

/** Keep this function self-contained: the npm launcher serializes it into Node's -e program. */
export async function runDockerSupervisor(): Promise<void> {
  const { spawn } = await import('node:child_process');
  const { createInterface } = await import('node:readline');
  const controller = new AbortController();
  let started = false;
  let stop = () => {
    controller.abort();
    if (!started) finish({ error: 'Docker runtime stopped' });
  };
  let lease = setTimeout(() => stop(), 3000);
  const lines = createInterface({ input: process.stdin });
  lines.on('close', () => stop());
  lines.on('line', line => {
    clearTimeout(lease);
    lease = setTimeout(() => stop(), 3000);
    if (started) return;
    started = true;
    try {
      void dockerSupervisor(JSON.parse(line)).then(output => finish({ output }), error => finish({ error: error instanceof Error ? error.message : String(error) }));
    } catch (error) {
      finish({ error: error instanceof Error ? error.message : String(error) });
    }
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
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { error = (error + chunk).slice(-1000); });
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
}
