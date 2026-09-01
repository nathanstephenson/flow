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

function lines(text: string | undefined): string[] {
  if (!text) return [];
  const split = text.split("\n");
  while (split.length > 0 && split[split.length - 1] === "") split.pop();
  return split;
}
