/**
 * Turning a file-editing tool call into something readable.
 *
 * Shared with the browser the same way the reducer is: types only, so stripping leaves standalone
 * ESM. Kept out of the DOM so it can be tested directly.
 */

export type EditDiff = {
  path?: string;
  removed: string[];
  added: string[];
};

/**
 * Recognises the file-editing tools whose output people actually read. Claude's Edit carries
 * `old_string`/`new_string`; Write carries `content` with nothing removed.
 */
export function editDiff(input: unknown): EditDiff | undefined {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;

  const before = typeof record["old_string"] === "string" ? record["old_string"] : undefined;
  const after =
    typeof record["new_string"] === "string"
      ? record["new_string"]
      : typeof record["content"] === "string"
        ? record["content"]
        : undefined;

  if (before === undefined && after === undefined) return undefined;

  return {
    ...(typeof record["file_path"] === "string" ? { path: record["file_path"] } : {}),
    removed: lines(before),
    added: lines(after),
  };
}

export type DiffLineKind = "added" | "removed" | "context";
export type TextDiffLine = { text: string; kind: DiffLineKind };

/**
 * Explicit diff/patch fences may contain just +/- fragments. Without that hint, require a unified
 * file header and hunk, so ordinary code and tool output are not mistaken for changes. Keep every
 * byte, including newlines, for copying and search highlighting.
 */
export function textDiff(text: string, lang?: string): TextDiffLine[] | undefined {
  const language = lang?.trim().split(/\s+/, 1)[0]?.toLowerCase();
  const explicit = language === "diff" || language === "patch";
  if (language && !explicit) return undefined;
  if (!explicit) {
    const fileHeader = /^--- [^\n]*\n\+\+\+ [^\n]*\n/m.test(text);
    const hunkHeader = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(text);
    if (!fileHeader || !hunkHeader) return undefined;
  }

  let remainingOld = 0;
  let remainingNew = 0;
  return (text.match(/[^\n]*\n|[^\n]+$/g) ?? []).map((line): TextDiffLine => {
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      remainingOld = Number(hunk[1] ?? 1);
      remainingNew = Number(hunk[2] ?? 1);
      return { text: line, kind: "context" };
    }
    const inHunk = remainingOld > 0 || remainingNew > 0;
    let kind: DiffLineKind = "context";
    if (inHunk || explicit) {
      // ---/+++ are file headers outside a hunk, but valid removed/added content inside one.
      if (line.startsWith("-") && (inHunk || !line.startsWith("--- "))) kind = "removed";
      if (line.startsWith("+") && (inHunk || !line.startsWith("+++ "))) kind = "added";
    }
    if (inHunk) {
      if (kind === "removed" || line.startsWith(" ")) remainingOld = Math.max(0, remainingOld - 1);
      if (kind === "added" || line.startsWith(" ")) remainingNew = Math.max(0, remainingNew - 1);
    }
    return { text: line, kind };
  });
}

function lines(text: string | undefined): string[] {
  if (!text) return [];
  const split = text.split("\n");
  while (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split;
}
