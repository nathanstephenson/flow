import { memo, useState, type CSSProperties, type ReactNode } from "react";

import type { Entry } from "@client/reduce.ts";
import { toolSummary } from "@client/tool-summary.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { EditDiffView, ToolPayloadView } from "@/components/edit-diff-view.tsx";
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
 * are no cards around content, no bubbles, no shadows and no alternating row backgrounds — 1px lines
 * separate, and a 2ch gutter carries one glyph per kind, reusing the vocabulary `src/tui/render.ts`
 * already prints so the two front-ends read the same way.
 */
export type TranscriptEntryProps = { entry: Entry; query: string };

export const TranscriptEntry = memo(function TranscriptEntry({ entry, query }: TranscriptEntryProps) {
  switch (entry.kind) {
    case "user":
      return <UserEntryView entry={entry} query={query} />;
    case "assistant":
      return <AssistantEntryView entry={entry} query={query} />;
    case "thinking":
      return <ThinkingEntryView entry={entry} query={query} />;
    case "tool":
      return <ToolCallEntryView entry={entry} query={query} />;
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
function UserEntryView({ entry, query }: { entry: Of<"user">; query: string }) {
  return (
    <Row gutter=">" gutterClassName="text-(--color-accent)">
      <p className="m-0 border-l border-(--color-accent-quiet) pl-2 font-mono text-base font-medium whitespace-pre-wrap text-(--color-accent-strong) [overflow-wrap:anywhere]">
        <Highlighted text={entry.text} query={query} />
      </p>
    </Row>
  );
}

/**
 * The one place a caret earns its keep: while `final` is false the model is still writing, and a
 * blinking block after the last character says so better than any spinner in the chrome could. The
 * UI this replaces had no streaming signal at all.
 */
function AssistantEntryView({ entry, query }: { entry: Of<"assistant">; query: string }) {
  return (
    <Row>
      <p className="m-0 font-mono text-base whitespace-pre-wrap text-(--color-fg) [overflow-wrap:anywhere]">
        <Highlighted text={entry.text} query={query} />
        {entry.final ? null : (
          <span className="animate-caret-blink ml-px inline-block w-[1ch] text-(--color-accent)" aria-hidden>
            ▍
          </span>
        )}
      </p>
    </Row>
  );
}

/**
 * Reasoning is the model talking to itself, so it is set apart by hue and italics and clamped once it
 * is done — but expanded while it streams, because watching it arrive is the only time anyone wants
 * all of it. The full text stays in the DOM either way: a clamp is a CSS decision, and ADR 0001's
 * record of what a human saw is not something to trim.
 */
function ThinkingEntryView({ entry, query }: { entry: Of<"thinking">; query: string }) {
  const [expanded, setExpanded] = useState(false);
  const clamped = entry.final && !expanded;

  return (
    <Row gutter="·" gutterClassName="text-(--color-thinking)">
      <div>
        <p
          className={cn(
            "m-0 font-mono text-base italic whitespace-pre-wrap text-(--color-thinking) [overflow-wrap:anywhere]",
            clamped && "line-clamp-3",
          )}
        >
          <Highlighted text={entry.text} query={query} />
        </p>
        {entry.final ? (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 font-sans text-2xs text-(--color-fg-faint) hover:text-(--color-fg-muted)"
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
 * bounded, collapsible record of something that happened elsewhere. Native `<details>` rather than a
 * component — the disclosure state survives in the DOM (which an append-only transcript never
 * unmounts), it is keyboard-accessible without a line of code, and browsers expand it for
 * find-in-page.
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
        className="rounded-sm border border-(--color-line) bg-(--color-surface-2)"
      >
        <summary className="flex cursor-default items-center gap-2 px-2 py-1 select-none">
          <ToolStatusDot status={entry.status} />
          <span className="shrink-0 font-mono text-xs text-(--color-fg-strong)">{entry.name}</span>
          {precis === undefined ? null : (
            <span className="truncate font-mono text-2xs text-(--color-fg-muted)">{precis}</span>
          )}
          {entry.status === "running" ? (
            <span className="ml-auto shrink-0 font-sans text-2xs text-(--color-fg-faint)">running…</span>
          ) : null}
        </summary>

        <div className="border-t border-(--color-line) p-2">
          <EditDiffView input={entry.input} query={query} />
          <ToolPayloadView entry={entry} query={query} />
        </div>
      </details>
    </div>
  );
}

/**
 * A running tool gets the accent, a failed one the error hue, a finished one nothing but a quiet
 * ring — the same "shape carries the state, not only colour" rule the Agent Session dots follow.
 */
function ToolStatusDot({ status }: { status: Of<"tool">["status"] }) {
  const color =
    status === "error" ? "var(--color-err)" : status === "running" ? "var(--color-accent)" : "var(--color-ok)";
  return (
    <span
      aria-hidden
      className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
      style={status === "complete" ? { border: `1.5px solid ${color}` } : { backgroundColor: color }}
    />
  );
}

/**
 * Coloured by its own level. The UI this replaces painted every notice as a warning, throwing away
 * the `info`/`warn`/`error` the reducer records faithfully — so an informational notice shouted and
 * a real error did not stand out.
 */
function NoticeEntryView({ entry, query }: { entry: Of<"notice">; query: string }) {
  const color =
    entry.level === "error"
      ? "var(--color-err)"
      : entry.level === "warn"
        ? "var(--color-warn)"
        : "var(--color-fg-muted)";
  return (
    <Row gutter="!" gutterStyle={{ color }}>
      <p className="m-0 font-mono text-base whitespace-pre-wrap [overflow-wrap:anywhere]" style={{ color }}>
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
function TranscriptMarker({ entry }: { entry: Of<"marker"> }) {
  const color =
    entry.marker === "revived"
      ? "var(--color-accent)"
      : entry.marker === "settled"
        ? "var(--color-status-settled)"
        : "var(--color-status-dormant)";
  return (
    <div className="flex items-center gap-2 py-2" role="separator" aria-label={entry.text}>
      <span className="h-px flex-1" style={{ backgroundColor: color, opacity: 0.5 }} aria-hidden />
      <span className="font-sans text-2xs uppercase tracking-wide" style={{ color }}>
        {entry.text}
      </span>
      <span className="h-px flex-1" style={{ backgroundColor: color, opacity: 0.5 }} aria-hidden />
    </div>
  );
}

/**
 * The 2ch gutter every kind shares, so the left edge of the text is the same column all the way
 * down the transcript regardless of which glyph precedes it.
 */
function Row({
  gutter,
  gutterClassName,
  gutterStyle,
  children,
}: {
  gutter?: string | undefined;
  gutterClassName?: string | undefined;
  gutterStyle?: CSSProperties | undefined;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[2ch_minmax(0,1fr)] gap-0 py-1">
      <span
        aria-hidden
        className={cn("font-mono text-base select-none", gutterClassName)}
        style={gutterStyle}
      >
        {gutter ?? ""}
      </span>
      {children}
    </div>
  );
}
