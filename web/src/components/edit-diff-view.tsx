import type { Entry } from "@client/reduce.ts";
import { editDiff } from "@client/diff.ts";
import { Highlighted } from "@/components/highlighted.tsx";

/**
 * A file-editing tool call, shown as the change it makes.
 *
 * **Honest about what this is.** `editDiff` returns a *before* block and then an *after* block, not
 * an interleaved unified hunk — Claude's Edit carries `old_string` and `new_string`, and there is no
 * line correspondence between them to interleave. So the two blocks sit one above the other and the
 * `-`/`+` signs carry the meaning. Dressing it up with `@@` headers would be a lie about the data,
 * and there are no line numbers because there are none to show.
 */
export function EditDiffView({ input, query }: { input: unknown; query: string }) {
  const diff = editDiff(input);
  if (!diff) return null;

  return (
    <div className="overflow-hidden rounded-sm border border-(--color-line) bg-(--color-inset)">
      {diff.path === undefined ? null : <PathHeader path={diff.path} />}
      <div className="overflow-x-auto">
        {diff.removed.map((line, index) => (
          <DiffLine key={`-${index}`} sign="-" line={line} query={query} kind="removed" />
        ))}
        {diff.added.map((line, index) => (
          <DiffLine key={`+${index}`} sign="+" line={line} query={query} kind="added" />
        ))}
      </div>
    </div>
  );
}

/** The basename is what identifies the file; the directories are context and recede. */
function PathHeader({ path }: { path: string }) {
  const cut = path.lastIndexOf("/");
  return (
    <p className="m-0 truncate border-b border-(--color-line) px-2 py-1 font-mono text-2xs">
      <span className="text-(--color-fg-faint)">{cut < 0 ? "" : `${path.slice(0, cut)}/`}</span>
      <span className="text-(--color-fg-strong)">{cut < 0 ? path : path.slice(cut + 1)}</span>
    </p>
  );
}

function DiffLine({
  sign,
  line,
  query,
  kind,
}: {
  sign: "-" | "+";
  line: string;
  query: string;
  kind: "removed" | "added";
}) {
  const removed = kind === "removed";
  return (
    <div
      className="grid grid-cols-[1.25rem_minmax(0,1fr)] font-mono text-2xs whitespace-pre"
      style={{
        backgroundColor: removed ? "var(--color-diff-del-bg)" : "var(--color-diff-add-bg)",
        color: removed ? "var(--color-diff-del-fg)" : "var(--color-diff-add-fg)",
      }}
    >
      <span className="pl-2 select-none" aria-hidden>
        {sign}
      </span>
      <span>
        <Highlighted text={line} query={query} />
      </span>
    </div>
  );
}

/**
 * What a tool was given and what it returned, in a well that recedes below the page.
 *
 * The input is skipped when the diff above already rendered it: the same payload twice is noise, and
 * the diff is the readable half. `update` is shown because a long-running tool's progress is often
 * the only thing worth watching.
 */
export function ToolPayloadView({ entry, query }: { entry: Extract<Entry, { kind: "tool" }>; query: string }) {
  const hasDiff = editDiff(entry.input) !== undefined;
  return (
    <>
      {hasDiff ? null : <Payload label="input" value={entry.input} query={query} />}
      <Payload label="update" value={entry.update} query={query} />
      <Payload label="result" value={entry.result} query={query} />
    </>
  );
}

/** Above this many characters the text is shown but not highlighted — see below. */
const HIGHLIGHT_LIMIT = 20_000;

function Payload({ label, value, query }: { label: string; value: unknown; query: string }) {
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "string" ? value : safeJson(value);
  if (text === "") return null;

  return (
    <div className="mt-1.5 first:mt-0">
      <p className="m-0 mb-0.5 font-sans text-2xs uppercase tracking-wide text-(--color-fg-faint)">{label}</p>
      <pre className="m-0 max-h-72 overflow-auto rounded-sm border border-(--color-line) bg-(--color-inset) p-2 font-mono text-2xs whitespace-pre-wrap text-(--color-fg) [overflow-wrap:anywhere]">
        {/*
         * A megabyte of tool output split into per-match segments is tens of thousands of DOM nodes
         * on a keystroke. Past the limit the text is still all there and find-in-page still finds it
         * — only the `<mark>` is dropped.
         */}
        {text.length > HIGHLIGHT_LIMIT ? text : <Highlighted text={text} query={query} />}
      </pre>
    </div>
  );
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
