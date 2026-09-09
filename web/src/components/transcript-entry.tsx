import { memo, useMemo, useState, type ReactNode } from "react";

import { parseMarkdown } from "@client/markdown.ts";
import type { Entry } from "@client/reduce.ts";
import { authorisationLabel } from "@client/permission.ts";
import { toolSummary } from "@client/tool-summary.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { useOpenSubagent } from "@/components/subagent-open.tsx";
import { entryKey } from "@/presentation/entry-key.ts";
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
    case "subagent":
      return <SubagentEntryView entry={entry} query={query} />;
    case "enquiry":
      return <EnquiryEntryView entry={entry} query={query} />;
    case "notice":
      return <NoticeEntryView entry={entry} query={query} />;
    case "marker":
      return <TranscriptMarker entry={entry} />;
    default: {
      // An Entry kind this file has not thought about is a compile error here, not a row that
      // renders nothing. `reduce.ts`, the TUI and the CLI already fail this way; this file did not,
      // which made a missing case invisible in the one front-end that shows it.
      //
      // Unreachable at runtime, and returning null rather than throwing for that reason. `Entry` is
      // built in memory by the reducer this bundle ships with, so unlike a durable `AgentEvent`
      // there is no older-client-newer-daemon skew for it to survive.
      const unhandled: never = entry;
      void unhandled;
      return null;
    }
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
  // Only where somebody was asked. Absent is the common case — pre-approved, or already carrying a
  // Standing Authorisation — and a badge on every row would imply a judgement nobody made.
  const authorised = authorisationLabel(entry.authorisation);

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
            <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{precis}</span>
          )}
          {/*
            * `ml-auto` here rather than on the running label, so the two cannot both claim the right
            * edge — a call awaiting authorisation is running, and would otherwise print both.
            *
            * `denied` and `asked` are the two worth colouring: one is a refusal a reader is looking
            * for when the answer came back thin, and the other is the row the composer is waiting
            * on. An ordinary authorised call is a footnote and is styled as one.
            */}
          {authorised ? (
            <span
              className={cn(
                "ml-auto shrink-0 text-xs",
                entry.authorisation === "denied" || entry.authorisation === "asked"
                  ? "text-destructive"
                  : "text-muted-foreground",
              )}
            >
              {authorised}
            </span>
          ) : entry.status === "running" ? (
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
 * That a Subagent was started, and how far it has got (ADR 0015).
 *
 * Deliberately not expandable, and deliberately not the work itself. What a Subagent did lives in
 * the Agents tab: interleaved here it read as the session's own work, and with two running at once
 * it read as nobody's in particular — a flat list ordered by `seq` has one axis and parallel work
 * needs two. So this row is the notice, and the tab is the record.
 *
 * Waiting states name what is being waited on. "Waiting" alone is a spinner with extra steps.
 */
/**
 * What the model asked, and what it was told.
 *
 * **No controls.** A live Enquiry renders here as a card and nothing more; the answering surface is
 * the composer and only the composer. Two answering surfaces for one Enquiry is two cursors, two
 * selections and one blocked turn — and the duplication with the open picker is the same duplication
 * `SubagentStrip` has with the Subagent rows, which reads the same way.
 *
 * The chosen labels come off the Entry rather than the tool result beside it, because the SDK writes
 * that result as prose: reading it back would be parsing an English sentence to recover what this
 * client's own user clicked.
 */
function EnquiryEntryView({ entry, query }: { entry: Of<"enquiry">; query: string }) {
  return (
    <div className="py-0.5 pl-[2ch]">
      <div className="w-full rounded-lg border bg-card px-3 py-2 text-card-foreground">
        <div className="flex items-center gap-2">
          <ToolStatusDot status={entry.status === "asked" ? "running" : entry.status === "answered" ? "complete" : "error"} />
          <span className="shrink-0 text-xs text-muted-foreground">?</span>
          <span className="shrink-0 font-mono text-sm">
            {entry.questions.length === 1 ? "Asked a question" : `Asked ${entry.questions.length} questions`}
          </span>
          <span className="ml-auto shrink-0 text-xs text-muted-foreground">
            {entry.status === "asked" ? "waiting…" : entry.status}
          </span>
        </div>
        <dl className="mt-1 space-y-1">
          {entry.questions.map((question, index) => {
            const chosen = entry.answers?.[index] ?? [];
            return (
              <div key={question.question} className="text-sm">
                <dt className="text-xs text-muted-foreground">
                  <Highlighted text={question.question} query={query} />
                </dt>
                <dd className={cn("font-medium", chosen.length === 0 && "text-muted-foreground italic")}>
                  {chosen.length === 0 ? (
                    entry.status === "asked" ? "unanswered" : "no answer"
                  ) : (
                    <Highlighted text={chosen.join(", ")} query={query} />
                  )}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
    </div>
  );
}

function SubagentEntryView({ entry, query }: { entry: Of<"subagent">; query: string }) {
  const status = entry.waitingOn ? `waiting on ${entry.waitingOn}` : entry.status;
  const live = entry.status === "running" || entry.status === "waiting";
  const open = useOpenSubagent();

  const body = (
    <>
      <ToolStatusDot status={entry.status === "waiting" ? "running" : subagentDot(entry.status)} />
      <span className="shrink-0 text-xs text-muted-foreground">⤷</span>
      <span className="shrink-0 font-mono text-sm text-foreground">{entry.name}</span>
      {entry.description === undefined ? null : (
        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
          <Highlighted text={entry.description} query={query} />
        </span>
      )}
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">{live ? `${status}…` : status}</span>
    </>
  );

  const shell = "flex w-full items-center gap-2 rounded-lg border bg-card px-3 py-2 text-card-foreground";

  return (
    <div className="py-0.5 pl-[2ch]">
      {open === undefined ? (
        // Inert where there is nowhere to send a reader, rather than a click that goes nowhere.
        <div className={shell}>{body}</div>
      ) : (
        <button type="button" onClick={() => open(entryKey(entry))} className={cn(shell, "text-left hover:bg-accent")}>
          {body}
        </button>
      )}
    </div>
  );
}

/** Aborted is a stop, not a failure: only an error earns the one coloured token. */
function subagentDot(status: Of<"subagent">["status"]): "running" | "complete" | "error" {
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

export function ToolStatusDot({ status }: { status: Of<"tool">["status"] }) {
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
  // A Revive is the one that *started* something, so it is the one at full contrast.
  revived: "text-primary",
  settled: "text-muted-foreground",
  dormant: "text-muted-foreground",
  // Receded with the other two: compaction is something a reader wants to be able to find later,
  // not something to interrupt them with. It is also the only marker that can appear mid-turn.
  compacted: "text-muted-foreground",
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
