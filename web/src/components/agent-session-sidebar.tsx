import { Columns2, Plus } from "lucide-react";
import type { ReactNode } from "react";

import type { SessionStatus, SessionSummary } from "../../../src/protocol/commands.ts";
import type { LinkState } from "@client/connection.ts";
import { relativeTime } from "@client/relative-time.ts";
import { sessionLabel } from "@client/session-label.ts";
import { canSettle } from "@client/status.ts";
import { StatusDot } from "@/components/status-indicator.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Tooltip } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";
import { useNow } from "@/lib/use-now.ts";

/**
 * The Agent Session rail, and — since two-up is fewer panes than the grid it replaces — the app's
 * status board. A dot, a running state, a queue depth and a relative time per row is enough to
 * *monitor* any number of Agent Sessions without *reading* them, which is what the grid was really
 * being used for.
 */
export type AgentSessionSidebarProps = {
  sessions: SessionSummary[];
  primary: string | undefined;
  secondary: string | undefined;
  liveStatuses: Record<string, SessionStatus>;
  /** Where the keyboard is in the rail, which is not the same thing as which pane is open. */
  cursorId: string | undefined;
  link: LinkState | undefined;
  scope: string;
  onFocus: (sessionId: string) => void;
  onSplit: (sessionId: string) => void;
  onSettle: (sessionId: string) => void;
  onNew: () => void;
};

export function AgentSessionSidebar(props: AgentSessionSidebarProps) {
  const now = useNow();
  // The Session Host sorts Settled last, so this partition costs nothing and cannot reorder.
  const active = props.sessions.filter((session) => session.status !== "settled");
  const settled = props.sessions.filter((session) => session.status === "settled");

  return (
    <aside className="grid h-full min-h-0 grid-rows-[auto_1fr_auto] border-r bg-sidebar text-sidebar-foreground">
      <SidebarHeader scope={props.scope} onNew={props.onNew} />

      <div className="transcript-scroller">
        <AgentSessionList {...props} sessions={active} now={now} />

        {settled.length > 0 ? (
          <SettledDisclosure count={settled.length}>
            <AgentSessionList {...props} sessions={settled} now={now} />
          </SettledDisclosure>
        ) : null}

        {props.sessions.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No Agent Sessions yet.</p>
        ) : null}
      </div>

      <SidebarFooter link={props.link} />
    </aside>
  );
}

function SidebarHeader({ scope, onNew }: { scope: string; onNew: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b px-2 py-2">
      <Tooltip label={scope}>
        <ScopeLabel scope={scope} className="max-w-[13rem]" />
      </Tooltip>
      <Button size="sm" className="ml-auto" onClick={onNew}>
        <Plus aria-hidden />
        New Agent Session
      </Button>
    </div>
  );
}

/**
 * A Scope is a filesystem path, so it is mono, and the part anyone actually reads is the last
 * segment — the leading directories stay legible but recede.
 */
export function ScopeLabel({ scope, className }: { scope: string; className?: string | undefined }) {
  const cut = scope.lastIndexOf("/");
  const directory = cut <= 0 ? "" : `${scope.slice(0, cut)}/`;
  const basename = cut < 0 ? scope : scope.slice(cut + 1);
  return (
    <span className={cn("truncate font-mono text-xs", className)} dir="rtl">
      <span className="text-muted-foreground/70">{directory}</span>
      <span className="text-foreground">{basename}</span>
    </span>
  );
}

type ListProps = AgentSessionSidebarProps & { sessions: SessionSummary[]; now: number };

function AgentSessionList({ sessions, now, ...props }: ListProps) {
  return (
    <ul className="list-none p-0 m-0">
      {sessions.map((session) => (
        <li key={session.id}>
          <AgentSessionRow
            summary={session}
            now={now}
            status={props.liveStatuses[session.id] ?? session.status}
            selected={session.id === props.primary || session.id === props.secondary}
            cursored={session.id === props.cursorId}
            onFocus={props.onFocus}
            onSplit={props.onSplit}
            onSettle={props.onSettle}
          />
        </li>
      ))}
    </ul>
  );
}

type RowProps = {
  summary: SessionSummary;
  now: number;
  status: SessionStatus;
  selected: boolean;
  cursored: boolean;
  onFocus: (sessionId: string) => void;
  onSplit: (sessionId: string) => void;
  onSettle: (sessionId: string) => void;
};

function AgentSessionRow({ summary, now, status, selected, cursored, onFocus, onSplit, onSettle }: RowProps) {
  return (
    <div
      className={cn(
        "group grid grid-cols-[auto_1fr_auto_auto] items-center gap-2 border-l-2 px-2 py-1.5",
        selected
          ? "border-l-primary bg-muted"
          : "border-l-transparent hover:bg-muted",
        // The keyboard cursor is a ring rather than a fill, so it can sit on a row that is also open
        // in a pane without the two signals cancelling each other out.
        cursored && "outline outline-ring -outline-offset-1",
      )}
    >
      <StatusDot status={status} />

      {/* A real button, not a div with a click handler: focus, Enter and Space come free. */}
      <button
        type="button"
        onClick={() => onFocus(summary.id)}
        className="min-w-0 text-left"
        aria-current={selected ? "true" : undefined}
      >
        <span className="block truncate text-sm text-foreground">{sessionLabel(summary)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {summary.backend} · {relativeTime(summary.updatedAt, now)}
        </span>
      </button>

      {/*
       * `invisible` rather than `hidden`: the grid column stays reserved, so the title beside these
       * cannot reflow the moment a pointer enters the row.
       */}
      <Button
        variant="ghost"
        size="icon"
        className="invisible group-focus-within:visible group-hover:visible"
        onClick={() => onSplit(summary.id)}
        aria-label="Open beside"
        title="Open beside"
      >
        <Columns2 aria-hidden />
      </Button>

      {canSettle(status) ? (
        <Button
          variant="ghost"
          size="sm"
          className="invisible group-focus-within:visible group-hover:visible"
          onClick={() => onSettle(summary.id)}
        >
          settle
        </Button>
      ) : (
        // Same width, still reserved: hiding the affordance must not move the row.
        <span className="w-18" aria-hidden />
      )}
    </div>
  );
}

/**
 * Settled Agent Sessions are de-emphasised, not hidden (ADR 0006): they are still readable, still
 * Revivable, and still on disk until their retention window closes. A native `<details>` is what
 * this needs — keyboard-accessible for free, no state to hold, and browsers expand it for
 * find-in-page.
 */
function SettledDisclosure({ count, children }: { count: number; children: ReactNode }) {
  return (
    <details className="border-t">
      <summary className="cursor-default px-2 py-1.5 text-xs text-muted-foreground select-none">
        Settled · {count}
      </summary>
      {/* Reduced contrast here; full contrast once one of them is focused in a pane. */}
      <div className="opacity-60">{children}</div>
    </details>
  );
}

function SidebarFooter({ link }: { link: LinkState | undefined }) {
  return (
    <div className="flex items-center gap-2 border-t px-2 py-1.5">
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Kbd>n</Kbd> new
      </span>
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Kbd>/</Kbd> find
      </span>
      <LinkDot link={link} />
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-sm border bg-muted px-1 font-mono text-xs text-muted-foreground">
      {children}
    </kbd>
  );
}

/**
 * The event stream, in one glyph. "gone" is the only terminal state, so it is the only one worth
 * colouring an error: the rest are stages of a loop that is still trying, and a UI that cries
 * outage every time a stream is quiet teaches people to ignore it.
 */
function LinkDot({ link }: { link: LinkState | undefined }) {
  if (link === undefined) return null;
  const color =
    link === "live" ? "var(--chart-2)" : link === "gone" ? "var(--destructive)" : "var(--chart-4)";
  return (
    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
      <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {link}
    </span>
  );
}
