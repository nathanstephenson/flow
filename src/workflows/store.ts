import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ExecutionOwner, WorkflowDefinition, WorkflowExecution } from '../protocol/workflows.ts';
import { validateDefinition } from './graph.ts';
import { parseExecution } from './records.ts';
import { executionAccessibleBy, executionAssociation, executionIdentity, executionOwnerKey, executionOwnerOf, executionOwnerPath, parseExecutionOwnerKey } from './owner.ts';

function segment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('Invalid storage ID');
  return value;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function durableDirectory(directory: string): void {
  if (existsSync(directory)) return;
  const parent = dirname(directory);
  durableDirectory(parent);
  mkdirSync(directory, { mode: 0o700 });
  syncDirectory(parent);
}

function atomicWrite(directory: string, id: string, value: unknown): void {
  segment(id);
  durableDirectory(directory);
  const temporary = join(directory, `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    renameSync(temporary, join(directory, `${segment(id)}.json`));
    syncDirectory(directory);
  } finally { rmSync(temporary, { force: true }); }
}

function ids(directory: string): string[] {
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).map(name => name.slice(0, -5)) : [];
}

export class WorkflowStore {
  readonly stateRoot: string;
  redact: <T>(value: T) => T = value => value;
  private readonly owners = new Map<string, ExecutionOwner>();
  private readonly associations = new Map<string, Map<string, { owner: ExecutionOwner; id: string }>>();
  private readonly sessionsByOwner = new Map<string, Map<string, string>>();

  constructor(stateRoot: string) {
    this.stateRoot = stateRoot;
    const directory = join(stateRoot, 'workflow-schedules', 'executions');
    const occurrences: ExecutionOwner[] = existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => ({ kind: 'occurrence', occurrenceId: entry.name })) : [];
    for (const owner of [...this.listSessionIds().map(sessionId => ({ kind: 'session' as const, sessionId })), ...occurrences]) {
      this.owners.set(this.ownerIndexKey(owner), owner);
      for (const id of ids(this.historyPath(owner))) this.index(this.readExecution(owner, id));
    }
  }

  saveDefinition(definition: WorkflowDefinition): void {
    const validated = validateDefinition(definition).definition;
    atomicWrite(join(this.stateRoot, 'workflows'), validated.id, this.redact(validated));
  }

  getDefinition(id: string): WorkflowDefinition {
    return validateDefinition(readJson(join(this.stateRoot, 'workflows', `${segment(id)}.json`))).definition;
  }

  listDefinitions(): WorkflowDefinition[] {
    return ids(join(this.stateRoot, 'workflows')).map(id => this.getDefinition(id));
  }

  deleteDefinition(id: string): void {
    const directory = join(this.stateRoot, 'workflows');
    rmSync(join(directory, `${segment(id)}.json`), { force: true });
    if (existsSync(directory)) syncDirectory(directory);
  }

  saveExecution(execution: WorkflowExecution): void {
    const saved = this.redact(execution);
    executionIdentity(saved);
    atomicWrite(this.historyPath(executionOwnerOf(saved)), saved.id, saved);
    this.index(saved);
  }

  getExecution(ownerId: ExecutionOwner | string, id: string): WorkflowExecution {
    const owner = typeof ownerId === 'string' ? parseExecutionOwnerKey(ownerId) : ownerId;
    const ownPath = join(this.historyPath(owner), `${segment(id)}.json`);
    if (existsSync(ownPath) || owner.kind === 'occurrence') return this.readExecution(owner, id);
    const reference = [...(this.associations.get(owner.sessionId)?.values() ?? [])].find(reference => reference.id === id);
    if (!reference) return this.readExecution(owner, id);
    const record = this.readExecution(reference.owner, id);
    if (!executionAccessibleBy(record, owner)) throw new Error('Invalid workflow execution association');
    return record;
  }

  deleteOwner(ownerId: ExecutionOwner | string): void {
    const owner = typeof ownerId === 'string' ? parseExecutionOwnerKey(ownerId) : ownerId;
    const directory = this.ownerPath(owner);
    rmSync(directory, { recursive: true, force: true });
    if (existsSync(dirname(directory))) syncDirectory(dirname(directory));
    const ownerKey = this.ownerIndexKey(owner);
    for (const id of this.sessionsByOwner.get(ownerKey)?.keys() ?? []) this.removeAssociation(ownerKey, id);
    this.owners.delete(ownerKey);
  }

  listOwnedExecutions(owner: ExecutionOwner | string): WorkflowExecution[] {
    const identity = typeof owner === 'string' ? parseExecutionOwnerKey(owner) : owner;
    return ids(this.historyPath(identity)).map(id => this.readExecution(identity, id));
  }

  listExecutions(ownerId: ExecutionOwner | string): WorkflowExecution[] {
    const owner = typeof ownerId === 'string' ? parseExecutionOwnerKey(ownerId) : ownerId;
    const own = this.listOwnedExecutions(owner);
    if (owner.kind === 'occurrence') return own;
    const associated = [...(this.associations.get(owner.sessionId)?.values() ?? [])]
      .filter(reference => existsSync(join(this.historyPath(reference.owner), `${segment(reference.id)}.json`)))
      .map(reference => {
        const record = this.readExecution(reference.owner, reference.id);
        if (!executionAccessibleBy(record, owner)) throw new Error('Invalid workflow execution association');
        return record;
      });
    return [...own, ...associated];
  }

  listSessionIds(): string[] {
    const directory = join(this.stateRoot, 'sessions');
    return existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  }

  listOwners(): ExecutionOwner[] {
    return [...this.owners.values()].filter(owner => existsSync(this.ownerPath(owner))).map(owner => ({ ...owner }));
  }

  listOwnerIds(): string[] { return this.listOwners().map(executionOwnerKey); }

  ownerPath(owner: ExecutionOwner | string): string {
    return executionOwnerPath(this.stateRoot, typeof owner === 'string' ? parseExecutionOwnerKey(owner) : owner);
  }

  private historyPath(owner: ExecutionOwner): string {
    return join(this.ownerPath(owner), 'workflows');
  }

  private ownerIndexKey(owner: ExecutionOwner): string {
    return JSON.stringify(owner.kind === 'session' ? ['session', owner.sessionId] : ['occurrence', owner.occurrenceId]);
  }

  private readExecution(owner: ExecutionOwner, id: string): WorkflowExecution {
    const value = parseExecution(readJson(join(this.historyPath(owner), `${segment(id)}.json`)));
    if (value.id !== id || this.ownerIndexKey(executionOwnerOf(value)) !== this.ownerIndexKey(owner)) throw new Error('Invalid workflow execution identity');
    return value;
  }

  private index(record: WorkflowExecution): void {
    const owner = executionOwnerOf(record);
    const ownerKey = this.ownerIndexKey(owner);
    const key = JSON.stringify([ownerKey, record.id]);
    this.removeAssociation(ownerKey, record.id);
    this.owners.set(ownerKey, owner);
    const sessionId = executionAssociation(record);
    if (sessionId === undefined) return;
    let references = this.associations.get(sessionId);
    if (!references) this.associations.set(sessionId, references = new Map());
    references.set(key, { owner, id: record.id });
    let sessions = this.sessionsByOwner.get(ownerKey);
    if (!sessions) this.sessionsByOwner.set(ownerKey, sessions = new Map());
    sessions.set(record.id, sessionId);
  }

  private removeAssociation(ownerKey: string, id: string): void {
    const sessions = this.sessionsByOwner.get(ownerKey);
    if (!sessions) return;
    const sessionId = sessions.get(id);
    if (sessionId === undefined) return;
    const references = this.associations.get(sessionId)!;
    references.delete(JSON.stringify([ownerKey, id]));
    if (!references.size) this.associations.delete(sessionId);
    sessions.delete(id);
    if (!sessions.size) this.sessionsByOwner.delete(ownerKey);
  }
}
