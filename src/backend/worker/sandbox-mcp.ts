import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpConnection, McpStatus } from "../../protocol/mcp.ts";
import { McpSession, type McpTool } from "../mcp.ts";

type WorkerCall = (method: string, args: unknown[], signal?: AbortSignal) => Promise<unknown>;

/** Host stand-in for MCP clients that run in a sandbox worker (ADR 0033). The host keeps
 * definitions, OAuth and status; the worker owns the clients and their tool calls. */
export class SandboxMcpSession extends McpSession {
  private worker: WorkerCall | undefined;
  private readonly attached: Promise<void>;
  private resolveAttached!: () => void;
  private cached: McpStatus[];
  private readonly oauth: ((connection: McpConnection) => OAuthClientProvider) | undefined;
  private readonly secret: ((name: string) => string) | undefined;
  private readonly root: string;

  constructor(connections: readonly McpConnection[], scope: string,
    oauth?: (connection: McpConnection) => OAuthClientProvider, resolveSecret?: (name: string) => string) {
    super(connections, scope);
    this.oauth = oauth;
    this.root = scope;
    this.secret = resolveSecret;
    this.cached = connections.map((connection) => ({ id: connection.id, state: "connecting", tools: 0 }));
    this.attached = new Promise((resolve) => { this.resolveAttached = resolve; });
  }

  attach(worker: WorkerCall): void {
    this.worker = worker;
    this.resolveAttached();
  }

  /** Definitions for the worker: Secret-backed header values are resolved here and enter the VM. */
  definitions(): McpConnection[] {
    return this.connections.map((connection) => connection.transport !== "http" ? connection : {
      ...connection,
      headers: Object.fromEntries(Object.entries(connection.headers).map(([name, value]) =>
        [name, "secret" in value ? { value: this.secret!(value.secret) } : value])),
    });
  }

  async token(connectionId: string, refresh: boolean): Promise<string> {
    const connection = this.connections.find((entry) => entry.id === connectionId);
    if (connection?.transport !== "http" || !connection.oauth || !this.oauth) throw new Error("Unknown MCP connection");
    const provider = this.oauth(connection);
    if (refresh && await auth(provider, { serverUrl: connection.url }) !== "AUTHORIZED") throw new Error("MCP sign-in required");
    const token = (await provider.tokens())?.access_token;
    if (!token) throw new Error("MCP sign-in required");
    return token;
  }

  override async open(): Promise<void> {
    await this.attached;
    this.cached = await this.worker!("mcp.open", []) as McpStatus[];
  }

  override async retry(id: string): Promise<void> {
    await this.attached;
    this.cached = await this.worker!("mcp.retry", [id]) as McpStatus[];
  }

  async directView(connectionId: string): Promise<McpSession> {
    const connection = this.connections.find((entry) => entry.id === connectionId);
    if (!connection) throw new Error("MCP connection is not selected for this Agent Session");
    await this.attached;
    return new SandboxDirectMcpSession(connection, this.root, this.worker!);
  }

  override status(): McpStatus[] { return this.cached.map((state) => ({ ...state })); }
  override tools(): McpTool[] { return []; }
  override registrationFailed(): void { this.cached = this.cached.map((state) => ({ ...state, state: "failed", tools: 0 })); }
  override async dispose(): Promise<void> {}
}

/** A direct MCP Workflow Step's view of one connection in the sandbox worker (ADR 0033). */
class SandboxDirectMcpSession extends McpSession {
  private readonly worker: WorkerCall;
  private readonly connectionId: string;
  private state: McpStatus;
  private listed: McpTool[] = [];

  constructor(connection: McpConnection, scope: string, worker: WorkerCall) {
    super([connection], scope);
    this.worker = worker;
    this.connectionId = connection.id;
    this.state = { id: connection.id, state: "connecting", tools: 0 };
  }

  override async open(): Promise<void> {
    const result = await this.worker("mcp.direct", [this.connectionId]) as { status: McpStatus; tools: Omit<McpTool, "call">[] };
    this.state = result.status;
    this.listed = result.tools.map((tool) => ({ ...tool,
      call: (input, signal, timeoutMs) => this.worker("mcp.callTool", [tool.name, input, timeoutMs], signal) }) as McpTool);
  }

  override async retry(): Promise<void> { await this.open(); }
  override status(): McpStatus[] { return [{ ...this.state }]; }
  override tools(): McpTool[] { return this.listed; }
  override async dispose(): Promise<void> {}
}
