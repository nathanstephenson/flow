import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

export class InstallationProcessUncertain extends Error {}

function groupAlive(pid: number): boolean {
  try { process.kill(-pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function stopGroup(pid: number): Promise<void> {
  for (const [signal, timeout] of [['SIGTERM', 1000], ['SIGKILL', 5000]] as const) {
    try { process.kill(-pid, signal); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    const deadline = Date.now() + timeout;
    while (groupAlive(pid) && Date.now() < deadline) await delay(25);
    if (!groupAlive(pid)) return;
  }
  throw new Error('npm process group did not exit');
}

export async function replacePackage(npm: string, prefix: string, packageSpec: string): Promise<void> {
  const child = spawn(npm, ['install', '--global', '--prefix', prefix, packageSpec], { detached: true, stdio: 'inherit' });
  const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  try {
    if (child.pid) await stopGroup(child.pid);
  } catch (error) {
    throw new InstallationProcessUncertain(`Cannot confirm npm descendants stopped: ${String(error)}`);
  }
  if (result.code !== 0) throw new Error(`npm installation failed (${result.signal ?? result.code})`);
}
