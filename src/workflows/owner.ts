import { join } from 'node:path';
import type { ExecutionIdentity, ExecutionOwner } from '../protocol/workflows.ts';

export type { ExecutionOwner } from '../protocol/workflows.ts';

type OwnershipFields = { version?: 1 | 2; occurrenceId?: string; sessionId?: string };

function storageId(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid storage ID');
  return value;
}

export function executionOwnerOf(value: OwnershipFields): ExecutionOwner {
  if (value.version === 1 && (value.occurrenceId !== undefined || !value.sessionId)) throw new Error('Invalid execution owner');
  if (value.version === 2 && !value.occurrenceId) throw new Error('Invalid execution owner');
  if (value.occurrenceId !== undefined) return { kind: 'occurrence', occurrenceId: storageId(value.occurrenceId) };
  if (value.sessionId) return { kind: 'session', sessionId: storageId(value.sessionId) };
  throw new Error('Missing execution owner');
}

export function executionOwnerKey(owner: ExecutionOwner): string {
  return owner.kind === 'occurrence' ? `occurrence-${storageId(owner.occurrenceId)}` : storageId(owner.sessionId);
}

export function parseExecutionOwnerKey(key: string): ExecutionOwner {
  storageId(key);
  return key.startsWith('occurrence-') ? { kind: 'occurrence', occurrenceId: storageId(key.slice(11)) } : { kind: 'session', sessionId: key };
}

export function executionOwnerPath(stateRoot: string, owner: ExecutionOwner): string {
  return owner.kind === 'occurrence'
    ? join(stateRoot, 'workflow-schedules', 'executions', storageId(owner.occurrenceId))
    : join(stateRoot, 'sessions', storageId(owner.sessionId));
}

export function executionIdentity(value: OwnershipFields): ExecutionIdentity {
  const owner = executionOwnerOf(value);
  return owner.kind === 'session'
    ? { version: 1, sessionId: owner.sessionId }
    : { version: 2, occurrenceId: owner.occurrenceId, ...(value.sessionId === undefined ? {} : { sessionId: storageId(value.sessionId) }) };
}

export function executionAssociation(value: OwnershipFields): string | undefined {
  return executionOwnerOf(value).kind === 'occurrence' ? value.sessionId : undefined;
}

export function executionAccessibleBy(value: OwnershipFields, owner: ExecutionOwner | string): boolean {
  const requested = typeof owner === 'string' ? parseExecutionOwnerKey(owner) : owner;
  const actual = executionOwnerOf(value);
  if (requested.kind === 'occurrence') return actual.kind === 'occurrence' && actual.occurrenceId === requested.occurrenceId;
  return actual.kind === 'session' ? actual.sessionId === requested.sessionId : executionAssociation(value) === requested.sessionId;
}
