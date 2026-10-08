import { initialState, type Entry } from '../../../src/client/reduce.ts';
import type { PresentationSnapshot } from '../../../src/protocol/presentation.ts';
import type { WorkflowBuilderView } from '../../../src/protocol/workflow-builder.ts';
import type { PresentationSubscribeOptions } from '../../../src/client/connection.ts';
import { createAgentSessionView, type AgentSessionViewOptions } from './agent-session-view.ts';

/**
 * Adapt the bounded, ephemeral authoring conversation to the existing transcript renderer.
 * This starts no Agent Session, transport, or registry entry: only host-confirmed builder
 * snapshots enter the view. Stable rows retain their identity through polling and streaming.
 */
export function createWorkflowBuilderTranscript(key: string, options: AgentSessionViewOptions = {}) {
  let subscriber: PresentationSubscribeOptions | undefined;
  let snapshot: PresentationSnapshot | undefined;
  let fingerprint: string | undefined;
  let sequence = 0;
  let previous = new Map<string, Entry>();
  const { entries: _entries, lastSeq: _lastSeq, ...initial } = initialState();
  const view = createAgentSessionView(key, {
    subscribe: () => { throw new Error('Builder transcripts never open an Agent Session stream'); },
    subscribePresentation: next => {
      subscriber = next;
      next.onLink?.('live');
      if (snapshot) next.onSnapshot(snapshot);
      return () => { if (subscriber === next) subscriber = undefined; };
    },
  }, options);

  return {
    view,
    update(builder: WorkflowBuilderView): void {
      const running = builder.status === 'running' && !builder.stopping;
      const nextFingerprint = JSON.stringify([builder.messages, running, builder.scope, builder.definition.backend]);
      if (nextFingerprint === fingerprint) return;
      fingerprint = nextFingerprint;
      const retained = new Map<string, Entry>();
      const activeUser = builder.messages.findLastIndex(message => message.role === 'user');
      const entries = builder.messages.map((message, index) => {
        const kind = message.role === 'user' ? 'user' : 'assistant';
        const rowKey = `${kind}:${message.id}`;
        const final = !running || index < activeUser || (message.final ?? index !== builder.messages.length - 1);
        const old = previous.get(rowKey);
        const unchanged = old?.kind === kind && old.text === message.text &&
          (old.kind !== 'assistant' || old.final === final);
        const entry: Entry = unchanged ? old : kind === 'user'
          ? { kind, id: message.id, text: message.text }
          : { kind, id: message.id, text: message.text, final };
        retained.set(rowKey, entry);
        return { index, entry };
      });
      previous = retained;
      snapshot = {
        type: 'snapshot', seq: ++sequence, entries, related: [], start: 0, total: entries.length,
        state: { ...initial, backend: builder.definition.backend, scope: builder.scope,
          status: running ? 'running' : 'idle', turnInFlight: running },
      };
      subscriber?.onSnapshot(snapshot);
    },
  };
}
