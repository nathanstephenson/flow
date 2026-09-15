import assert from 'node:assert/strict';
import { it } from 'node:test';
import { recoveryRevision, safeAutomaticRecovery, successfulProgress } from '../src/workflows/recovery.ts';
import type { WorkflowExecution } from '../src/protocol/workflows.ts';

const execution = (): WorkflowExecution => ({ version: 1, id: 'execution', sessionId: 'session', scope: '/tmp', status: 'recovery-required', startedAt: 1,
  definition: { version: 1, id: 'definition', name: 'Test', backend: 'fake', inputSchema: { type: 'object', fields: { ready: { schema: { type: 'boolean' }, required: true } } }, steps: [{ id: 'check', name: 'Check', kind: 'branch', condition: { operator: 'truthy', path: ['ready'] } }], edges: [] },
  input: true, steps: { check: { status: 'failed', attempts: [{ number: 1, action: 'execute', startedAt: 1, finishedAt: 2, input: true, error: { kind: 'failure', message: 'failed' } }] } },
});
it('automatic recovery is conservative about effects, replacement output and loop limits', () => {
  const record = execution();
  assert.equal(safeAutomaticRecovery(record, { kind: 'retry', stepId: 'check' }), true);
  assert.equal(safeAutomaticRecovery(record, { kind: 'supply', stepId: 'check', output: true }), false);
  assert.equal(safeAutomaticRecovery(record, { kind: 'continue' }), false);
  record.definition.steps[0] = { id: 'check', name: 'External effect', kind: 'shell', command: 'touch changed' };
  assert.equal(safeAutomaticRecovery(record, { kind: 'retry', stepId: 'check' }), false);
  record.steps.check = { status: 'pending', attempts: [] };
  assert.equal(safeAutomaticRecovery(record, { kind: 'continue' }), true);
  record.loops = { check: { phase: 'limit', activation: 1, try: 3, grants: [] } };
  assert.equal(safeAutomaticRecovery(record, { kind: 'continue' }), false);
  assert.equal(safeAutomaticRecovery(record, { kind: 'extend-loop', headerId: 'check', activation: 1, try: 3 }), false);
});
it('only successful executed attempts count as progress; retry launch and replacement output do not', () => {
  const record = execution();
  const revision = recoveryRevision(record);
  assert.equal(successfulProgress(record), 0);
  assert.equal(recoveryRevision(structuredClone(record)), revision);
  record.steps.check!.attempts.push({ number: 2, action: 'retry', startedAt: 3, input: true });
  assert.equal(successfulProgress(record), 0);
  assert.notEqual(recoveryRevision(record), revision);
  record.steps.check!.attempts[1]!.finishedAt = 4;
  record.steps.check!.attempts[1]!.output = false;
  assert.equal(successfulProgress(record), 1);
  record.steps.check!.attempts.push({ number: 3, action: 'supply', startedAt: 5, finishedAt: 5, input: true, output: true });
  assert.equal(successfulProgress(record), 1);
});
