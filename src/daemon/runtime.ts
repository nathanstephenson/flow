import { registerBackends } from '../backend/registry.ts';
import { createOidcGateFromEnv, readOrCreateToken, type OidcGate } from './auth.ts';
import { ConfigStore } from './config-store.ts';
import { SecretStore } from './secret-store.ts';
import { WorkflowStore } from '../workflows/store.ts';
import { WorkflowExecutionService } from './workflow-executions.ts';
import { WorkflowScheduleStore } from '../workflows/schedule-store.ts';
import { WorkflowScheduleService } from './workflow-schedules.ts';
import { scheduleDriver } from './workflow-schedule-driver.ts';
import { WorkflowBuilderService } from './workflow-builder.ts';
import { workflowCatalogue } from './workflow-routes.ts';
import { WorkflowMcpAuthoringService } from './workflow-mcp-authoring.ts';
import { SessionHost } from './host.ts';
import { McpAuth } from './mcp-auth.ts';
import { serve, type RunningServer } from './server.ts';
import { ShellRegistry } from './shell.ts';
import { TranscriptStore } from './store.ts';
import { acquireHost, readHost, oidcFingerprint, type HostIdentity } from './ownership.ts';
import type { AssetManifest } from '../web/assets.ts';
import type { Installation } from '../cli/install-guard.ts';
import { WebUpdateController } from '../cli/web-update.ts';
import { trimTimings } from './timings.ts';

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
    await config.initializeFilesystemIsolation();
    const isolation = config.filesystemIsolationStatus();
    if (isolation.mode === "none") {
      console.error(`  WARNING: Filesystem isolation is OFF. Agent tools, local Workflow code and stdio MCP can access or delete files outside Scope, including host credentials.${isolation.reason ? ` ${isolation.reason}` : ''}`);
    } else if (isolation.mode === "bubblewrap" ? !isolation.supported : !isolation.sandbox.supported) {
      console.error(`  WARNING: Filesystem isolation (${isolation.mode}) is selected but unavailable; restricted execution will be refused. ${(isolation.mode === "bubblewrap" ? isolation.reason : isolation.sandbox.reason) ?? ''}`);
    }
    const mcpAuth = new McpAuth(root);
    const store = new TranscriptStore(root);
    const secrets = new SecretStore(root);
    const host = new SessionHost({
      store, resolveSecret: name => secrets.resolve(name), retention: config.retention,
      mcpConnections: config.mcpConnections, mcpAuth,
      filesystemIsolationMode: config.filesystemIsolationMode, sandboxSupport: config.sandboxSupport,
      sandboxSharing: config.sandboxSharing, projectRoot: config.projectRoot,
      standingAuthorisations: config.standingAuthorisations, allowTool: config.allowTool,
      defaultBackend: config.defaultBackend, defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort, defaultPermissionMode: config.defaultPermissionMode, autoCompaction: config.autoCompaction, compactionModel: config.compactionModel, summaryModel: config.summaryModel,
    });
    const shells = new ShellRegistry();
    let workflowSchedules: WorkflowScheduleService | undefined;
    let workflowExecutions: WorkflowExecutionService | undefined;
    let workflowBuilders: WorkflowBuilderService | undefined;
    let workflowMcpAuthoring: WorkflowMcpAuthoringService | undefined;
    let running: RunningServer | undefined;
    let oidc: OidcGate | undefined;
    let sweep: ReturnType<typeof setInterval> | undefined;
    let reaping = Promise.resolve();
    let stopping: Promise<void> | undefined;
    const stop = (): Promise<void> => stopping ??= (async () => {
      clearInterval(sweep);
      const scheduledErrors: unknown[] = [];
      try { await workflowSchedules?.stopAdmission(); } catch (error) { scheduledErrors.push(error); }
      try { await workflowExecutions?.stopScheduled(); } catch (error) { scheduledErrors.push(error); }
      const interrupt = async () => { await Promise.all([host.shutdown(), workflowBuilders?.shutdown(), workflowMcpAuthoring?.shutdown(), shells.killAll(), reaping]); };
      if (running) await running.stopAdmission(interrupt);
      else await interrupt();
      if (running) await running.stopAdmission(() => host.shutdown());
      else await host.shutdown();
      await shells.killAll();
      if (running) await running.close();
      else { mcpAuth.dispose(); oidc?.dispose(); }
      ownership.release();
      if (scheduledErrors.length) throw new AggregateError(scheduledErrors, 'Scheduled workflow cleanup failed');
    })();
    cleanup = stop;
    registerBackends(host);
    trimTimings(root);
    void host.models(config.projectRoot() ?? process.cwd());
    const workflows = new WorkflowStore(root);
    store.onSessionDeleted = sessionId => workflows.deleteOwner({ kind: 'session', sessionId });
    workflowExecutions = new WorkflowExecutionService(host, workflows, secrets, config, options.workflowRuntime());
    workflowMcpAuthoring = new WorkflowMcpAuthoringService({ host, config, scope: process.cwd() });
    workflowBuilders = new WorkflowBuilderService({
      host, config, scope: process.cwd(), stateRoot: root,
      validateDefinition: definition => workflowExecutions!.validateDefinitionCredentials(definition),
      workflowCatalogue: () => workflowCatalogue(workflows),
      workflowDefinition: id => { try { return workflows.getDefinition(id); } catch { return undefined; } },
      mcpCatalogue: (scope, projectId, scopeIdentity) => workflowMcpAuthoring!.catalogue(projectId, { scope, scopeIdentity }),
      mcpTool: (scope, projectId, scopeIdentity, connectionId, toolName) => workflowMcpAuthoring!.tool(projectId, connectionId, toolName, { scope, scopeIdentity }),
    });
    try {
      const schedules = new WorkflowScheduleStore(root);
      workflowSchedules = new WorkflowScheduleService(schedules, scheduleDriver({ host, config, workflows, executions: workflowExecutions, schedules, transcripts: store }));
      workflowExecutions.onScheduledResult = async record => { workflowSchedules!.result(record); };
    } catch {
      workflowExecutions.scheduledOwnershipAvailable = false;
      console.error('Workflow Schedule initialization failed. Scheduling is disabled. Other Session Host services will continue.');
    }
    await host.load();
    try { await workflowSchedules?.start(); }
    catch { console.error('Workflow Schedule reconciliation failed. Other Session Host services will continue.'); }
    workflowExecutions.reconcile();
    reaping = reaping.then(async () => {
      try { await workflowSchedules?.prune(); }
      catch { console.error('Workflow Schedule retention failed. Cleanup will be retried.'); }
    });
    sweep = setInterval(() => {
      reaping = reaping.then(async () => {
        try { await host.reap(); }
        catch { console.error('Agent Session Reaping failed. The next sweep will retry.'); }
        try { await workflowSchedules?.prune(); }
        catch { console.error('Workflow Schedule retention failed. The next sweep will retry.'); }
      });
    }, 60 * 60 * 1000);
    sweep.unref();
    host.onSessionClosed(sessionId => shells.killFor(sessionId));
    const token = readOrCreateToken(root);
    oidc = await createOidcGateFromEnv(root);
    const identity: HostIdentity = {
      instanceId: ownership.instanceId, pid: process.pid, version: options.version, url: '', token, mode: options.mode,
      settings: { port: options.port ?? 0, address: options.address ?? '127.0.0.1', cwd: process.cwd(), oidc: oidcFingerprint() },
    };
    const hasActiveWork = () => !!workflowSchedules?.hasActiveWork() || host.hasActiveWork() || workflowBuilders!.hasActiveWork() || workflowMcpAuthoring!.hasActiveWork() || shells.hasLiveShells() || host.list().some(session => workflowExecutions!.list(session.id).occupied);
    const updates = new WebUpdateController({
      root,
      installedVersion: options.version,
      mode: options.mode,
      hasActiveWork,
      channel: config.updateChannel,
      ...(options.updateInstallation === undefined ? {} : options.updateInstallation),
      ...(options.updateUnsupportedReason === undefined ? {} : { unsupportedReason: options.updateUnsupportedReason }),
    });
    running = await serve({
      control: { identity, stop, hasActiveWork },
      updates,
      host, token, shells, config, mcpAuth, store, workflows, secrets, workflowExecutions, workflowBuilders, workflowMcpAuthoring,
      ...(workflowSchedules === undefined ? {} : { workflowSchedules }),
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
