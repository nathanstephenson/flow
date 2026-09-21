import { registerBackends } from '../backend/registry.ts';
import { createOidcGateFromEnv, readOrCreateToken, type OidcGate } from './auth.ts';
import { ConfigStore } from './config-store.ts';
import { SecretStore } from './secret-store.ts';
import { WorkflowStore } from '../workflows/store.ts';
import { WorkflowExecutionService } from './workflow-executions.ts';
import { SessionHost } from './host.ts';
import { McpAuth } from './mcp-auth.ts';
import { serve, type RunningServer } from './server.ts';
import { ShellRegistry } from './shell.ts';
import { TranscriptStore } from './store.ts';
import { acquireHost, readHost, oidcFingerprint, type HostIdentity } from './ownership.ts';
import type { AssetManifest } from '../web/assets.ts';
import type { Installation } from '../cli/install-guard.ts';
import { WebUpdateController } from '../cli/web-update.ts';

export async function startRuntime(options: {
  root: string;
  version: string;
  port?: number;
  address?: string;
  mode: HostIdentity['mode'];
  assets(): AssetManifest;
  workflowRuntime(): string;
  updateInstallation?: { installation: Installation; bootstrapEntry: string };
  updateUnsupportedReason?: string;
}) {
  const ownership = acquireHost(options.root);
  const root = ownership.root;
  let cleanup = async () => ownership.release();
  try {
    const previous = readHost(root);
    if (previous) {
      const reachable = await fetch(`${previous.url}/api/sessions`, {
        headers: { authorization: `Bearer ${previous.token}` }, signal: AbortSignal.timeout(500),
      }).then(response => response.ok, () => false);
      if (reachable) throw new Error('A Session Host is already reachable for this state root');
    }
    const config = new ConfigStore(root);
    if (config.warning) console.error(`  WARNING: ${config.warning}`);
    const mcpAuth = new McpAuth(root);
    const store = new TranscriptStore(root);
    const secrets = new SecretStore(root);
    const host = new SessionHost({
      store, resolveSecret: name => secrets.resolve(name), retention: config.retention,
      mcpConnections: config.mcpConnections, mcpAuth,
      standingAuthorisations: config.standingAuthorisations, allowTool: config.allowTool,
      defaultBackend: config.defaultBackend, defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort, autoCompaction: config.autoCompaction, summaryModel: config.summaryModel,
    });
    const shells = new ShellRegistry();
    let running: RunningServer | undefined;
    let oidc: OidcGate | undefined;
    let sweep: ReturnType<typeof setInterval> | undefined;
    let reaping = Promise.resolve();
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => stopping ??= (async () => {
      clearInterval(sweep);
      const interrupt = async () => { await Promise.all([host.shutdown(), shells.killAll(), reaping]); };
      if (running) await running.stopAdmission(interrupt);
      else await interrupt();
      if (running) await running.stopAdmission(() => host.shutdown());
      else await host.shutdown();
      await shells.killAll();
      if (running) await running.close();
      else { mcpAuth.dispose(); oidc?.dispose(); }
      ownership.release();
    })();
    cleanup = stop;
    registerBackends(host);
    const workflows = new WorkflowStore(root);
    const workflowExecutions = new WorkflowExecutionService(host, workflows, secrets, config, options.workflowRuntime());
    await host.load();
    workflowExecutions.reconcile();
    sweep = setInterval(() => { reaping = reaping.then(async () => { await host.reap(); }); }, 60 * 60 * 1000);
    sweep.unref();
    host.onSessionClosed(sessionId => shells.killFor(sessionId));
    const token = readOrCreateToken(root);
    oidc = await createOidcGateFromEnv(root);
    const identity: HostIdentity = {
      instanceId: ownership.instanceId, pid: process.pid, version: options.version, url: '', token, mode: options.mode,
      settings: { port: options.port ?? 0, address: options.address ?? '127.0.0.1', cwd: process.cwd(), oidc: oidcFingerprint() },
    };
    const hasActiveWork = () => host.hasActiveWork() || shells.hasLiveShells() || host.list().some(session => workflowExecutions.list(session.id).occupied);
    const updates = new WebUpdateController({
      root,
      installedVersion: options.version,
      mode: options.mode,
      hasActiveWork,
      ...(options.updateInstallation === undefined ? {} : options.updateInstallation),
      ...(options.updateUnsupportedReason === undefined ? {} : { unsupportedReason: options.updateUnsupportedReason }),
    });
    running = await serve({
      control: { identity, stop, hasActiveWork },
      updates,
      host, token, shells, config, mcpAuth, store, workflows, secrets, workflowExecutions,
      assets: options.assets(), scope: process.cwd(),
      ...(oidc === undefined ? {} : { oidc }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.address === undefined ? {} : { address: options.address }),
    });
    const url = running.url.replace(`//${options.address ?? '127.0.0.1'}:`, '//127.0.0.1:');
    identity.url = url;
    ownership.publish(identity);
    return { running, daemon: { url, token }, stop };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
