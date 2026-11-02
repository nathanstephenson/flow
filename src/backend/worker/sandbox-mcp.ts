import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { McpConnection, McpStatus } from "../../protocol/mcp.ts";
import { McpSession, type McpTool } from "../mcp.ts";

type WorkerCall = (method: string, args: unknown[]) => Promise<unknown>;

/** Host stand-in for MCP clients that run in a sandbox worker (ADR 0033). The host keeps
 * definitions, OAuth and status; the worker owns the clients and their tool calls. */
export class SandboxMcpSession extends McpSession {
  private worker: WorkerCall | undefined;
  private readonly attached: Promise<void>;
  private resolveAttached!: () => void;
  private cached: McpStatus[];
  private readonly oauth: ((connection: McpConnection) => OAuthClientProvider) | undefined;
  private readonly secret: ((name: string) => string) | undefined;

  constructor(connections: readonly McpConnection[], scope: string,
    oauth?: (connection: McpConnection) => OAuthClientProvider, resolveSecret?: (name: string) => string) {
    super(connections, scope);
    this.oauth = oauth;
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

  override status(): McpStatus[] { return this.cached.map((state) => ({ ...state })); }
  override tools(): McpTool[] { return []; }
  override registrationFailed(): void { this.cached = this.cached.map((state) => ({ ...state, state: "failed", tools: 0 })); }
  override async dispose(): Promise<void> {}
}
