import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { WorkflowExecutionService } from '../src/daemon/workflow-executions.ts';
import { startRuntime } from '../src/daemon/runtime.ts';

test('scheduled cleanup failure cannot skip Backend Session, server or ownership cleanup', async t => {
  const root = mkdtempSync(join(tmpdir(), 'flow-runtime-scheduled-stop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'config.json'), JSON.stringify({ filesystemIsolation: 'none' }));
  const register = SessionHost.prototype.registerBackend;
  t.mock.method(SessionHost.prototype, 'registerBackend', function (this: SessionHost, candidate: { name: string }) {
    if (candidate.name === 'fake') register.call(this, new FakeBackend());
  });
  const shutdown = t.mock.method(SessionHost.prototype, 'shutdown');
  const scheduled = t.mock.method(WorkflowExecutionService.prototype, 'stopScheduled', async () => { throw new Error('Sandbox remove failed'); });
  const runtime = await startRuntime({ root, version: '1.0.0', mode: 'background', assets: () => ({}), workflowRuntime: () => '/unused' });
  t.after(async () => { if (runtime.running.server.listening) await runtime.running.close(); });
  await assert.rejects(runtime.stop(), (error: unknown) => error instanceof AggregateError && error.errors.some(cause => cause.message === 'Sandbox remove failed'));
  assert.ok(shutdown.mock.callCount() > 0);
  assert.equal(scheduled.mock.callCount(), 1);
  assert.equal(runtime.running.server.listening, false);
  assert.equal(existsSync(join(root, 'host.lock')), false);
  await assert.rejects(runtime.stop(), AggregateError);
  assert.equal(scheduled.mock.callCount(), 1);
});
