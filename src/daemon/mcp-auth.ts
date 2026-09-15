import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:http";
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
  private readonly pending = new Map<string, () => void>();
  dispose(): void {
    for (const close of this.pending.values()) close();
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
  async login(connection: McpConnection): Promise<string> {
    if (connection.transport !== "http" || !connection.oauth)
      throw new Error("OAuth is not enabled");
    if (this.pending.has(connection.id))
      throw new Error("Sign-in already in progress");
    const state = randomBytes(32).toString("hex");
    const server = createServer();
    const close = () => {
      clearTimeout(timer);
      server.close();
      this.pending.delete(connection.id);
    };
    const timer = setTimeout(close, 300_000);
    timer.unref();
    this.pending.set(connection.id, () => { server.closeAllConnections(); close(); });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("No OAuth callback address");
      let authorizationUrl = "";
      const provider = this.provider(
        connection,
        `http://127.0.0.1:${address.port}/callback`,
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
      let consumed = false;
      server.on("request", (request, response) => {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (
          consumed ||
          url.pathname !== "/callback" ||
          url.searchParams.get("state") !== state
        ) {
          response.writeHead(400).end("Invalid callback");
          return;
        }
        consumed = true;
        const code = url.searchParams.get("code");
        if (!code) {
          response.writeHead(400).end("Sign-in refused");
          close();
          return;
        }
        void auth(provider, {
          serverUrl: connection.url,
          authorizationCode: code,
          fetchFn: timedFetch,
        })
          .then(
            () => {
              response.end("Signed in. Return to Flow and select Retry.");
            },
            () => {
              response
                .writeHead(400)
                .end("Sign-in failed. Return to Flow and try again.");
            },
          )
          .finally(close);
      });
      await auth(provider, { serverUrl: connection.url, fetchFn: timedFetch });
      if (!authorizationUrl) throw new Error("No authorization URL");
      return authorizationUrl;
    } catch (error) {
      close();
      throw error;
    }
  }
}
export const timedFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    signal: init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
  });
