import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { WorkflowBuilderView } from '../../../src/protocol/workflow-builder.ts';
import { createWorkflowBuilderTranscript } from './workflow-builder-view.ts';

const snapshot = (): WorkflowBuilderView => ({
  id: 'private-builder', scope: '/reference', status: 'running',
  definition: { version: 1, id: 'definition', name: 'Draft', backend: 'fake', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] },
  messages: [{ id: 'user', role: 'user', text: 'Build it' }, { id: 'reply', role: 'assistant', text: 'Working', final: false }],
});
function fixture() {
  const frames: Array<() => void> = [];
  const transcript = createWorkflowBuilderTranscript('workflow builder definition', { schedule: frame => frames.push(frame) });
  return { ...transcript, flush: () => { for (const frame of frames.splice(0)) frame(); } };
}

it('adapts confirmed authoring rows through the shared transcript store without an Agent Session transport', () => {
  const f = fixture();
  f.update(snapshot());
  assert.deepEqual(f.view.getKeys(), []);
  f.view.start();
  f.flush();
  assert.deepEqual(f.view.getKeys(), ['user:user', 'assistant:reply']);
  assert.deepEqual(f.view.getEntry('user:user'), { kind: 'user', id: 'user', text: 'Build it' });
  assert.deepEqual(f.view.getEntry('assistant:reply'), { kind: 'assistant', id: 'reply', text: 'Working', final: false });
  assert.equal(f.view.getChrome().link, 'live');
  assert.equal(f.view.getHistory().earlier, 0);
  assert.equal(f.view.canObserveThrough(f.view.getLastSeq(), f.view.getKeys()), false);
  f.view.stop();
});

it('preserves keys and unchanged row identities through polling and streamed snapshots', () => {
  const f = fixture(); f.view.start();
  f.update(snapshot()); f.flush();
  const keys = f.view.getKeys(), user = f.view.getEntry('user:user'), reply = f.view.getEntry('assistant:reply');
  const seq = f.view.getLastSeq();
  f.update(snapshot()); f.flush();
  assert.equal(f.view.getLastSeq(), seq);
  assert.equal(f.view.getEntry('assistant:reply'), reply);
  const next = snapshot(); next.messages[1]!.text = 'Working on the draft';
  f.update(next); f.flush();
  assert.equal(f.view.getKeys(), keys);
  assert.equal(f.view.getEntry('user:user'), user);
  assert.notEqual(f.view.getEntry('assistant:reply'), reply);
  f.view.stop();
});

it('uses authoritative final flags and settles interrupted assistant rows without a forever caret', () => {
  const f = fixture(); f.view.start();
  const next = snapshot(); next.messages[1]!.final = true;
  f.update(next); f.flush();
  const row = f.view.getEntry('assistant:reply')!;
  assert.ok(row.kind === 'assistant');
  assert.equal(row.final, true);
  const stopped = snapshot(); stopped.stopping = true;
  f.update(stopped); f.flush();
  assert.deepEqual(f.view.getEntry('assistant:reply'), { kind: 'assistant', id: 'reply', text: 'Working', final: true });
  const resumed = snapshot(); resumed.messages.push({ id: 'next-user', role: 'user', text: 'Continue' });
  f.update(resumed); f.flush();
  assert.deepEqual(f.view.getEntry('assistant:reply'), { kind: 'assistant', id: 'reply', text: 'Working', final: true });
  f.view.stop();
});

it('retains only the host bounded snapshot and restores the latest state on a StrictMode-style restart', () => {
  const f = fixture(); f.view.start(); f.update(snapshot()); f.flush();
  f.view.stop();
  const next = snapshot(); next.status = 'idle'; next.messages = [{ id: 'new', role: 'assistant', text: 'Done', final: true }];
  f.update(next); f.flush();
  assert.deepEqual(f.view.getKeys(), ['user:user', 'assistant:reply']);
  f.view.start(); f.flush();
  assert.deepEqual(f.view.getKeys(), ['assistant:new']);
  assert.equal(f.view.getEntry('user:user'), undefined);
  f.view.stop();
});
