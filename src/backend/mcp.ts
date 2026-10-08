import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { prepareFilesystemIsolation, type FilesystemIsolation } from "../isolation/filesystem.ts";
import { SupervisedStdioTransport } from "./mcp-stdio-supervisor.ts";
import { nodeExecutionAssets } from "../isolation/node-assets.ts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
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
/** Execution assets, not a general grant to the directories named in server arguments.
 * The policy canonicalises and rejects broad/protected mounts before launching anything.
 * Package roots keep relative imports and dependencies available when /tmp is masked.
 */
function executionAssets(connection: Extract<McpConnection, { transport: "stdio" }>, scope: string): string[] {
  const paths: string[] = [];
  const command = connection.command.includes("/") ? resolve(scope, connection.command)
    : (process.env.PATH ?? "/usr/bin:/bin").split(":").map((directory) => resolve(directory, connection.command)).find((path) => existsSync(path));
  for (const argument of [...(command ? [command] : []), ...connection.args]) {
    if (argument.startsWith("-")) continue;
    const path = resolve(scope, argument);
    if (!existsSync(path)) continue;
    const canonical = realpathSync(path);
    if (statSync(canonical).isDirectory()) { paths.push(canonical); continue; }
    let root = dirname(canonical);
    for (let ancestor = root; ancestor !== dirname(ancestor); ancestor = dirname(ancestor)) {
      if (existsSync(join(ancestor, "package.json"))) { root = ancestor; break; }
    }
    // Never widen a lone file in /tmp into a mount of all /tmp. Other unsafe roots
    // (home, protected state, and runtime sockets) are rejected by the policy.
    paths.push(root === "/tmp" ? canonical : root);
  }
  // A private ancestor mask can hide symlinked or hoisted Node dependencies even when the
  // package itself remains visible. Restore dependency trees explicitly, still policy-checked.
  return [...new Set([...paths, ...nodeExecutionAssets(paths)])];
}

export class McpSession {
  private readonly clients = new Map<string, Client>();
  private readonly stops = new Map<string, () => Promise<void>>();
  private readonly entries = new Map<string, McpTool[]>();
  private readonly states = new Map<string, McpStatus>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly activeCalls = new Map<string, number>();
  private readonly exits = new Set<Promise<void>>();
  private disposed = false;
  private readonly direct: boolean;
  readonly connections: readonly McpConnection[];
  private readonly scope: string;
  private readonly auth:
    | ((connection: McpConnection) => OAuthClientProvider)
    | undefined;
  private readonly resolveSecret: ((name: string) => string) | undefined;
  private readonly protectedPaths: string[] | undefined;
  private readonly stateRoot: string | undefined;
  private readonly isolationEnabled: boolean;
  private readonly expectedScopeIdentity: string | undefined;
  constructor(
    connections: readonly McpConnection[],
    scope: string,
    auth?: (connection: McpConnection) => OAuthClientProvider,
    direct = false,
    resolveSecret?: (name: string) => string,
    protectedPaths?: string[],
    stateRoot?: string,
    isolationEnabled = true,
    expectedScopeIdentity?: string,
  ) {
    this.connections = structuredClone(connections);
    this.scope = scope;
    this.auth = auth;
    this.direct = direct;
    this.resolveSecret = resolveSecret;
    this.protectedPaths = protectedPaths;
    this.stateRoot = stateRoot;
    this.isolationEnabled = isolationEnabled;
    this.expectedScopeIdentity = expectedScopeIdentity;
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
  private configuredHeaders(
    headers: Extract<McpConnection, { transport: "http" }>["headers"],
  ): Record<string, string> {
    return Object.fromEntries(
      Object.entries(headers).map(([name, source]) => {
        if ("value" in source) return [name, source.value];
        if (!this.resolveSecret)
          throw new Error(`No secret resolver for header ${name}`);
        return [name, this.resolveSecret(source.secret)];
      }),
    );
  }
  private async connect(connection: McpConnection): Promise<void> {
    const { id } = connection;
    this.states.set(id, { id, state: "connecting", tools: 0 });
    this.entries.delete(id);
    await this.stops.get(id)?.();
    this.clients.delete(id);
    this.stops.delete(id);
    if (this.disposed) return;
    const client = new Client(
      { name: "Flow", version: "1.0.0" },
      { capabilities: {} },
    );
    this.clients.set(id, client);
    let isolation: FilesystemIsolation | undefined;
    let scopeFd: number | undefined;
    const cleanup = () => {
      isolation?.cleanup();
      if (scopeFd !== undefined) { closeSync(scopeFd); scopeFd = undefined; }
    };
    let transport: SupervisedStdioTransport | StreamableHTTPClientTransport | undefined;
    let stopping: Promise<void> | undefined;
    const stop = () => stopping ??= (async () => {
      await client.close().catch(() => {});
      // Client may already have detached a transport after an error or spontaneous exit.
      await transport?.close();
      // A bounded stdio close may return before a kernel-stalled process exits. Its pinned
      // mount state is released only by the actual-exit hook registered below.
      if (!(transport instanceof SupervisedStdioTransport)) cleanup();
    })();
    this.stops.set(id, stop);
    try {
      // Direct workflow sessions never initiate login or replay a POST after a 401.
      const tokens = this.direct && connection.transport === 'http' && connection.oauth ? await this.auth?.(connection).tokens() : undefined;
      if (this.direct && connection.transport === 'http' && connection.oauth && !tokens?.access_token) {
        this.states.set(id, { id, state: 'failed', tools: 0 });
        return;
      }
      const configured = connection.transport === "http" ? this.configuredHeaders(connection.headers) : {};
      if (connection.transport === "stdio" && !this.isolationEnabled) {
        // Refuse unsupported authoring before touching a potentially stalled Scope path.
        if (this.expectedScopeIdentity !== undefined && process.platform !== "linux")
          throw new Error("Descriptor-bound MCP authoring requires Linux");
        const scope = realpathSync(this.scope);
        if (!statSync(scope).isDirectory()) throw new Error("Scope must be a directory");
        let cwd = scope;
        if (this.expectedScopeIdentity !== undefined) {
          if (scope !== resolve(this.scope)) throw new Error("Scope redirected since selection");
          scopeFd = openSync(scope, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          const pinned = fstatSync(scopeFd, { bigint: true });
          cwd = `/proc/${process.pid}/fd/${scopeFd}`;
          const bound = statSync(cwd, { bigint: true });
          if (`${pinned.dev}:${pinned.ino}` !== this.expectedScopeIdentity || !pinned.isDirectory()
            || bound.dev !== pinned.dev || bound.ino !== pinned.ino) {
            throw new Error("Scope changed since selection");
          }
        }
        transport = new SupervisedStdioTransport({
          command: connection.command,
          args: connection.args,
          env: getDefaultEnvironment(),
          cwd,
        });
      } else if (connection.transport === "stdio") {
        isolation = await prepareFilesystemIsolation({
          scope: this.scope, expectedScope: resolve(this.scope),
          ...(this.expectedScopeIdentity !== undefined ? { expectedScopeIdentity: this.expectedScopeIdentity } : {}),
          command: connection.command.includes("/") ? resolve(this.scope, connection.command) : connection.command,
          args: connection.args,
          readablePaths: executionAssets(connection, this.scope),
          // Match the SDK's pre-isolation minimal environment, not all host/provider secrets.
          env: { ...Object.fromEntries(Object.keys(process.env).map((key) => [key, undefined])), ...getDefaultEnvironment(),
            FLOW_BWRAP_PATH: process.env.FLOW_BWRAP_PATH, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
            CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
          ...(this.protectedPaths ? { protectedPaths: this.protectedPaths } : {}),
          ...(this.stateRoot ? { stateRoot: this.stateRoot } : {}),
          credentials: "none",
        });
        // Disposal can arrive while the mount/namespace probe is in flight. No spawn may
        // follow it, even when preparation succeeds after dispose() has closed the client.
        if (this.disposed) { isolation.cleanup(); return; }
        transport = new SupervisedStdioTransport({
          command: isolation.command,
          args: isolation.args,
          stdioFds: isolation.stdioFds,
          env: isolation.env,
          cwd: isolation.scope,
        });
      } else {
        // HTTP MCP deliberately retains its external/network authority.
        transport = new StreamableHTTPClientTransport(new URL(connection.url), {
          ...(connection.oauth && this.auth && !this.direct
            ? { authProvider: this.auth(connection) }
            : {}),
          // A Headers object rather than a spread, because header names are case-insensitive: a
          // configured `Authorization` must lose to the OAuth token, not travel beside it.
          fetch: (input, init) => {
            const headers = new Headers(configured);
            new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
            if (tokens) headers.set("Authorization", `Bearer ${tokens.access_token}`);
            return fetch(input, {
              ...init,
              headers,
              signal: this.direct ? init?.signal ?? null : init?.signal
                ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)])
                : AbortSignal.timeout(10_000),
            });
          },
        });
      }
      if (transport instanceof SupervisedStdioTransport) {
        const exited = transport.exited;
        void exited.then(cleanup);
        this.exits.add(exited);
        void exited.then(() => this.exits.delete(exited));
      }
      if (this.disposed) { await stop(); return; }
      const signal = AbortSignal.timeout(10_000);
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
        await stop();
        return;
      }
      this.entries.set(id, tools);
      this.states.set(id, { id, state: "connected", tools: tools.length });
      client.onclose = () => {
        this.entries.delete(id);
        if (!this.disposed)
          this.states.set(id, { id, state: "failed", tools: 0 });
      };
    } catch {
      await stop();
      this.entries.delete(id);
      this.states.set(id, { id, state: "failed", tools: 0 });
      if (connection.transport === "stdio" && this.expectedScopeIdentity !== undefined) {
        throw new Error(process.platform !== "linux"
          ? "Descriptor-bound MCP authoring requires Linux; launch refused."
          : "MCP authoring launch failed. Refresh the selected Scope and Retry.");
      }
    }
  }
  /** Ordinary callers retain bounded stdio close; authoring owns capacity until actual exit. */
  async dispose({ waitForExit = false }: { waitForExit?: boolean } = {}): Promise<void> {
    this.disposed = true;
    this.entries.clear();
    await Promise.all([...this.stops.values()].map((stop) => stop()));
    await Promise.allSettled(this.pending.values());
    // A connect may have been waiting for the previous connection's teardown.
    await Promise.all([...this.stops.values()].map((stop) => stop()));
    if (waitForExit) await Promise.all(this.exits);
  }
}
