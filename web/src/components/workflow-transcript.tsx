import { useMemo, useState } from 'react';
import { reduceAll } from '../../../src/client/reduce.ts';
import type { LoggedEvent } from '../../../src/protocol/events.ts';
import type { WorkflowActivity, WorkflowActivityPage } from '../../../src/protocol/workflow-executions.ts';
import { TranscriptEntry } from './transcript-entry.tsx';
import { useWorkflowResource } from './workflow-api.ts';
import { Button } from './ui/button.tsx';

export function WorkflowTranscript({ base, sessionId, stepId, attempt, legacy }: { base: string; sessionId: string; stepId: string; attempt: number; legacy: boolean }) {
  const [after, setAfter] = useState(0);
  const [earlier, setEarlier] = useState<WorkflowActivity[]>([]);
  const { data, error } = useWorkflowResource<WorkflowActivityPage>(`${base}/activity?stepId=${encodeURIComponent(stepId)}${legacy ? '' : `&attempt=${attempt}`}&after=${after}`, 2000);
  const entries = useMemo(() => reduceAll([...earlier, ...(data?.activity ?? [])].flatMap(item => item.event.type === 'spend' ? [] : [{ sessionId, seq: item.sequence, at: new Date(item.at).toISOString(), event: item.event } as LoggedEvent])).entries, [earlier, data, sessionId]);
  return <section className="min-w-0 space-y-3" aria-label="Step transcript">
    {(legacy || data?.historyComplete === false) && <p className="text-xs text-muted-foreground">Older history is unavailable. Showing retained activity; legacy events may not identify their attempt.</p>}
    {error && <p role="alert">{error}</p>}
    {entries.map((entry, i) => <TranscriptEntry key={`${entry.kind}-${i}`} entry={entry} query="" sessionId={sessionId} />)}
    {data && !entries.length && <p className="text-xs text-muted-foreground">No activity recorded for this attempt.</p>}
    {data?.next !== undefined && <Button size="sm" variant="outline" onClick={() => { setEarlier([...earlier, ...data.activity]); setAfter(data.next!); }}>Load more activity</Button>}
  </section>;
}
