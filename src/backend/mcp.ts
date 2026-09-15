import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnection, McpStatus } from "../protocol/mcp.ts";

export type McpTool = {
  name: string;
  connectionId: string;
  definition: Tool;
  serverIdentity: string;
  call: (
    input: Record<string, unknown>,
    signal?: AbortSignal,
    timeoutMs?: number,
  ) => Promise<CallToolResult>;
};
export class McpSession {
  private readonly clients = new Map<string, Client>();
  private readonly entries = new Map<string, McpTool[]>();
  private readonly states = new Map<string, McpStatus>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly activeCalls = new Map<string, number>();
  private disposed = false;
  private readonly direct: boolean;
  readonly connections: readonly McpConnection[];
  private readonly scope: string;
  private readonly auth:
    | ((connection: McpConnection) => OAuthClientProvider)
    | undefined;
  constructor(
    connections: readonly McpConnection[],
    scope: string,
    auth?: (connection: McpConnection) => OAuthClientProvider,
    direct = false,
  ) {
    this.connections = structuredClone(connections);
    this.scope = scope;
    this.auth = auth;
    this.direct = direct;
  }
  registrationFailed(): void {
    for (const [id] of this.states) this.states.set(id, { id, state: "failed", tools: 0 });
  }
  tools(): McpTool[] {
    return [...this.entries.values()].flat();
  }
  status(): McpStatus[] {
    return [...this.states.values()].map((state) => ({ ...state }));
  }
  async open(): Promise<void> {
    await Promise.all(
      this.connections.map((connection) => this.retry(connection.id)),
    );
  }
  retry(id: string): Promise<void> {
    if (this.disposed)
      return Promise.reject(new Error("Backend Session stopped"));
    if (this.activeCalls.get(id))
      return Promise.reject(new Error("MCP tools are still running"));
    const pending = this.pending.get(id);
    if (pending) return pending;
    const connection = this.connections.find((entry) => entry.id === id);
    if (!connection) return Promise.reject(new Error("Unknown MCP connection"));
    const promise = this.connect(connection).finally(() =>
      this.pending.delete(id),
    );
    this.pending.set(id, promise);
    return promise;
  }
  private async connect(connection: McpConnection): Promise<void> {
    const { id } = connection;
    this.states.set(id, { id, state: "connecting", tools: 0 });
    this.entries.delete(id);
    await this.clients
      .get(id)
      ?.close()
      .catch(() => {});
    if (this.disposed) return;
    const client = new Client(
      { name: "Flow", version: "1.0.0" },
      { capabilities: {} },
    );
    this.clients.set(id, client);
    // Direct workflow sessions never initiate login or replay a POST after a 401.
    const tokens = this.direct && connection.transport === 'http' && connection.oauth ? await this.auth?.(connection).tokens() : undefined;
    if (this.direct && connection.transport === 'http' && connection.oauth && !tokens?.access_token) {
      this.states.set(id, { id, state: 'failed', tools: 0 });
      return;
    }
    const transport =
      connection.transport === "stdio"
        ? new StdioClientTransport({
            command: connection.command,
            args: connection.args,
            cwd: this.scope,
            stderr: "ignore",
          })
        : new StreamableHTTPClientTransport(new URL(connection.url), {
            ...(connection.oauth && this.auth && !this.direct
              ? { authProvider: this.auth(connection) }
              : {}),
            fetch: (input, init) =>
              fetch(input, {
                ...init,
                ...(tokens ? { headers: { ...Object.fromEntries(new Headers(init?.headers).entries()), Authorization: `Bearer ${tokens.access_token}` } } : {}),
                signal: this.direct ? init?.signal ?? null : init?.signal
                  ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
                  : AbortSignal.timeout(10_000),
              }),
          });
    const signal = AbortSignal.timeout(10_000);
    try {
      await client.connect(
        transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
        { timeout: 10_000, signal },
      );
      const serverIdentity = createHash("sha256").update(JSON.stringify(client.getServerVersion() ?? null)).digest("hex");
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const result = await client.listTools(cursor ? { cursor } : {}, {
          timeout: 10_000,
          signal,
        });
        for (const definition of result.tools) {
          const original = definition.name;
          const local =
            /^[A-Za-z0-9_-]+$/.test(original) &&
            original.length <= 57 - id.length &&
            !/^h[0-9a-f]{16}$/.test(original)
              ? original
              : `h${createHash("sha256").update(original).digest("hex").slice(0, 16)}`;
          const name = `mcp__${id}__${local}`;
          tools.push({
            name,
            connectionId: id,
            definition,
            serverIdentity,
            call: async (input, signal, timeoutMs = 60_000) => {
              if (this.disposed) throw new Error("Backend Session stopped");
              this.activeCalls.set(id, (this.activeCalls.get(id) ?? 0) + 1);
              try {
                return (await this.clients
                  .get(id)!
                  .callTool(
                    { name: definition.name, arguments: input },
                    undefined,
                    { timeout: timeoutMs, ...(signal ? { signal } : {}) },
                  )) as CallToolResult;
              } catch {
                if (!signal?.aborted)
                  this.states.set(id, { id, state: "failed", tools: 0 });
                throw new Error(
                  "MCP tool call failed. Check the connection and Retry.",
                );
              } finally {
                this.activeCalls.set(id, this.activeCalls.get(id)! - 1);
              }
            },
          });
        }
        cursor = result.nextCursor;
        if (seen.size >= 100) throw new Error("MCP tool list is too large");
        if (cursor && seen.has(cursor)) throw new Error("Repeated MCP cursor");
        if (cursor) seen.add(cursor);
      } while (cursor);
      if (this.disposed) {
        await client.close();
        return;
      }
      this.entries.set(id, tools);
      this.states.set(id, { id, state: "connected", tools: tools.length });
      client.onclose = () => {
        if (!this.disposed)
          this.states.set(id, { id, state: "failed", tools: 0 });
      };
    } catch {
      await client.close().catch(() => {});
      this.states.set(id, { id, state: "failed", tools: 0 });
    }
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await Promise.all(
      [...this.clients.values()].map((client) =>
        client.close().catch(() => {}),
      ),
    );
    await Promise.allSettled(this.pending.values());
  }
}
