import type { Entry } from "../../../src/client/reduce.ts";
import { editDiff } from "../../../src/client/diff.ts";

export type ToolKind = "shell" | "read" | "write" | "edit" | "search" | "list" | "web" | "agent" | "todo" | "mcp" | "other";

const KINDS: [RegExp, ToolKind][] = [
  [/^mcp__/, "mcp"],
  [/^(bash|shell|exec|run_?command)$/, "shell"],
  [/^(read|read_?file|view|notebookread)$/, "read"],
  [/^(write|write_?file|create_?file|notebookedit)$/, "write"],
  [/^(edit|multi_?edit|str_replace(_based_edit_tool|_editor)?|apply_?patch)$/, "edit"],
  [/^(grep|search|ripgrep)$/, "search"],
  [/^(glob|ls|list|find|list_?directory)$/, "list"],
  [/^(web_?fetch|web_?search|fetch)$/, "web"],
  [/^(task|agent)$/, "agent"],
  [/^todo_?write$/, "todo"],
];

export function toolKind(name: string): ToolKind {
  const lower = name.toLowerCase();
  return KINDS.find(([pattern]) => pattern.test(lower))?.[1] ?? "other";
}

/** The text of a result: a plain string, or the text blocks of a content array. */
export function resultText(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const blocks = Array.isArray(result)
    ? result
    : result !== null && typeof result === "object" && Array.isArray((result as { content?: unknown }).content)
      ? (result as { content: unknown[] }).content
      : undefined;
  if (!blocks) return undefined;
  const texts = blocks.flatMap((block) =>
    block !== null && typeof block === "object" && typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : [],
  );
  return texts.length > 0 ? texts.join("\n") : undefined;
}

function count(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  return text.split("\n").filter((line) => line.trim() !== "").length;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** What a finished call came to, in a few words for the end of its row. Undefined when unsure. */
export function toolOutcome(entry: Extract<Entry, { kind: "tool" }>): string | undefined {
  if (entry.status === "error") return "failed";
  if (entry.status !== "complete") return undefined;
  const diff = editDiff(entry.input);
  if (diff) return `+${diff.added.length} −${diff.removed.length}`;
  const lines = count(resultText(entry.result));
  if (lines === undefined) return undefined;
  switch (toolKind(entry.name)) {
    case "read": return plural(lines, "line");
    case "list": return plural(lines, "file");
    case "search": return plural(lines, "result");
    default: return undefined;
  }
}
