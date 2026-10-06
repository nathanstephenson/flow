import type { Entry } from "@client/reduce.ts";
import { editDiff, textDiff } from "@client/diff.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { DiffText, diffLineClass } from "@/components/diff-text.tsx";
import { cn } from "@/lib/utils.ts";

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
    <div className="overflow-hidden rounded-md border bg-muted">
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
    <p className="m-0 truncate border-b px-2 py-1 font-mono text-xs">
      <span className="text-muted-foreground/70">{cut < 0 ? "" : `${path.slice(0, cut)}/`}</span>
      <span className="text-foreground">{cut < 0 ? path : path.slice(cut + 1)}</span>
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
  // Two static class strings rather than an inline style, so Tailwind's scanner sees both and the
  // colours stay tokens. `kind` is known at render time, so nothing here is assembled dynamically.
  //
  // Added was `--chart-2` until it was looked at beside its own removed block: rhea's chart tokens
  // are five zero-chroma greys, so "added" was the same grey as the muted text around it and a diff
  // read as one red thing followed by some paragraph. Red and green are what a diff means everywhere
  // else, and this is the one screen a reader arrives at with that expectation already formed.
  return (
    <div
      className={cn(
        "grid grid-cols-[1.25rem_minmax(0,1fr)] font-mono text-xs whitespace-pre",
        diffLineClass(kind),
      )}
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
  const parts = label !== "input" && text.length <= HIGHLIGHT_LIMIT ? structuredDiffParts(value) : undefined;

  return (
    <div className="mt-1.5 first:mt-0">
      <p className="m-0 mb-1 text-xs text-muted-foreground">{label}</p>
      {parts ? parts.map((part) => (
        <Payload key={part.label} label={part.label} value={part.text} query={query} />
      )) : (
        <pre className="m-0 max-h-72 overflow-auto rounded-md border bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]">
          {/*
           * A megabyte of tool output split into per-match segments is tens of thousands of DOM nodes
           * on a keystroke. Past the limit the text is still all there and find-in-page still finds it
           * — only the `<mark>` is dropped.
           */}
          {text.length > HIGHLIGHT_LIMIT ? text : <DiffText text={text} query={query} />}
        </pre>
      )}
    </div>
  );
}

/** Pi/MCP results wrap text blocks in content. Unwrap only real diffs, keeping every other field. */
function structuredDiffParts(value: unknown): { label: string; text: string }[] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const content = record["content"];
  if (!Array.isArray(content)) return undefined;
  const diffText = (block: unknown): string | undefined => {
    if (!block || typeof block !== "object") return undefined;
    const fields = block as Record<string, unknown>;
    return fields["type"] === "text" && typeof fields["text"] === "string" && textDiff(fields["text"])
      ? fields["text"] : undefined;
  };
  if (!content.some((block) => diffText(block) !== undefined)) return undefined;

  const parts = content.flatMap((block, index) => {
    const text = diffText(block);
    const label = `content ${index + 1}`;
    if (text === undefined) return [{ label, text: safeJson(block) }];
    const { type: _type, text: _text, ...metadata } = block as Record<string, unknown>;
    const parts = [{ label: `${label} (text)`, text }];
    if (Object.keys(metadata).length > 0) parts.push({ label: `${label} metadata`, text: safeJson(metadata) });
    return parts;
  });
  const { content: _content, ...metadata } = record;
  if (Object.keys(metadata).length > 0) parts.push({ label: "metadata", text: safeJson(metadata) });
  return parts;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}
