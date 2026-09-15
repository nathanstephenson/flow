import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { WorkflowDefinition, WorkflowExecution } from '../protocol/workflows.ts';
import { validateDefinition } from './graph.ts';
import { parseExecution } from './records.ts';

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
  constructor(stateRoot: string) { this.stateRoot = stateRoot; }

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
    atomicWrite(this.historyPath(execution.sessionId), execution.id, this.redact(execution));
  }

  getExecution(sessionId: string, id: string): WorkflowExecution {
    const value = parseExecution(readJson(join(this.historyPath(sessionId), `${segment(id)}.json`)));
    if (value.id !== id || value.sessionId !== sessionId) throw new Error('Invalid workflow execution identity');
    return value;
  }

  listExecutions(sessionId: string): WorkflowExecution[] {
    return ids(this.historyPath(sessionId)).map(id => this.getExecution(sessionId, id));
  }

  listSessionIds(): string[] {
    const directory = join(this.stateRoot, 'sessions');
    return existsSync(directory) ? readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) : [];
  }

  private historyPath(sessionId: string): string {
    return join(this.stateRoot, 'sessions', segment(sessionId), 'workflows');
  }
}
