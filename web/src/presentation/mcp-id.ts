const MAX = 20;

const trim = (value: string) => value.replace(/^-+|-+$/g, "");

/** A readable MCP Connection id from its name, unique among `taken` and never `workflow`. */
export function connectionId(name: string, taken: readonly string[]): string {
  const base = trim(trim(name.toLowerCase().replace(/[^a-z0-9]+/g, "-")).slice(0, MAX)) || "mcp";
  const used = new Set([...taken, "workflow"]);
  let id = base;
  for (let n = 2; used.has(id); n++) {
    const suffix = `-${n}`;
    id = trim(base.slice(0, MAX - suffix.length)) + suffix;
  }
  return id;
}
