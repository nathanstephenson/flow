import { memo, useMemo, useState, type ReactNode } from "react";

import { parseMarkdown } from "@client/markdown.ts";
import type { Entry } from "@client/reduce.ts";
import { toolSummary } from "@client/tool-summary.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { EditDiffView, ToolPayloadView } from "@/components/edit-diff-view.tsx";
import { Markdown } from "@/components/markdown.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * One Entry of the Presentation Transcript.
 *
 * **The props are `{ entry, query }` and nothing else, by contract.** Both are a primitive or a
 * stable object, so `memo` actually holds and a streamed snapshot re-renders exactly one row. Every
 * callback, inline object, inline style or `className` added to this signature breaks that silently,
 * with no failing test to catch it — it is the single largest maintenance risk in this front end. If
 * a row needs to *do* something, it dispatches to context; it does not take a handler.
 *
 * The visual rules all follow from one sentence: the Presentation Transcript is a document. So there
 * are no cards around content, no bubbles and no alternating row backgrounds — 1px lines separate,
 * and a 2ch gutter carries one glyph per kind, reusing the vocabulary `src/tui/render.ts` already
 * prints so the two front-ends read the same way.
 *
 * What a model writes is markdown, so it is lexed (`src/client/markdown.ts`) and rendered as a
 * document rather than shown as its own source. Prose is therefore the chrome font, and monospace is
 * spent only where alignment is the point: a code span, a fenced block, and the tool payloads and
 * diffs below, which are not prose and never pass through the markdown renderer.
 */
export type TranscriptEntryProps = { entry: Entry; query: string; sessionId: string };

export const TranscriptEntry = memo(function TranscriptEntry({ entry, query, sessionId }: TranscriptEntryProps) {
  switch (entry.kind) {
    case "user":
      return <UserEntryView entry={entry} query={query} sessionId={sessionId} />;
    case "assistant":
      return <AssistantEntryView entry={entry} query={query} />;
    case "thinking":
      return <ThinkingEntryView entry={entry} query={query} />;
    case "tool":
      return <ToolCallEntryView entry={entry} query={query} />;
    case "delegation":
      return <DelegationEntryView entry={entry} query={query} />;
    case "notice":
      return <NoticeEntryView entry={entry} query={query} />;
    case "marker":
      return <TranscriptMarker entry={entry} />;
  }
});

type Of<K extends Entry["kind"]> = Extract<Entry, { kind: K }>;

/**
 * A left rule and not a background. A filled block behind the human's own words is a chat bubble,
 * and a bubble is the one shape that would make this stop reading as a document.
 */
function UserEntryView({ entry, query, sessionId }: { entry: Of<"user">; query: string; sessionId: string }) {
  const blocks = useMemo(() => parseMarkdown(entry.text), [entry.text]);
  return (
    <Row gutter=">" gutterClassName="text-primary">
      <div className="border-l-2 border-border pl-2 font-medium">
        {entry.attachments?.length ? <Attachments ids={entry.attachments} sessionId={sessionId} /> : null}
        <Markdown blocks={blocks} query={query} />
      </div>
    </Row>
  );
}

/**
 * The Attachments a message carried, above its words — the order the model received them in, and the
 * order they were composed in.
 *
 * **This is not the thing ADR 0012 refuses.** That decision will not fetch an image a *model* named
 * in its markdown, because a remote image in a transcript is a tracking pixel with extra steps.
 * These are bytes the Session Host holds, put there by the person reading this, served from its own
 * origin under the same bearer check as everything else — so a plain `src` works without the page
 * handling the token, and no third party learns that the transcript was opened.
 *
 * Capped in height rather than shown full size: a pasted screenshot is often taller than the pane,
 * and a transcript where one Entry pushes the rest off the screen has stopped being a document.
 */
function Attachments({ ids, sessionId }: { ids: string[]; sessionId: string }) {
  return (
    <div className="mb-2 flex flex-wrap gap-2">
      {ids.map((id) => (
        <img
          key={id}
          src={`/api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(id)}`}
          alt=""
          className="max-h-64 max-w-full rounded-md border border-border"
        />
      ))}
    </div>
  );
}

/**
 * The one place a caret earns its keep: while `final` is false the model is still writing, and a
 * blinking block after the last character says so better than any spinner in the chrome could. The
 * UI this replaces had no streaming signal at all.
 */
function AssistantEntryView({ entry, query }: { entry: Of<"assistant">; query: string }) {
  const blocks = useMemo(() => parseMarkdown(entry.text), [entry.text]);
  return (
    <Row>
      <Markdown blocks={blocks} query={query} trailing={entry.final ? undefined : <StreamingCaret />} />
    </Row>
  );
}

/**
 * Threaded into the last block of a tree rather than placed after it, so it follows the final
 * character the model has sent instead of sitting on a line of its own below the text.
 */
function StreamingCaret() {
  return (
    <span className="animate-caret-blink ml-px inline-block w-[1ch] text-primary" aria-hidden>
      ▍
    </span>
  );
}

/**
 * Reasoning is the model talking to itself, so it is set apart by italics and clamped once it is done
 * — but expanded while it streams, because watching it arrive is the only time anyone wants all of
 * it. The full text stays in the DOM either way: a clamp is a CSS decision, and ADR 0001's record of
 * what a human saw is not something to trim.
 */
function ThinkingEntryView({ entry, query }: { entry: Of<"thinking">; query: string }) {
  const [expanded, setExpanded] = useState(false);
  const blocks = useMemo(() => parseMarkdown(entry.text), [entry.text]);
  const clamped = entry.final && !expanded;

  return (
    <Row gutter="·" gutterClassName="text-muted-foreground">
      <div>
        {/* A height clamp, not `line-clamp`: that needs `display: -webkit-box`, which holds one block. */}
        <div className={cn("text-muted-foreground italic", clamped && "max-h-[4.5rem] overflow-hidden")}>
          <Markdown blocks={blocks} query={query} trailing={entry.final ? undefined : <StreamingCaret />} />
        </div>
        {entry.final ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 text-xs text-muted-foreground hover:text-foreground"
          >
            {expanded ? "less" : "more"}
          </button>
        ) : null}
      </div>
    </Row>
  );
}

/**
 * The one thing in the transcript that *is* a card, because a tool call is not prose: it is a
 * bounded, collapsible record of something that happened elsewhere. So it takes `bg-card`, and the
 * payload wells inside it take `bg-muted` — the two have to differ or the well vanishes into the
 * card that holds it. Native `<details>` rather than a component: the disclosure state survives in
 * the DOM (which an append-only transcript never unmounts), it is keyboard-accessible without a line
 * of code, and browsers expand it for find-in-page.
 *
 * An error opens itself. A failure the reader has to click to see is a failure they will not see.
 */
function ToolCallEntryView({ entry, query }: { entry: Of<"tool">; query: string }) {
  const [toggled, setToggled] = useState<boolean | undefined>(undefined);
  // Explicit intent wins; otherwise the status decides, and it decides again if the call fails
  // *after* it was rendered — which is the usual order of events.
  const open = toggled ?? entry.status === "error";
  const precis = toolSummary(entry.input);

  return (
    <div className="py-0.5 pl-[2ch]">
      <details
        open={open}
        onToggle={(event) => setToggled((event.currentTarget as HTMLDetailsElement).open)}
        className="rounded-lg border bg-card text-card-foreground"
      >
        <summary className="flex cursor-default items-center gap-2 px-3 py-2 select-none">
          <ToolStatusDot status={entry.status} />
          <span className="shrink-0 font-mono text-sm text-foreground">{entry.name}</span>
          {precis === undefined ? null : (
            <span className="truncate font-mono text-xs text-muted-foreground">{precis}</span>
          )}
          {entry.status === "running" ? (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">running…</span>
          ) : null}
        </summary>

        <div className="border-t p-3">
          <EditDiffView input={entry.input} query={query} />
          <ToolPayloadView entry={entry} query={query} />
        </div>
      </details>
    </div>
  );
}

/**
 * One Delegation: what a subagent was asked to do, and how far it has got (ADR 0015).
 *
 * The same species of thing as a tool call — bounded, and a record of work that happened elsewhere —
 * so it takes the same card shape rather than inventing a second one. It sits deeper than a tool
 * call because it is what one of those is doing, and the indent is derived from the Entry rather
 * than passed in: TranscriptEntryProps is `{ entry, query, sessionId }` and nothing else, by
 * contract, so a parent cannot hand a child row its depth.
 *
 * Waiting states name what is being waited on. "Waiting" alone is a spinner with extra steps.
 */
function DelegationEntryView({ entry, query }: { entry: Of<"delegation">; query: string }) {
  const [toggled, setToggled] = useState<boolean | undefined>(undefined);
  const open = toggled ?? entry.status === "error";
  const status = entry.waitingOn ? `waiting on ${entry.waitingOn}` : entry.status;
  const live = entry.status === "running" || entry.status === "waiting";

  return (
    <div className="py-0.5 pl-[4ch]">
      <details
        open={open}
        onToggle={(event) => setToggled((event.currentTarget as HTMLDetailsElement).open)}
        className="rounded-lg border bg-card text-card-foreground"
      >
        <summary className="flex cursor-default items-center gap-2 px-3 py-2 select-none">
          <ToolStatusDot status={entry.status === "waiting" ? "running" : delegationDot(entry.status)} />
          <span className="shrink-0 text-xs text-muted-foreground">⤷</span>
          <span className="shrink-0 font-mono text-sm text-foreground">{entry.name}</span>
          {entry.description === undefined ? null : (
            <span className="truncate font-mono text-xs text-muted-foreground">{entry.description}</span>
          )}
          {live ? <span className="ml-auto shrink-0 text-xs text-muted-foreground">{status}…</span> : null}
        </summary>

        <div className="border-t p-3 text-sm">
          <Highlighted text={entry.description ?? "No brief was recorded for this Delegation."} query={query} />
        </div>
      </details>
    </div>
  );
}

/** Aborted is a stop, not a failure: only an error earns the one coloured token. */
function delegationDot(status: Of<"delegation">["status"]): "running" | "complete" | "error" {
  if (status === "error") return "error";
  return status === "running" ? "running" : "complete";
}

/**
 * A failed tool call is one of the three things `--destructive` is spent on — rhea's only coloured
 * token, and a failure is worth it. Running is filled and finished is a quiet ring, the same "shape
 * carries the state, not only colour" rule the Agent Session dots follow. `--chart-2` used to stand
 * in for "finished" and is a grey indistinguishable from the muted text beside it.
 */
const TOOL_TONE: Record<Of<"tool">["status"], string> = {
  running: "text-foreground",
  complete: "text-muted-foreground",
  error: "text-destructive",
};

function ToolStatusDot({ status }: { status: Of<"tool">["status"] }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        TOOL_TONE[status],
        status === "complete" ? "border-[1.5px] border-current" : "bg-current",
      )}
    />
  );
}

/**
 * Distinguished by its own level, still. The UI this replaces painted every notice as a warning,
 * throwing away the `info`/`warn`/`error` the reducer records faithfully — so an informational
 * notice shouted and a real error did not stand out.
 *
 * `warn` used to be `--chart-4`, which rhea renders as a grey a shade off the muted text `info`
 * uses. The three levels are a contrast ladder now — receded, full, destructive — which is the one
 * axis a monochrome palette has three legible steps on. `error` keeps `--destructive`: a notice at
 * error level is one of the three genuine failures this app spends it on.
 */
const NOTICE_TONE: Record<Of<"notice">["level"], string> = {
  info: "text-muted-foreground",
  warn: "text-foreground",
  error: "text-destructive",
};

function NoticeEntryView({ entry, query }: { entry: Of<"notice">; query: string }) {
  const tone = NOTICE_TONE[entry.level];
  return (
    <Row gutter="!" gutterClassName={tone}>
      <p className={cn("m-0 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]", tone)}>
        <Highlighted text={entry.text} query={query} />
      </p>
    </Row>
  );
}

/**
 * ADR 0003 asks a Revive to continue the same Presentation Transcript "behind a visible marker", and
 * this is that marker made visible: a rule with a centred label, the same `──` device the TUI uses.
 *
 * It switches on `entry.marker`, never on the text. The reducer grew a distinct `marker` kind
 * precisely so no front-end has to sniff a string prefix to find out what happened.
 */
const MARKER_TONE: Record<Of<"marker">["marker"], string> = {
  // A Revive is the one of the three that *started* something, so it is the one at full contrast.
  revived: "text-primary",
  settled: "text-muted-foreground",
  dormant: "text-muted-foreground",
};

function TranscriptMarker({ entry }: { entry: Of<"marker"> }) {
  // These two read `--color-status-settled` and `--color-status-dormant` until the mapping that
  // defined them was deleted; the label already says which of the two this is.
  const tone = MARKER_TONE[entry.marker];
  return (
    <div
      className={cn("flex items-center gap-2 py-2", tone)}
      role="separator"
      aria-label={entry.text}
    >
      <span className="h-px flex-1 bg-current opacity-50" aria-hidden />
      <span className="text-xs">{entry.text}</span>
      <span className="h-px flex-1 bg-current opacity-50" aria-hidden />
    </div>
  );
}

/**
 * The 2ch gutter every kind shares, so the left edge of the text is the same column all the way
 * down the transcript regardless of which glyph precedes it. Monospaced, because that is what makes
 * 2ch a fixed width.
 */
function Row({
  gutter,
  gutterClassName,
  children,
}: {
  gutter?: string | undefined;
  gutterClassName?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[2ch_minmax(0,1fr)] gap-0 py-1">
      <span aria-hidden className={cn("font-mono text-sm select-none", gutterClassName)}>
        {gutter ?? ""}
      </span>
      {children}
    </div>
  );
}
