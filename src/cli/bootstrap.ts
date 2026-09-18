#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installation, updateEligible } from './install-guard.ts';
import { update } from './update.ts';

declare const FLOW_BUILD_ID: string;
async function bootstrap() {
  const slot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const args = process.argv.slice(2);
  const candidate = resolve(process.env.FLOW_STATE_DIR ?? join(homedir(), '.flow'));
  let root = candidate;
  try { root = realpathSync(candidate); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const globalSlot = slot.endsWith('/lib/node_modules/@nathanstephenson/flow');
  if (globalSlot && (args[0] === 'update' || updateEligible(slot))) {
    const install = installation(slot);
    const lease = await install.register(FLOW_BUILD_ID, root, args, process.env.FLOW_UPDATE_CAPABILITY);
    delete process.env.FLOW_UPDATE_CAPABILITY;
    process.on('exit', lease.release);
    if (args[0] === 'update') return update(install, lease, args);
  } else if (args[0] === 'update') throw new Error('Self-update requires a private global npm installation; source and npm link are unsupported');
  Object.defineProperty(globalThis, Symbol.for('flow.installation.entry'), { value: true });
  await import(new URL('./main.js', import.meta.url).href);
}
bootstrap().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
