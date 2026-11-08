import { ChevronDown, CircleCheck, FolderGit2, GitBranch, Pin, PinOff, Plus, Settings } from "lucide-react";
import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import type { SessionStatus, SessionSummary } from "../../../src/protocol/commands.ts";
import { relativeTime } from "@client/relative-time.ts";
import { sessionLabel } from "@client/session-label.ts";
import { scopeKindLabel } from "@client/scope-kind.ts";
import { projectName } from "@client/project-name.ts";
import { canSettle, railGroupLabel, working } from "@client/status.ts";
import {
  collapsible,
  railSection,
  RAIL_SECTIONS,
  type CollapsibleRailSection,
  type RailSection,
} from "@/presentation/rail-sections.ts";
import { activityStatusText } from "@/presentation/activity.ts";
import { BackendIcon } from "@/components/backend-icon.tsx";
import { statusIndicatorColor } from "@/components/status-indicator.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";
import { useNow } from "@/lib/use-now.ts";
import "./agent-session-nav.css";

/**
 * The Agent Session rail, and the app's status board. Exactly one Agent Session is on screen at a
 * time, so the rail carries the state of the rest: a status edge, attention and a relative time per
 * row are enough to *monitor* any number of them without *reading* them.
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
 * - The Working, Idle and Settled groups are disclosures nested in the list, and a non-tab control inside a tablist is
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
  /** Closed sections hide their rows from the pointer and the keyboard cursor. */
  openSections: ReadonlySet<CollapsibleRailSection>;
  onSectionOpenChange: (section: CollapsibleRailSection, open: boolean) => void;
  /** Pinned sessions show below Unread, whatever their activity, until they are Settled. */
  pinned: ReadonlySet<string>;
  onPinnedChange: (sessionId: string, pinned: boolean) => void;
  onFocus: (sessionId: string) => void;
  onSettle: (sessionId: string) => void;
  onNew: () => void;
  onOpenSettings: () => void;
};

export function AgentSessionNav(props: AgentSessionNavProps) {
  const now = useNow();
  const { isMobile, setOpenMobile } = useSidebar();
  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const navigationProps: AgentSessionNavProps = {
    ...props,
    onFocus: (sessionId) => {
      props.onFocus(sessionId);
      closeMobile();
    },
    onNew: () => {
      props.onNew();
      closeMobile();
    },
    onOpenSettings: () => {
      props.onOpenSettings();
      closeMobile();
    },
  };
  const grouped = new Map(RAIL_SECTIONS.map((section) => [section, [] as SessionSummary[]]));
  for (const session of props.sessions) grouped.get(railSection(session, props.pinned))?.push(session);
  const sections = RAIL_SECTIONS.map((section) => ({ section, sessions: grouped.get(section)! }))
    .filter(({ sessions }) => sessions.length > 0);
  const attentionSections = sections.filter(({ section }) => !collapsible(section));
  const collapsibleSections = sections.filter(
    (entry): entry is { section: CollapsibleRailSection; sessions: SessionSummary[] } => collapsible(entry.section),
  );
  const menu = (section: RailSection, sessions: SessionSummary[]) => (
    <AgentSessionMenu
      {...navigationProps}
      label={`${sectionLabel(section, sessions)} Agent Sessions`}
      sessions={sessions}
      now={now}
    />
  );
  const cursorSession = props.sessions.find((session) => session.id === props.cursorId);
  const cursorSectionId = cursorSession ? railSection(cursorSession, props.pinned) : undefined;

  const list = useRef<HTMLDivElement>(null);
  const rowHasFocus = useRef(false);

  /**
   * Focus follows the cursor, but only while a row already has it. Focus events remember ownership
   * before React mutates the DOM: layout cleanups can run after the cursor attribute has changed or
   * the focused row has been removed, so querying the cursor there loses the old focus owner.
   *
   * A layout effect keeps the roving tabindex and DOM focus in the same paint. Group identity is a
   * dependency because an attention transition can reparent the cursor row without changing it.
   */
  useLayoutEffect(() => {
    const container = list.current;
    if (!container) return;
    const focused = document.activeElement;
    const cursor = container.querySelector<HTMLElement>('[data-cursor="true"]');
    const cursorItem = cursor?.closest<HTMLElement>('[data-sidebar="menu-item"]');
    if (rowHasFocus.current && cursor && !cursorItem?.contains(focused)) cursor.focus();
  }, [props.cursorId, cursorSectionId]);

  return (
    <>

      {/*
       * Left/Right are the rail's own: they reach the row's own action without leaving the row, and
       * they are the only keys this component handles — everything vertical is resolved centrally
       * so there is one cursor rather than two.
       */}
      <SidebarContent
        ref={list}
        className="gap-0 overflow-hidden"
        onKeyDown={moveWithinRow}
        onFocusCapture={(event) => {
          rowHasFocus.current = event.target.closest('[data-sidebar="menu-item"]') !== null;
        }}
        onBlurCapture={(event) => {
          // Removing a focused row can leave focus on body without a blur event. If a browser does
          // emit one for removal, it is not an intentional departure from the rail either.
          if (event.target.isConnected) rowHasFocus.current = false;
        }}
      >
        <div className="transcript-scroller max-h-1/2 shrink-0 overflow-y-auto">
          {attentionSections.map(({ section, sessions }) => (
            <SidebarGroup key={section} className="p-0">
              <SidebarGroupContent>{menu(section, sessions)}</SidebarGroupContent>
            </SidebarGroup>
          ))}
        </div>

        {collapsibleSections.length > 0 ? (
          <div className="mt-auto flex min-h-0 flex-col border-t border-sidebar-border">
            {collapsibleSections.map(({ section, sessions }) => (
              <CollapsibleGroup
                key={section}
                label={sectionLabel(section, sessions)}
                count={sessions.length}
                open={props.openSections.has(section)}
                onOpenChange={(open) => props.onSectionOpenChange(section, open)}
              >
                {menu(section, sessions)}
              </CollapsibleGroup>
            ))}
          </div>
        ) : null}

        {props.sessions.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">No Agent Sessions yet.</p>
        ) : null}
      </SidebarContent>

      <RailFooter onNew={navigationProps.onNew} onOpenSettings={navigationProps.onOpenSettings} />
    </>
  );
}

/**
 * `ArrowRight` and `ArrowLeft` step through one row's controls: the row itself, then settle where the
 * status permits one. Two at most, but still expressed as a step through the row's controls rather
 * than as "focus the settle button" — that is the same amount of code and does not have to be
 * rewritten the day a row grows a second action. Delegated from the list rather than bound per row,
 * so the number of listeners does not grow with the number of Agent Sessions.
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

type MenuProps = AgentSessionNavProps & { sessions: SessionSummary[]; now: number; label: string };

function AgentSessionMenu({ sessions, now, label, ...props }: MenuProps) {
  return (
    /* Inset rounded rows with a small gap, the same shape as the Agents tab rows. */
    <SidebarMenu className="gap-1 px-2 py-0.5" aria-label={label}>
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
          pinned={props.pinned.has(session.id)}
          onPinnedChange={props.onPinnedChange}
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
  pinned: boolean;
  onPinnedChange: (sessionId: string, pinned: boolean) => void;
};

function AgentSessionRow({
  summary,
  now,
  status,
  selected,
  cursored,
  onFocus,
  onSettle,
  pinned,
  onPinnedChange,
}: RowProps) {
  /**
   * The roving tabindex, in one expression. Only the cursor row is reachable by `Tab`; its action
   * comes with it, so the whole rail is a constant number of tab stops no matter how many Agent
   * Sessions exist. Without this, twenty Agent Sessions put forty tab stops between the keyboard and
   * the Presentation Transcript.
   */
  const tabIndex = cursored ? 0 : -1;
  const isWorking = working({ ...summary, status });
  const statusAccent = status === "running" || status === "awaiting" || (status === "idle" && isWorking);

  return (
    /* Upstream's own shape, kept: a `relative` item with the action positioned over the row rather
       than beside it. A flex line here instead would shrink the button to less than the row, and the
       selection highlight would visibly stop short of the action. */
    <SidebarMenuItem className="cursor-tilt rounded-lg">
      <SidebarMenuButton
        size="lg"
        isActive={selected}
        // A list with one current row, not a tablist — see this file's header.
        aria-current={selected ? "true" : undefined}
        data-cursor={cursored ? "true" : undefined}
        data-status-accent={statusAccent ? "true" : undefined}
        style={{ "--agent-session-status": statusIndicatorColor(status, isWorking) } as CSSProperties}
        tabIndex={tabIndex}
        onClick={() => onFocus(summary.id)}
        className={cn(
          // `pr-8` is
          // upstream's reservation for an overlaid action — applied unconditionally rather than
          // through its `group-has-[…menu-action]` guard, because whether a row can be Settled
          // changes with its status and the title must not reflow when it does.
          // `size="lg"` fixes the height at h-12, which fit the two lines this row had and clips the
          // third; `h-auto` hands the height back to the content, so a row is as tall as it has
          // something to say and a Scope that is not a repository stays two lines. p-2 would clip
          // the lines against the button's own `overflow-hidden`, so the padding stays py-1.5.
          // The keyboard-only focus outline lives inside the face, clear of the status edge.
          // The retained cursor controls tab order, not decoration outside the rail.
          "agent-session-row cursor-gloss h-auto rounded-lg py-1.5 pr-8",
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn("min-w-0 flex-1 truncate text-sm", summary.attention && "font-semibold")}>
              {sessionLabel(summary)}
            </span>
          </span>
          {summary.outputPreview ? (
            <span className="block truncate text-xs text-muted-foreground">{summary.outputPreview}</span>
          ) : null}
          <ScopeLine summary={summary} />
          {summary.attention ? (
            <span className="flex items-center gap-1.5 text-xs font-medium">
              <span aria-hidden>{summary.attention.group === "needs-input" ? "!" : "●"}</span>
              <span>{summary.attention.reason}</span>
              <span className="ml-auto shrink-0 text-muted-foreground">
                {relativeTime(summary.attention.at, now)}
              </span>
            </span>
          ) : null}
          {/*
           * Backend at one end, age at the other, and no status word between them: the edge hue
           * carries visual activity while the accessible status below retains its full meaning.
           *
           * The Backend is a mark rather than its name, and the width that buys goes to the Project
           * — which is the thing a reader scanning a rail of Agent Sessions across several
           * repositories is actually looking for, and which until now only the pane header said.
           * With the branch on the line above, the two together are the whole of where an Agent
           * Session is working.
           *
           * The edge is decorative and the Backend glyph is `aria-hidden`, so their words —
           * including that Subagents are working — survive here for anyone not looking at colour.
           */}
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="sr-only agent-session-status-text">{activityStatusText({ ...summary, status })}</span>
            <BackendIcon backend={summary.backend} />
            <span className="sr-only">{summary.backend}</span>
            <span className="truncate">{projectName(summary.scope, summary.worktree)}</span>
            {/* Attention rows show the qualifying event's age above. Ordinary rows keep Resting,
                the same timestamp that orders their group. */}
            {!summary.attention ? (
              <span className="ml-auto shrink-0">{relativeTime(summary.restingAt, now)}</span>
            ) : null}
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
       * reach Pin and Settle without hovering the row first.
       *
       * No placeholder when the row cannot be Settled: the button reserves its `pr-8` regardless, so
       * there is nothing left for an absent action to move.
       */}
      {canSettle(status) ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                className="group/pin agent-session-pin cursor-gloss-transparent"
                showOnHover={!pinned}
                aria-pressed={pinned}
                tabIndex={tabIndex}
                onClick={() => onPinnedChange(summary.id, !pinned)}
              />
            }
          >
            {pinned ? (
              <>
                <Pin aria-hidden className="fill-current group-hover/pin:hidden" />
                <PinOff aria-hidden className="hidden group-hover/pin:block" />
              </>
            ) : (
              <Pin aria-hidden />
            )}
            <span className="sr-only">{pinned ? "Unpin" : "Pin"}</span>
          </TooltipTrigger>
          <TooltipContent side="right">{pinned ? "Unpin" : "Pin"}</TooltipContent>
        </Tooltip>
      ) : null}

      {canSettle(status) ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarMenuAction
                className="agent-session-settle cursor-gloss-transparent top-auto! bottom-2.5"
                showOnHover
                // `top-auto!` beats upstream's `peer-data-[size=lg]/menu-button:top-2.5` on specificity.
                tabIndex={tabIndex}
                onClick={() => onSettle(summary.id)}
              />
            }
          >
            <CircleCheck aria-hidden />
            <span className="sr-only">Settle</span>
          </TooltipTrigger>
          <TooltipContent side="right">Settle</TooltipContent>
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
 * Filed-away Agent Sessions remain readable (ADR 0006). Settled ones are Revivable;
 * Ended ones are not, so name both Lifecycles when this section contains Ended rows.
 */
function sectionLabel(section: RailSection, sessions: SessionSummary[]): string {
  if (section === "pinned") return "Pinned";
  if (section !== "filed-away") return railGroupLabel(section);
  return sessions.some((summary) => summary.status === "ended") ? "Settled / Ended" : "Settled";
}

/**
 * A native `<details>` for the toggle, keyboard-accessible for free, wearing `SidebarGroupLabel` on its `<summary>`, which is upstream shadcn's own
 * shape for a collapsible group. It keeps its own tab stop, deliberately: it is one control whose
 * cost does not grow with the list, and it is not an Agent Session, so it has no place in the row
 * cursor. Because a flex `<summary>` loses its native marker, the chevron is drawn.
 *
 * The rows sit outside `<details>`, so each open group is a flex child that scrolls when it would
 * otherwise make the rail too tall. They stay mounted but `inert` while closed, so they can animate
 * both ways. Open groups take equal shares of the space, each capped at its measured height, so a
 * short group keeps all of its rows and the tall groups share what is left.
 */
function CollapsibleGroup({
  label,
  count,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const rows = useRef<HTMLDivElement>(null);
  const [rowsHeight, setRowsHeight] = useState<number>();

  useLayoutEffect(() => {
    const element = rows.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setRowsHeight(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <SidebarGroup
      style={{
        maxHeight: open ? (rowsHeight === undefined ? "none" : `calc(2rem + ${rowsHeight}px)`) : "2rem",
        transitionDuration: `${Math.min(500, 250 + (rowsHeight ?? 0) / 2)}ms`,
      }}
      className="min-h-0 flex-1 overflow-hidden p-0 transition-[max-height] ease-out motion-reduce:transition-none"
    >
      <details className="shrink-0" open={open} onToggle={(event) => onOpenChange(event.currentTarget.open)}>
        <SidebarGroupLabel
          render={<summary className="cursor-default gap-1 text-muted-foreground select-none" />}
        >
          <ChevronDown aria-hidden className={cn("transition-transform", !open && "-rotate-90")} />
          {label} · {count}
        </SidebarGroupLabel>
      </details>
      <SidebarGroupContent inert={!open} className="transcript-scroller min-h-0 flex-1 overflow-y-auto">
        <div ref={rows}>{children}</div>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

/**
 * The footer: the Settings at the bottom-left, where every app a reader has met puts them, and a
 * new Agent Session at the far end.
 *
 * No keyboard hints. They advertised two keys out of the whole table, one of which (`/`) no longer
 * exists — find-in-page moved to Cmd-F — and the Settings' Keyboard page lists every binding there
 * is. A footer that teaches an arbitrary two, wrongly, is worse than one that teaches none.
 */
function RailFooter({ onNew, onOpenSettings }: { onNew: () => void; onOpenSettings: () => void }) {
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

      <Tooltip>
        <TooltipTrigger
          render={
            <Button size="icon" variant="ghost" className="-mr-1 ml-auto size-6 shrink-0" onClick={() => onNew()} />
          }
        >
          <Plus aria-hidden />
          <span className="sr-only">New Agent Session</span>
        </TooltipTrigger>
        <TooltipContent>New Agent Session</TooltipContent>
      </Tooltip>
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
