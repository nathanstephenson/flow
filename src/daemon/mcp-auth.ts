import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  auth,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { McpConnection } from "../protocol/mcp.ts";

type Credentials = {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
};
export class McpAuth {
  private readonly path: string;
  private values: Record<string, Credentials>;
  private readonly pending = new Map<string, {
    connectionId: string;
    consumed: boolean;
    provider: OAuthClientProvider;
    serverUrl: string;
    returnTo: string;
    timer: ReturnType<typeof setTimeout>;
  }>();
  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
  constructor(root: string) {
    mkdirSync(root, { recursive: true });
    this.path = join(root, "mcp-credentials.json");
    try {
      this.values = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      this.values = {};
    }
  }
  private key(connection: McpConnection): string {
    return createHash("sha256")
      .update(
        JSON.stringify([
          connection.id,
          connection.transport === "http" ? connection.url : "",
        ]),
      )
      .digest("hex");
  }
  provider(
    connection: McpConnection,
    redirectUrl = "http://127.0.0.1/",
    redirect?: (url: URL) => void,
    state?: string,
  ): OAuthClientProvider {
    const key = this.key(connection);
    let verifier = "";
    const save = (patch: Credentials) => {
      this.values[key] = { ...this.values[key], ...patch };
      const scratch = `${this.path}.tmp`;
      writeFileSync(scratch, JSON.stringify(this.values), { mode: 0o600 });
      renameSync(scratch, this.path);
    };
    return {
      redirectUrl,
      clientMetadata: {
        client_name: "Flow",
        redirect_uris: [redirectUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      state: () => state ?? randomBytes(32).toString("hex"),
      clientInformation: () => this.values[key]?.client,
      saveClientInformation: (client) => save({ client }),
      tokens: () => this.values[key]?.tokens,
      saveTokens: (tokens) => save({ tokens }),
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => verifier,
      redirectToAuthorization: (url) => {
        if (!redirect) throw new Error("MCP sign-in required");
        redirect(url);
      },
    };
  }
  async login(connection: McpConnection, returnUrl: string): Promise<string> {
    if (connection.transport !== "http" || !connection.oauth)
      throw new Error("OAuth is not enabled");
    const destination = new URL(returnUrl);
    if (
      !["http:", "https:"].includes(destination.protocol) ||
      destination.username ||
      destination.password
    )
      throw new Error("Invalid return URL");
    if (
      [...this.pending.values()].some((entry) => entry.connectionId === connection.id)
    )
      throw new Error("Sign-in already in progress");
    const state = randomBytes(32).toString("hex");
    const timer = setTimeout(() => this.pending.delete(state), 300_000);
    timer.unref();
    try {
      let authorizationUrl = "";
      const provider = this.provider(
        connection,
        new URL("/api/mcp/callback", destination.origin).href,
        (url) => {
          authorizationUrl = url.href;
        },
        state,
      );
      let client: OAuthClientInformationMixed | undefined;
      const saveClient = provider.saveClientInformation!;
      const saveTokens = provider.saveTokens;
      provider.saveClientInformation = (value) => {
        client = value;
      };
      provider.saveTokens = async (tokens) => {
        if (client) await saveClient(client);
        await saveTokens(tokens);
      };
      provider.clientInformation = () => client;
      provider.tokens = () => undefined;
      this.pending.set(state, {
        connectionId: connection.id,
        consumed: false,
        provider,
        serverUrl: connection.url,
        returnTo: destination.href,
        timer,
      });
      await auth(provider, { serverUrl: connection.url, fetchFn: timedFetch });
      if (!authorizationUrl) throw new Error("No authorization URL");
      return authorizationUrl;
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(state);
      throw error;
    }
  }
  async callback(url: URL): Promise<string> {
    const state = url.searchParams.get("state") ?? "";
    const entry = this.pending.get(state);
    if (!entry || entry.consumed) throw new Error("Invalid or expired callback");
    entry.consumed = true;
    clearTimeout(entry.timer);
    const destination = new URL(entry.returnTo);
    const code = url.searchParams.get("code");
    let result = "failed";
    if (code && !url.searchParams.has("error")) {
      try {
        const status = await auth(entry.provider, {
          serverUrl: entry.serverUrl,
          authorizationCode: code,
          fetchFn: timedFetch,
        });
        if (status === "AUTHORIZED") result = "signed-in";
      } catch {}
    }
    this.pending.delete(state);
    destination.searchParams.set("mcpAuth", result);
    return destination.href;
  }
}
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
