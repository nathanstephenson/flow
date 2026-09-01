/**
 * A one-line précis of a tool call's arguments.
 *
 * A collapsed tool call that says only `[complete] Edit` withholds the one thing a reader wants —
 * which file, which command, which pattern. The TUI prints exactly that today (`render.ts:79`), so
 * this lives beside the reducer and stays DOM-free: it returns a string, and both front-ends can
 * print a string.
 */

/** About a line in the narrower of two panes. A précis that needs scrolling is not a précis. */
const MAX = 60;

type Argument = { key: string; shape: "path" | "text" };

/**
 * Ordered, because a tool's input usually carries several of these and the first is the one the
 * question is about: a Bash call's `command` before its `description`, a Grep's `pattern` before the
 * directory it searched.
 *
 * Keyed on the shape of the arguments rather than on the tool's name, because the name is the part
 * that varies: Claude's `Edit` and a pi tool that edits a file are not called the same thing, while
 * `file_path` means the same in both. An unrecognised tool with a recognisable argument still reads.
 */
const ARGUMENTS: readonly Argument[] = [
  { key: "command", shape: "text" },
  { key: "file_path", shape: "path" },
  { key: "notebook_path", shape: "path" },
  { key: "pattern", shape: "text" },
  { key: "url", shape: "text" },
  { key: "query", shape: "text" },
  { key: "path", shape: "path" },
  { key: "description", shape: "text" },
  { key: "prompt", shape: "text" },
];

/**
 * Returns undefined when there is nothing worth saying, so a caller renders the tool's name alone
 * rather than a padded blank. `input` is `unknown` on the wire (`events.ts` — a Backend Adapter
 * passes its backend's arguments through), so every access is narrowed rather than trusted.
 */
export function toolSummary(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;

  for (const argument of ARGUMENTS) {
    const value = record[argument.key];
    if (typeof value !== "string" || value.trim() === "") continue;
    return argument.shape === "path" ? clipPath(value.trim()) : clipText(value);
  }

  // The fallback: a tool nobody here has heard of, whose input is a single string, is describing
  // itself with that string. Two or more and there is no way to know which one matters, so say
  // nothing rather than pick.
  const strings = Object.values(record).filter((value): value is string => typeof value === "string");
  const only = strings.length === 1 ? strings[0] : undefined;
  return only && only.trim() !== "" ? clipText(only) : undefined;
}

/** Whitespace collapsed so a heredoc or a multi-line prompt still occupies one line. */
function clipText(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length <= MAX ? text : `${text.slice(0, MAX - 1)}…`;
}

function clipPath(path: string): string {
  // The tail of a path is what identifies the file; the leading directories are what a reader can
  // afford to lose, which is the opposite of how everything else here truncates.
  return path.length <= MAX ? path : `…${path.slice(-(MAX - 1))}`;
}
