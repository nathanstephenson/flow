#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRoot, installation, registryExists, updateEligible } from './install-guard.ts';
import { update } from './update.ts';
import { finishWebUpdate } from './web-update.ts';

declare const FLOW_BUILD_ID: string;
async function bootstrap() {
  const slot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const args = process.argv.slice(2);
  const root = canonicalRoot(process.env.FLOW_STATE_DIR ?? join(homedir(), '.flow'));
  const globalSlot = slot.endsWith('/lib/node_modules/@nathanstephenson/flow');
  let updateInstallation: { installation: ReturnType<typeof installation>; bootstrapEntry: string } | undefined;
  if (globalSlot && (args[0] === 'update' || updateEligible(slot) || registryExists(slot))) {
    const install = installation(slot);
    const lease = await install.register(FLOW_BUILD_ID, root, args, process.env.FLOW_UPDATE_CAPABILITY);
    delete process.env.FLOW_UPDATE_CAPABILITY;
    process.on('exit', lease.release);
    if (args[0] === 'update') {
      const webId = process.env.FLOW_WEB_UPDATE_ID;
      delete process.env.FLOW_WEB_UPDATE_ID;
      try {
        const result = await update(install, lease, args);
        if (webId) finishWebUpdate(root, webId, result);
        return;
      } catch (error) {
        if (webId) finishWebUpdate(root, webId, undefined, error);
        throw error;
      }
    }
    updateInstallation = { installation: install, bootstrapEntry: fileURLToPath(import.meta.url) };
  } else if (args[0] === 'update') throw new Error('Self-update requires a private global npm installation; source and npm link are unsupported');
  const { runCli } = await import(new URL('./application.js', import.meta.url).href);
  await runCli(updateInstallation);
}
bootstrap().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
