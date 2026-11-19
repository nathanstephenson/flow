import { isDeepStrictEqual } from 'node:util';
import type { Json, WorkflowDefinition } from '../protocol/workflows.ts';
import { resolveWorkflowCalls } from '../workflows/calls.ts';
import { executionOwnerKey } from '../workflows/owner.ts';
import { createCodeExecutors } from '../workflows/executors.ts';
import type { WorkflowExecutors, WorkflowSession } from '../workflows/scheduler.ts';
import { parseValue } from '../workflows/schema.ts';
import type { WorkflowStore } from '../workflows/store.ts';
import type { SessionHost } from './host.ts';
import type { SecretStore } from './secret-store.ts';
import type { WorkflowExecutionResources } from './workflow-execution-resources.ts';
import { assertNoSecrets, publicDefinition, sameProject, uniqueCredentials, withConfirmedNoControlOff, WorkflowConflict } from './workflow-execution-values.ts';

type Runtime = { nodePath?: string; isolationMode: 'none' | 'bubblewrap' | 'sandbox' };
export type ManualWorkflowLaunch = { sessionId: string; definition: WorkflowDefinition; input: Json; stepId?: string; nameSession?: boolean; launchId?: string };
export type ScheduledWorkflowLaunch = { occurrenceId: string; definition: WorkflowDefinition; input: Json; scope: string; projectId: string; mcpConnectionIds: string[]; attach: () => Promise<string>; signal?: AbortSignal | undefined };
export type WorkflowLaunch =
  | { kind: 'session'; options: ManualWorkflowLaunch }
  | { kind: 'occurrence'; options: ScheduledWorkflowLaunch };

export async function prepareWorkflowLaunch(launch: WorkflowLaunch, dependencies: {
  host: SessionHost;
  store: WorkflowStore;
  secrets: SecretStore;
  resources: WorkflowExecutionResources;
  runtimePath: string;
  snapshot(needsCode: boolean): Promise<{ runtime: Runtime; code: WorkflowExecutors }>;
  discover(owner: string, connection: string, tools: import('../protocol/workflows.ts').McpToolSnapshot[], mode: Runtime['isolationMode'], signal?: AbortSignal): Promise<unknown>;
}) {
  const { host, store, secrets, resources, runtimePath } = dependencies;
  const { definition, input } = launch.options;
  const stepId = launch.kind === 'session' ? launch.options.stepId : undefined;
  const signal = launch.kind === 'occurrence' ? launch.options.signal : undefined;
  signal?.throwIfAborted();
  const identity = launch.kind === 'session' ? host.workflowSession(launch.options.sessionId)
    : { backend: definition.backend, scope: launch.options.scope, projectId: launch.options.projectId };
  const manifest = resolveWorkflowCalls(definition, id => store.getDefinition(id), stepId);
  const definitions = Object.values(manifest);
  for (const candidate of definitions) {
    if (candidate.backend !== identity.backend) throw new Error('Backend Adapter mismatch');
    if (candidate.projectId && !sameProject(candidate.projectId, identity.projectId)) throw new Error('Workflow is restricted to another Project');
  }
  const selectedSteps = definitions.flatMap(candidate => candidate.steps.filter(step => candidate.id !== definition.id || !stepId || step.id === stepId));
  const values = uniqueCredentials([...host.workflowMcpCredentials(), ...selectedSteps.flatMap(step => Object.values(step.secrets ?? {}).map(name => secrets.resolve(name)))]);
  for (const candidate of definitions) assertNoSecrets(publicDefinition(candidate), values);
  assertNoSecrets(input, values, true);
  if (!stepId) parseValue(definition.inputSchema, input);
  const needsCode = selectedSteps.some(step => step.kind === 'shell' || step.kind === 'typescript');
  const snapshot = await dependencies.snapshot(needsCode);
  signal?.throwIfAborted();
  const owner = launch.kind === 'session' ? launch.options.sessionId : executionOwnerKey({ kind: 'occurrence', occurrenceId: launch.options.occurrenceId });
  let session: WorkflowSession;
  let prepared = manifest;
  let assertSession = () => {};
  if (launch.kind === 'session') {
    const opened = await host.openWorkflowSession(launch.options.sessionId);
    host.assertWorkflowSession(launch.options.sessionId, opened.session);
    if (opened.scope !== identity.scope || opened.projectId !== identity.projectId || opened.backend !== identity.backend) throw new WorkflowConflict();
    if (!opened.session) throw new Error('Workflow Backend Session is unavailable');
    session = opened;
    prepared = Object.fromEntries(definitions.map(candidate => [candidate.id, withConfirmedNoControlOff(candidate, opened.session!.capabilities.models)]));
    const sessionId = launch.options.sessionId;
    assertSession = () => host.assertWorkflowSession(sessionId, opened.session);
  } else {
    const environment = resources.create(owner, identity.scope, launch.options.mcpConnectionIds, snapshot.runtime, launch.options.attach).environment;
    await environment.prepare(signal);
    session = { occurrenceId: launch.options.occurrenceId, runtime: snapshot.runtime, ...identity };
  }
  const environment = resources.get(owner);
  const stateRoot = host.filesystemStateRoot();
  const code = launch.kind === 'occurrence' && needsCode ? await createCodeExecutors({
    ...(stateRoot ? { stateRoot } : {}), scope: identity.scope, sandbox: () => environment.sandbox(), isolationMode: snapshot.runtime.isolationMode,
    runtimePath, nodePath: snapshot.runtime.nodePath ?? '', resolveSecret: async (name, abort) => secrets.resolve(name, abort),
  }) : snapshot.code;
  const pinned = new Map<string, import('../protocol/workflows.ts').McpToolSnapshot[]>();
  for (const step of selectedSteps) if (step.kind === 'mcp') pinned.set(step.tool.connectionId, [...pinned.get(step.tool.connectionId) ?? [], step.tool]);
  for (const [connection, tools] of pinned) await dependencies.discover(owner, connection, tools, snapshot.runtime.isolationMode, signal);
  signal?.throwIfAborted();
  const assertCurrent = () => {
    signal?.throwIfAborted();
    assertSession();
    if (!isDeepStrictEqual(resolveWorkflowCalls(definition, id => store.getDefinition(id), stepId), manifest)) throw new WorkflowConflict();
  };
  return { owner, definition: prepared[definition.id]!, manifest: prepared, session: { ...session, matchesProject: (project: string) => sameProject(project, identity.projectId) }, values, runtime: snapshot.runtime, code, assertCurrent };
}
