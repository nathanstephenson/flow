import { Fragment, type ReactNode } from "react";
import type { DiffLineKind } from "@client/diff.ts";
import { textDiff } from "@client/diff.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { cn } from "@/lib/utils.ts";

/** The same theme tokens for tool edits and verbatim diffs, in light and dark mode. */
export function diffLineClass(kind: DiffLineKind): string | undefined {
  if (kind === "removed") return "bg-destructive/10 text-destructive";
  if (kind === "added") return "bg-diff-added/10 text-diff-added";
  return undefined;
}

/** Lives inside a pre; signs and newlines remain selectable rather than being invented gutters. */
export function DiffText({ text, lang, query, trailing }: {
  text: string;
  lang?: string | undefined;
  query: string;
  trailing?: ReactNode;
}) {
  const lines = textDiff(text, lang);
  if (!lines) return <><Highlighted text={text} query={query} />{trailing}</>;
  return (
    <span className="inline-block min-w-full align-top">
      {lines.map((line, index) => {
        // Newlines outside inline-block rows preserve copied text. Block rows would add a second
        // newline to innerText/selection, even though textContent still looked right.
        const newline = line.text.endsWith("\r\n") ? "\r\n" : line.text.endsWith("\n") ? "\n" : "";
        const caret = index === lines.length - 1 ? trailing : undefined;
        return (
          <Fragment key={index}>
            <span className={cn("inline-block min-w-full min-h-[1lh] align-top", diffLineClass(line.kind))}>
              <Highlighted text={newline ? line.text.slice(0, -newline.length) : line.text} query={query} />
              {newline ? undefined : caret}
            </span>
            {newline || undefined}
            {newline ? caret : undefined}
          </Fragment>
        );
      })}
      {lines.length === 0 ? trailing : undefined}
    </span>
  );
}
