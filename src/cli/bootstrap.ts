#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalRoot, explainUnsupportedUpdate, installation, registryExists, updateEligible } from './install-guard.ts';
import { update } from './update.ts';
import { claimWebUpdate, finishWebUpdate } from './web-update.ts';
import { systemdUpdate, launchSystemdUpdate, readSystemdRequest, clearSystemdRequest, systemdCapability, assertSystemdOwner } from './systemd-update.ts';

declare const FLOW_BUILD_ID: string;
async function bootstrap() {
  const slot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const args = process.argv.slice(2);
  const root = canonicalRoot(process.env.FLOW_STATE_DIR ?? join(homedir(), '.flow'));
  const globalSlot = slot.endsWith('/lib/node_modules/@nathanstephenson/flow');
  let updateSupport: {
    installation?: ReturnType<typeof installation>;
    bootstrapEntry?: string;
    unsupportedReason?: string;
  };
  if (globalSlot && (args[0] === 'update' || updateEligible(slot) || registryExists(slot))) {
    const install = installation(slot);
    const managed = systemdUpdate(root);
    const worker = args[0] === 'update' && process.env.FLOW_SYSTEMD_WORKER === '1';
    if (args[0] === 'update' && managed && !worker) {
      if (args.length > 2 || (args[1] !== undefined && args[1] !== '--force')) throw new Error('usage: flow update [--force]');
      await launchSystemdUpdate(root, managed, { force: args.includes('--force') });
      console.log('Systemd update queued. See the updater unit journal for the result.');
      return;
    }
    if (worker) {
      if (!managed) throw new Error('Missing systemd update configuration');
      await assertSystemdOwner(managed, managed.updater, process.pid);
    }
    const lease = await install.register(FLOW_BUILD_ID, root, args, process.env.FLOW_UPDATE_CAPABILITY ?? systemdCapability(root));
    delete process.env.FLOW_UPDATE_CAPABILITY;
    process.on('exit', lease.release);
    if (args[0] === 'update') {
      const request = worker ? readSystemdRequest(root) : undefined;
      const webId = request?.id ?? process.env.FLOW_WEB_UPDATE_ID;
      const webVersion = request?.version ?? process.env.FLOW_WEB_UPDATE_VERSION;
      if (webId) claimWebUpdate(root, webId);
      delete process.env.FLOW_WEB_UPDATE_ID;
      delete process.env.FLOW_WEB_UPDATE_VERSION;
      try {
        if ((webId === undefined) !== (webVersion === undefined)) throw new Error('Web update authorization is incomplete');
        const result = await update(install, lease, request ? ['update', ...(request.force ? ['--force'] : [])] : args, {
          ...(webId ? { expectedVersion: webVersion!, preserveConcreteHostPort: true } : {}),
          ...(worker ? { systemd: managed! } : {}),
        });
        if (webId) finishWebUpdate(root, webId, result);
        return;
      } catch (error) {
        if (webId) finishWebUpdate(root, webId, undefined, error);
        throw error;
      } finally { if (worker) clearSystemdRequest(root); }
    }
    updateSupport = { installation: install, bootstrapEntry: fileURLToPath(import.meta.url) };
  } else {
    if (args[0] === 'update') throw new Error('Self-update requires a private global npm installation; source, npm link, root, shared, and system installations are unsupported');
    updateSupport = { unsupportedReason: explainUnsupportedUpdate(slot) };
  }
  const { runCli } = await import(new URL('./application.js', import.meta.url).href);
  await runCli(updateSupport);
}
bootstrap().catch(error => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
