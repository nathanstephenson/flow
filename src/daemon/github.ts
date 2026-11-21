import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GIT_WRITE_TIMEOUT_MS } from "./git.ts";

const exec = promisify(execFile);
export type Gh = (scope: string, args: string[]) => Promise<string>;

export const gh: Gh = async (scope, args) => {
  try {
    return (await exec("gh", args, {
      cwd: scope,
      timeout: GIT_WRITE_TIMEOUT_MS,
      maxBuffer: 2 << 20,
      env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", ...(args[0] === "stack" ? { GIT_EDITOR: "true", GIT_SEQUENCE_EDITOR: "true" } : {}) },
    })).stdout;
  } catch (error) {
    const failure = error as { code?: string | number; stdout?: string; stderr?: string; message?: string };
    if (failure.code === "ENOENT") throw new Error("GitHub CLI is missing. Install gh on the Session Host.");
    const detail = (args[0] === "stack" ? [failure.stdout, failure.stderr].filter(Boolean).join("\n").trim() : failure.stderr?.trim()) || failure.message || "Unknown error";
    const requestFailed = /HTTP (?:429|5\d\d)|connection|timed? out|network|TLS|certificate|could not resolve/i.test(detail);
    if ((failure.code === 4 && args[0] !== "stack") || (args[0] === "auth" && !requestFailed)) {
      throw new Error(`GitHub authentication failed. Run gh auth login on the Session Host. ${detail}`);
    }
    throw new Error(`GitHub request failed: ${detail}`);
  }
};

export type Connection<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
export const page = "pageInfo { hasNextPage endCursor }";

export async function api<T>(scope: string, github: Gh, query: string, variables: Record<string, string | number | boolean | null>): Promise<T> {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [key, value] of Object.entries(variables)) {
    if (value !== null) args.push(typeof value === "string" ? "-f" : "-F", `${key}=${value}`);
  }
  const result = JSON.parse(await github(scope, args)) as { data?: T; errors?: { message: string }[] };
  if (result.errors?.length || !result.data) throw new Error(result.errors?.map(error => error.message).join("; ") || "GitHub returned no data.");
  return result.data;
}

export async function connection<T>(scope: string, github: Gh, first: Connection<T>, id: string, type: string, field: string, fields: string): Promise<T[]> {
  const result = [...first.nodes];
  const seen = new Set<string>();
  let current = first;
  for (let count = 0; count < 1000; count++) {
    if (!current.pageInfo.hasNextPage) return result;
    const cursor = current.pageInfo.endCursor;
    if (!cursor || seen.has(cursor)) throw new Error("GitHub returned an invalid page cursor.");
    seen.add(cursor);
    const data = await api<{ node: Record<string, Connection<T>> }>(scope, github,
      `query($id:ID!,$cursor:String){node(id:$id){... on ${type}{${field}(first:100,after:$cursor){nodes{${fields}} ${page}}}}}`, { id, cursor });
    current = data.node[field]!;
    result.push(...current.nodes);
  }
  throw new Error("GitHub pagination limit exceeded.");
}
