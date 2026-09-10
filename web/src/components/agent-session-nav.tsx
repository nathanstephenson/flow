import { ChevronDown, CircleCheck, FolderGit2, GitBranch, Plus, Settings } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import type { SessionStatus, SessionSummary } from "../../../src/protocol/commands.ts";
import type { LinkState } from "@client/connection.ts";
import { relativeTime } from "@client/relative-time.ts";
import { sessionLabel } from "@client/session-label.ts";
import { scopeKindLabel } from "@client/scope-kind.ts";
import { projectName } from "@client/project-name.ts";
import { canSettle, working } from "@client/status.ts";
import { activityStatusText } from "@/presentation/activity.ts";
import { BackendIcon } from "@/components/backend-icon.tsx";
import { StatusDot } from "@/components/status-indicator.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from "@/components/ui/sidebar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";
import { useNow } from "@/lib/use-now.ts";

/**
 * The Agent Session rail, and the app's status board. Exactly one Agent Session is on screen at a
 * time, so the rail carries the state of the rest: a dot, a running state, a queue depth and a
 * relative time per row is enough to *monitor* any number of them without *reading* them.
 *
 * The contents of the rail, not the rail itself: the `SidebarProvider` and `Sidebar` frame live in
 * the app shell, which swaps this out for the Settings nav. So this component supplies a header, a
 * content region and a footer and knows nothing about how wide it is or where it sits.
 *
 * **Why a Sidebar and not `Tabs orientation="vertical"`.** Three properties this rail has that a
 * tablist cannot express, and reintroducing tab semantics would break every one of them:
 *
 * - Rows contain their own button — settle — which `role="tab"` forbids; `SidebarMenuAction` exists
 *   for exactly this.
 * - The Settled group is a disclosure nested in the list, and a non-tab control inside a tablist is
 *   invalid ARIA.
 * - Tab panels imply mounted content. One panel per Agent Session would mount every Presentation
 *   Transcript, and each mount acquires a store that opens an event stream, while browsers cap
 *   concurrent connections per origin — a rail of twenty would starve the command endpoint.
 *
 * So this is a list with one current row, and it says so with `aria-current`: `aria-selected` is a
 * tablist's word and this is not one.
 *
 * **One keyboard cursor, not two.** The cursor is owned by the app shell and arrives as `cursorId`,
 * because `j`/`k`/`ArrowUp`/`ArrowDown`/`Home`/`End` are resolved centrally in
 * web/src/presentation/bindings.ts. This component's only jobs are to be a *single* tab stop —
 * roving `tabIndex`, so twenty Agent Sessions cost one tab stop rather than forty — and to keep DOM
 * focus on the cursor row while the rail has focus.
 */
export type AgentSessionNavProps = {
  sessions: SessionSummary[];
  /** The Agent Session in the pane. */
  focusedId: string | undefined;
  /** Its live status, which beats the polled one on its row. Absent until its first snapshot. */
  focusedStatus: SessionStatus | undefined;
  /** Where the keyboard is in the rail, which is not the same thing as what is in the pane. */
  cursorId: string | undefined;
  link: LinkState | undefined;
  scope: string;
  onFocus: (sessionId: string) => void;
  onSettle: (sessionId: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
};

export function AgentSessionNav(props: AgentSessionNavProps) {
  const now = useNow();
  // Settled is the Session Host's bottom band, so this partition costs nothing and cannot reorder.
  const active = props.sessions.filter((session) => session.status !== "settled");
  const settled = props.sessions.filter((session) => session.status === "settled");

  const cursorInSettled = settled.some((session) => session.id === props.cursorId);
  const [settledOpen, setSettledOpen] = useState(false);

  const list = useRef<HTMLDivElement>(null);

  /**
   * Focus follows the cursor, but only while the rail already has it. Moving focus on a cursor change
   * the reader made from a pane would yank the keyboard out from under them; not moving it while they
   * are *in* the rail would leave `tabIndex={0}` on a row that is not focused, which is the roving
   * tabindex bug rather than the pattern.
   */
  useEffect(() => {
    const container = list.current;
    if (!container) return;
    const focused = document.activeElement;
    if (!(focused instanceof HTMLElement) || !container.contains(focused)) return;
    const row = container.querySelector<HTMLElement>('[data-cursor="true"]');
    if (row && row !== focused) row.focus();
  }, [props.cursorId]);

  return (
    <>
      <RailHeader scope={props.scope} onNew={props.onNew} />

      {/*
       * Left/Right are the rail's own: they reach the row's own action without leaving the row, and
       * they are the only keys this component handles — everything vertical is resolved centrally
       * so there is one cursor rather than two.
       */}
      <SidebarContent ref={list} className="transcript-scroller gap-0" onKeyDown={moveWithinRow}>
        <SidebarGroup className="p-0">
          <SidebarGroupContent>
            <AgentSessionMenu {...props} label="Active Agent Sessions" sessions={active} now={now} />
          </SidebarGroupContent>
        </SidebarGroup>

        {settled.length > 0 ? (
          <>
            <SidebarSeparator className="mx-0" />
            <SettledGroup
              count={settled.length}
              // The group cannot be collapsed while the keyboard cursor is inside it: collapsing
              // would strand focus on a row the browser will not focus.
              open={settledOpen || cursorInSettled}
              onOpenChange={setSettledOpen}
            >
              <AgentSessionMenu {...props} label="Settled Agent Sessions" sessions={settled} now={now} />
            </SettledGroup>
          </>
        ) : null}

        {props.sessions.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No Agent Sessions yet.</p>
        ) : null}
      </SidebarContent>

      <RailFooter link={props.link} onOpenSettings={props.onOpenSettings} />
    </>
  );
}

/**
 * `ArrowRight` and `ArrowLeft` step through one row's controls: the row itself, then settle where the
 * status permits one. Two at most, but still expressed as a step through the row's controls rather
 * than as "focus the settle button" — that is the same amount of code and does not have to be
 * rewritten the day a row grows a second action. Delegated from the list rather than bound per row,
 * so the number of listeners does not grow with the number of Agent Sessions.
 *
 * The action is `visibility: hidden` until the row is hovered or holds focus, and a hidden element is
 * not focusable — which is fine and in fact required: focus is on the row button by the time this
 * runs, so `group-focus-within` has already revealed it.
 */
function moveWithinRow(event: KeyboardEvent<HTMLElement>): void {
  const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
  if (step === 0) return;

  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const row = target.closest<HTMLElement>('[data-sidebar="menu-item"]');
  if (!row) return;

  const controls = [
    ...row.querySelectorAll<HTMLElement>('[data-sidebar="menu-button"], [data-sidebar="menu-action"]'),
  ];
  const from = controls.indexOf(target);
  const next = from < 0 ? undefined : controls[from + step];
  if (!next) return;

  event.preventDefault();
  next.focus();
}

function RailHeader({ scope, onNew }: { scope: string; onNew: () => void }) {
  return (
    <SidebarHeader className="flex-row items-center gap-1 border-b border-sidebar-border">
      {/*
       * The Scope takes whatever is left rather than a fixed maximum. A 16rem rail cannot fit a
       * filesystem path *and* a labelled button, and reserving width for the label pushed the button
       * off the edge entirely — so the button is an icon and the path gets the remainder.
       */}
      <Tooltip>
        {/*
         * A plain span is the trigger rather than `render={<ScopeLabel/>}`: upstream's Trigger hands
         * its own props to whatever it renders, and ScopeLabel does not forward unknown props, so
         * rendering it directly would silently drop them and the tooltip would never open.
         */}
        <TooltipTrigger render={<span className="flex min-w-0 flex-1" />}>
          <ScopeLabel scope={scope} className="min-w-0 flex-1" />
        </TooltipTrigger>
        <TooltipContent>{scope}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={<Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={onNew} />}
        >
          <Plus aria-hidden />
          <span className="sr-only">New Agent Session</span>
        </TooltipTrigger>
        <TooltipContent>New Agent Session</TooltipContent>
      </Tooltip>
    </SidebarHeader>
  );
}

/**
 * A Scope is a filesystem path, so it is mono, and the part anyone actually reads is the last
 * segment — the leading directories stay legible but recede.
 *
 * Deliberately *not* `dir="rtl"`. That is the usual trick for truncating a path from the left, but
 * bidi reordering moves leading punctuation to the visual end, so `/workspace/Flow` rendered
 * as `workspace/Flow/` — a path that does not exist. The directory truncates from the left
 * with a plain `text-ellipsis` instead, and the basename is never truncated because it is the part
 * that identifies the Scope. The full path is in the tooltip either way.
 */
export function ScopeLabel({ scope, className }: { scope: string; className?: string | undefined }) {
  const cut = scope.lastIndexOf("/");
  const directory = cut <= 0 ? "" : `${scope.slice(0, cut)}/`;
  // A Scope of "/" has no basename to fall back to, and splitting it naively rendered the header
  // empty. Anything that leaves nothing to show falls back to the Scope verbatim.
  const basename = (cut < 0 ? scope : scope.slice(cut + 1)) || scope;
  return (
    <span className={cn("flex min-w-0 items-baseline font-mono text-xs", className)}>
      {directory === "" ? null : (
        <span className="truncate text-muted-foreground/70" style={{ direction: "ltr" }}>
          {directory}
        </span>
      )}
      <span className="shrink-0 text-foreground">{basename}</span>
    </span>
  );
}

type MenuProps = AgentSessionNavProps & { sessions: SessionSummary[]; now: number; label: string };

function AgentSessionMenu({ sessions, now, label, ...props }: MenuProps) {
  return (
    /* Full-bleed rows with no gap, as before: a gap between rows that carry a left-edge selection
       marker reads as stripes rather than as a list. */
    <SidebarMenu className="gap-0" aria-label={label}>
      {sessions.map((session) => (
        <AgentSessionRow
          key={session.id}
          summary={session}
          now={now}
          status={(session.id === props.focusedId ? props.focusedStatus : undefined) ?? session.status}
          selected={session.id === props.focusedId}
          cursored={session.id === props.cursorId}
          onFocus={props.onFocus}
          onSettle={props.onSettle}
        />
      ))}
    </SidebarMenu>
  );
}

type RowProps = {
  summary: SessionSummary;
  now: number;
  status: SessionStatus;
  selected: boolean;
  cursored: boolean;
  onFocus: (sessionId: string) => void;
  onSettle: (sessionId: string) => void;
};

function AgentSessionRow({ summary, now, status, selected, cursored, onFocus, onSettle }: RowProps) {
  /**
   * The roving tabindex, in one expression. Only the cursor row is reachable by `Tab`; its action
   * comes with it, so the whole rail is a constant number of tab stops no matter how many Agent
   * Sessions exist. Without this, twenty Agent Sessions put forty tab stops between the keyboard and
   * the Presentation Transcript.
   */
  const tabIndex = cursored ? 0 : -1;

  return (
    /* Upstream's own shape, kept: a `relative` item with the action positioned over the row rather
       than beside it. A flex line here instead would shrink the button to less than the row, and the
       selection highlight would visibly stop short of the action. */
    <SidebarMenuItem>
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        // A list with one current row, not a tablist — see this file's header.
        aria-current={selected ? "true" : undefined}
        data-cursor={cursored ? "true" : undefined}
        tabIndex={tabIndex}
        onClick={() => onFocus(summary.id)}
        className={cn(
          // Full-bleed and full-width, so the highlight reaches both edges of the rail. `pr-8` is
          // upstream's reservation for an overlaid action — applied unconditionally rather than
          // through its `group-has-[…menu-action]` guard, because whether a row can be Settled
          // changes with its status and the title must not reflow when it does.
          // `size="lg"` fixes the height at h-12, which fit the two lines this row had and clips the
          // third; `h-auto` hands the height back to the content, so a row is as tall as it has
          // something to say and a Scope that is not a repository stays two lines. p-2 would clip
          // the lines against the button's own `overflow-hidden`, so the padding stays py-1.5.
          "h-auto rounded-none py-1.5 pr-8",
          "border-l-2 border-l-transparent",
          selected && "border-l-primary",
          // The keyboard cursor is a ring rather than a fill, so it can sit on a row that is also
          // open in a pane without the two signals cancelling each other out — and it stays visible
          // when focus has left the rail entirely.
          cursored && "outline -outline-offset-1 outline-sidebar-ring",
        )}
      >
        {/* Spread, so a third kind of background work never has to edit this line. `status` comes
            last deliberately: the live one beats the polled one the summary carries. */}
        <StatusDot status={status} working={working({ ...summary, status })} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{sessionLabel(summary)}</span>
          <ScopeLine summary={summary} />
          {/*
           * Backend at one end, age at the other, and no status word between them: the dot's hue and
           * shape say the state now, and a row that spelled it out as well was spending a third of
           * its second line agreeing with the dot.
           *
           * The Backend is a mark rather than its name, and the width that buys goes to the Project
           * — which is the thing a reader scanning a rail of Agent Sessions across several
           * repositories is actually looking for, and which until now only the pane header said.
           * With the branch on the line above, the two together are the whole of where an Agent
           * Session is working.
           *
           * The dot and the Backend glyph are both `aria-hidden`, so the words they replaced —
           * including that Subagents are working — survive here for anyone not looking at colour
           * or shape.
           */}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="sr-only">{activityStatusText({ ...summary, status })}</span>
            <BackendIcon backend={summary.backend} />
            <span className="sr-only">{summary.backend}</span>
            <span className="truncate">{projectName(summary.scope, summary.worktree)}</span>
            {/*
             * `restingAt`, which is what the Session Host orders this list by. Showing `updatedAt`
             * here instead would print one time while sorting by another, and the first row whose
             * age disagreed with its position would read as a bug.
             */}
            <span className="ml-auto shrink-0">{relativeTime(summary.restingAt, now)}</span>
          </span>
        </span>
      </SidebarMenuButton>

      {/*
       * An icon rather than the word, because 48px of a 16rem rail spent on a control that is
       * usually invisible came straight out of the Agent Session's title. The tooltip carries the
       * domain term, which the icon cannot.
       *
       * `showOnHover` is upstream's own reveal — opacity on hover or focus-within — rather than the
       * `visibility` this used to hand-roll. Two gains beyond the shorter class list: nothing can
       * reflow, because the action is positioned over the row rather than in it; and an element at
       * `opacity: 0` stays focusable, where a `visibility: hidden` one does not, so ArrowRight can
       * reach Settle without hovering the row first.
       *
       * No placeholder when the row cannot be Settled: the button reserves its `pr-8` regardless, so
       * there is nothing left for an absent action to move.
       */}
      {canSettle(status) ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                showOnHover
                // No `top-*` here: upstream ships `peer-data-[size=lg]/menu-button:top-2.5` for
                // exactly this row height, and a plain utility loses to it on specificity anyway.
                tabIndex={tabIndex}
                onClick={() => onSettle(summary.id)}
              />
            }
          >
            <CircleCheck aria-hidden />
            <span className="sr-only">Settle</span>
          </TooltipTrigger>
          <TooltipContent>Settle</TooltipContent>
        </Tooltip>
      ) : null}
    </SidebarMenuItem>
  );
}

/**
 * Where this Agent Session's edits land: which branch, and which of the two checkouts.
 *
 * Absent when the Scope is not a repository, which is the same signal the composer's Scope Strip
 * hides its branch control on — a Project need not be a repository at all (ADR 0011), and a row that
 * said "no branch" would spend a line saying nothing happened.
 *
 * **The icon is the whole of the checkout indicator.** The rail is 16rem, and `scopeKindLabel`'s
 * words are long enough that "Project checkout" beside a branch name would leave the branch a few
 * characters — so the distinction is carried by which glyph is drawn, and the word itself goes to
 * the `sr-only` text, which is also what a reader not looking at shape gets. The composer's Scope
 * Strip is still the place the two are *explained*; this only distinguishes them.
 *
 * Mono, because a branch name is an identifier and this is the same reading as the Project name in
 * the pane header.
 */
function ScopeLine({ summary }: { summary: SessionSummary }) {
  if (!summary.branch) return null;
  const Glyph = summary.worktree ? FolderGit2 : GitBranch;

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {/* `size-3!` beats the button's own `[&_svg]:size-4`, which is sized for its action rather
          than for a line of text-xs. */}
      <Glyph aria-hidden className="size-3! shrink-0" />
      <span className="sr-only">
        {scopeKindLabel(summary)}
        {summary.branch.detached ? ", detached at" : ""}
      </span>
      <span className="truncate font-mono">{summary.branch.name}</span>
    </span>
  );
}

/**
 * Settled Agent Sessions are de-emphasised, not hidden (ADR 0006): they are still readable, still
 * Revivable, and still on disk until their retention window closes.
 *
 * Still a native `<details>` — keyboard-accessible for free and expanded by the browser for
 * find-in-page — now wearing `SidebarGroupLabel` on its `<summary>`, which is upstream shadcn's own
 * shape for a collapsible group. It keeps its own tab stop, deliberately: it is one control whose
 * cost does not grow with the list, and it is not an Agent Session, so it has no place in the row
 * cursor. Because a flex `<summary>` loses its native marker, the chevron is drawn.
 */
function SettledGroup({
  count,
  open,
  onOpenChange,
  children,
}: {
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <SidebarGroup className="p-0">
      <details open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
        <SidebarGroupLabel
          render={<summary className="cursor-default gap-1 text-muted-foreground select-none" />}
        >
          <ChevronDown aria-hidden className={cn("transition-transform", !open && "-rotate-90")} />
          Settled · {count}
        </SidebarGroupLabel>
        {/* Reduced contrast here; full contrast once one of them is focused in a pane. */}
        <SidebarGroupContent className="opacity-60">{children}</SidebarGroupContent>
      </details>
    </SidebarGroup>
  );
}

/**
 * The footer, and the way into the Settings.
 *
 * The gear leads the row rather than trailing it: the Settings are the one thing here that is not
 * about the Agent Sessions above, and the bottom-left of the rail is where every app a reader has
 * met puts them. The link dot keeps the far end.
 *
 * No keyboard hints. They advertised two keys out of the whole table, one of which (`/`) no longer
 * exists — find-in-page moved to Cmd-F — and the Settings' Keyboard page lists every binding there
 * is. A footer that teaches an arbitrary two, wrongly, is worse than one that teaches none.
 */
function RailFooter({
  link,
  onOpenSettings,
}: {
  link: LinkState | undefined;
  onOpenSettings: () => void;
}) {
  return (
    <SidebarFooter className="flex-row items-center gap-2 border-t border-sidebar-border py-1.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon"
              variant="ghost"
              className="-ml-1 size-6 shrink-0"
              onClick={() => onOpenSettings()}
            />
          }
        >
          <Settings aria-hidden />
          {/* Named for what it opens, not for the glyph: this is the only label a reader gets. */}
          <span className="sr-only">Settings</span>
        </TooltipTrigger>
        <TooltipContent>Settings</TooltipContent>
      </Tooltip>

      <LinkDot link={link} />
    </SidebarFooter>
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
 *
 * The other two states used to be `--chart-2` and `--chart-4`, which rhea renders as two greys a
 * hair apart. They take the Agent Session dot's shape vocabulary instead — filled when the stream is
 * live, a ring while it is still trying — and the word beside them was always the real signal.
 */
function LinkDot({ link }: { link: LinkState | undefined }) {
  if (link === undefined) return null;
  return (
    <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 rounded-full",
          link === "gone" ? "bg-destructive" : link === "live" ? "bg-current" : "border border-current",
        )}
      />
      {link}
    </span>
  );
}
