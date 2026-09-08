import { ChevronLeft } from "lucide-react";
import { useMemo } from "react";

import type { Entry } from "@client/reduce.ts";
import { useAgentSession, useEntry, useTranscriptKeys } from "@/agent-session-view.tsx";
import { TranscriptEntry } from "@/components/transcript-entry.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ordered, subagentKeys } from "@/presentation/subagent-list.ts";
import { memberKeys } from "@/presentation/subagent-rows.ts";
import type { AgentSessionView } from "@/store/contract.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The Subagents of one Agent Session: a list, and one Subagent's own transcript.
 *
 * This is the body of one Dock Tab, and the tab decides what it is for. It exists because the
 * Presentation Transcript cannot show parallel work — a flat list ordered by `seq` has one axis, so
 * two Subagents running at once interleave their rows and the reader cannot tell whose is whose
 * (ADR 0015). Here the list is the first axis and one Subagent's rows are the second.
 *
 * Drilling in replaces the list rather than opening a tab: which Subagent is selected lives in the
 * tab's own content, so it survives a reload the way a Shell's id does.
 *
 * Both derivations are memoised on the key array, which is the correct signal *and only because of
 * how the store invalidates it*: `getKeys()` returns the identical array until `entries.length`
 * changes, and both "which Subagents exist" and "which rows are this one's" change exactly when an
 * Entry is appended. Statuses change without the length moving, which is why `ordered` runs on
 * every render instead — see subagent-list.ts.
 */
export type SubagentsPaneProps = {
  sessionId: string;
  /** The Subagent being read, or the list when absent. */
  subagentId: string | undefined;
  onSelect: (subagentId: string | undefined) => void;
};

export function SubagentsPane({ sessionId, subagentId, onSelect }: SubagentsPaneProps) {
  const view = useAgentSession(sessionId);
  // Absent for the first paint, while the registry hands one over in a layout effect. Nothing to
  // draw yet, and a spinner for one frame would be worse than an empty box.
  if (view === undefined) return <div className="min-h-0 flex-1" />;
  return subagentId === undefined ? (
    <SubagentList view={view} onSelect={onSelect} />
  ) : (
    <SubagentTranscript view={view} subagentId={subagentId} onBack={() => onSelect(undefined)} />
  );
}

function SubagentList({
  view,
  onSelect,
}: {
  view: AgentSessionView;
  onSelect: (subagentId: string) => void;
}) {
  const keys = useTranscriptKeys(view);
  const getEntry = useMemo(() => (key: string) => view.getEntry(key), [view]);
  const spawned = useMemo(() => subagentKeys(keys, getEntry), [keys, getEntry]);
  // Not memoised: a status change reorders this without changing the key array at all, so a memo
  // here would freeze every row's position at whatever it was when the Subagent first appeared.
  const rows = ordered(spawned, getEntry);

  if (rows.length === 0) {
    return (
      <p className="flex min-h-0 items-center justify-center p-4 text-center text-sm text-muted-foreground">
        No agents yet. They appear here when the model hands work to one.
      </p>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto p-2">
      <ul className="flex flex-col gap-1">
        {rows.map((key) => (
          <SubagentRow key={key} view={view} entryKey={key} onSelect={() => onSelect(key)} />
        ))}
      </ul>
    </div>
  );
}

/**
 * One row, subscribed on its own.
 *
 * `useEntry` is what makes the list live: a status transition changes that one Entry's identity, so
 * that one row re-renders and the rest bail out. The alternative — the list re-rendering wholesale
 * on every transcript tick — would repaint every row while a subagent streams text.
 */
function SubagentRow({
  view,
  entryKey: key,
  onSelect,
}: {
  view: AgentSessionView;
  entryKey: string;
  onSelect: () => void;
}) {
  const entry = useEntry(view, key);
  if (entry?.kind !== "subagent") return null;
  const waiting = entry.status === "waiting";
  const live = entry.status === "running" || waiting;

  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
      >
        <StatusDot status={entry.status} />
        <span className="shrink-0 font-mono text-sm text-foreground">{entry.name}</span>
        {entry.description === undefined ? null : (
          <span className="truncate font-mono text-xs text-muted-foreground">{entry.description}</span>
        )}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {waiting ? `waiting on ${entry.waitingOn}` : live ? "running" : entry.status}
        </span>
      </button>
    </li>
  );
}

/**
 * Filled while working, a quiet ring once finished, and `--destructive` only for an error — the
 * same "shape carries the state, not only colour" rule the tool dots and session dots follow.
 */
function StatusDot({ status }: { status: Extract<Entry, { kind: "subagent" }>["status"] }) {
  const live = status === "running" || status === "waiting";
  return (
    <span
      aria-hidden
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "error" ? "bg-destructive" : live ? "bg-primary" : "ring-1 ring-muted-foreground/50",
        status === "running" ? "animate-pulse" : "",
      )}
    />
  );
}

/**
 * One Subagent's own rows, rendered by the same `TranscriptEntry` the main transcript uses.
 *
 * Reusing the row renderer rather than writing a second one is what makes tool calls, diffs and
 * thinking appear here for nothing — and what will bring elapsed time along when `Entry` learns to
 * carry it.
 *
 * The main transcript's *scroller* is deliberately not reused: it pads itself by
 * `var(--composer-inset)`, which the Composer sets on the nearest `[data-pane]` ancestor. A Dock is
 * inside that pane, so this would have inherited the height of the Composer it cannot see.
 *
 * No indent to suppress: the main transcript no longer draws a Subagent's rows at all, so
 * `TranscriptEntry` has no attribution rule left to turn off here.
 */
function SubagentTranscript({
  view,
  subagentId,
  onBack,
}: {
  view: AgentSessionView;
  subagentId: string;
  onBack: () => void;
}) {
  const keys = useTranscriptKeys(view);
  const getEntry = useMemo(() => (key: string) => view.getEntry(key), [view]);
  const rows = useMemo(() => memberKeys(keys, getEntry, subagentId), [keys, getEntry, subagentId]);
  const subagent = useEntry(view, subagentId);
  const name = subagent?.kind === "subagent" ? subagent.name : "agent";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto px-2 pt-2 pb-16">
          {rows.length === 0 ? (
            <p className="p-2 text-sm text-muted-foreground">
              {subagent?.kind === "subagent" && subagent.status === "running"
                ? "Working. Nothing to show yet."
                : "This agent produced no rows of its own."}
            </p>
          ) : (
            rows.map((key: string) => <SubagentRowEntry key={key} view={view} entryKey={key} />)
          )}
      </div>

      {/*
       * Pinned where the Composer sits in the pane, and dressed like it, so the two read as the same
       * kind of thing: the bar you act from. It carries the name so the bar says what you are
       * leaving, not just that you can leave.
       */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background to-transparent px-2 pt-6 pb-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onBack}
          className="pointer-events-auto w-full justify-start rounded-xl border bg-card/85 shadow-lg backdrop-blur-sm"
        >
          <ChevronLeft aria-hidden data-icon="inline-start" />
          <span className="truncate">Back from {name}</span>
        </Button>
      </div>
    </div>
  );
}

function SubagentRowEntry({ view, entryKey: key }: { view: AgentSessionView; entryKey: string }) {
  const entry = useEntry(view, key);
  if (!entry) return null;
  return <TranscriptEntry entry={entry} query="" sessionId={view.sessionId} />;
}
