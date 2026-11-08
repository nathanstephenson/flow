/**
 * A Background Call shares its id with the tool call that launched it, so the two are one call.
 * Its row is dropped wherever that tool row is shown, and the tool row carries its status instead.
 * A Background Call whose tool row is not shown (outside the loaded tail) keeps its own row.
 */
export function foldBackgroundCalls(keys: readonly string[]): readonly string[] {
  const tools = new Set(keys.filter((key) => key.startsWith("tool:")).map((key) => key.slice("tool:".length)));
  const folded = keys.filter((key) => !(key.startsWith("background_call:") && tools.has(key.slice("background_call:".length))));
  return folded.length === keys.length ? keys : folded;
}

export function backgroundKeyOf(toolKey: string): string {
  return toolKey.startsWith("tool:") ? `background_call:${toolKey.slice("tool:".length)}` : "";
}
