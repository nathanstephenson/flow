import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import type { Command } from "../protocol/commands.ts";
import type { LoggedEvent } from "../protocol/events.ts";
import type { EmbeddedAsset } from "../web/assets.ts";
import { ASSETS } from "../web/assets.generated.ts";
import { tokenMatches } from "./auth.ts";
import type { SessionHost } from "./host.ts";

/**
 * The Session Host's loopback HTTP surface (ADR 0004).
 *
 * Commands are POSTed and events arrive over SSE. SSE rather than WebSocket because the transcript
 * is one-directional and sequence-numbered — reconnect is `?since=N`, which is a replay rather than
 * a resynchronisation protocol — and because it needs no dependency in Node or the browser.
 */

export type ServeOptions = {
  host: SessionHost;
  token: string;
  port?: number;
  /** Default Scope offered to clients creating a session. */
  scope?: string;
  /** Loopback only. Overridable for tests, never for deployment (ADR 0004). */
  address?: string;
};

export type RunningServer = {
  server: Server;
  url: string;
  close(): Promise<void>;
};

export async function serve(options: ServeOptions): Promise<RunningServer> {
  const address = options.address ?? "127.0.0.1";
  const server = createServer((request, response) => {
    void handle(request, response, options).catch((error: unknown) => {
      send(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, address, resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    server,
    url: `http://${address}:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ServeOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  // A page on any origin can reach loopback; only same-origin requests may command us.
  if (!originAllowed(request)) {
    send(response, 403, { error: "Origin not allowed" });
    return;
  }

  // The one-time handoff that moves a token out of a URL and into an HttpOnly cookie (ADR 0004).
  if (url.pathname === "/auth") {
    const presented = url.searchParams.get("token") ?? undefined;
    if (!tokenMatches(options.token, presented)) {
      send(response, 401, { error: "Unauthorized" });
      return;
    }
    response.writeHead(302, {
      "set-cookie": `goodharness=${presented}; HttpOnly; SameSite=Strict; Path=/`,
      // Relative on purpose, and load-bearing when the handoff is taken through the Vite dev
      // server's proxy: an absolute Location would bounce the browser back to the Session Host's own
      // origin, stranding the cookie there while the app it has to authenticate sits on the other.
      location: "/",
    });
    response.end();
    return;
  }

  if (!tokenMatches(options.token, presentedToken(request))) {
    send(response, 401, { error: "Unauthorized" });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    send(response, 200, options.host.list());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/config") {
    send(response, 200, { scope: options.scope ?? process.cwd(), backends: options.host.backendNames() });
    return;
  }

  // Assets are served from the embedded manifest rather than disk, so a single-executable build has
  // nothing to find at runtime. The manifest is keyed by the path Vite emitted each file at, so `/`
  // has to be spelled out as the shell.
  const asset = ASSETS[url.pathname === "/" ? "/index.html" : url.pathname];
  if (request.method === "GET" && asset) {
    sendAsset(response, asset);
    return;
  }

  const eventsMatch = /^\/api\/sessions\/([^/]+)\/events$/.exec(url.pathname);
  const sessionId = eventsMatch?.[1];
  if (request.method === "GET" && sessionId) {
    streamEvents(response, options.host, sessionId, Number(url.searchParams.get("since") ?? 0));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/command") {
    const command = JSON.parse(await readBody(request)) as Command;
    send(response, 200, { result: (await options.host.execute(command)) ?? null });
    return;
  }

  // An Agent Session is deep-linkable, so an unknown path is the client router's business — except
  // under /api, where a 404 must stay JSON, and under /assets, where a missing hashed file is a bug
  // and must not be answered with HTML the browser will try to execute.
  const shell = ASSETS["/index.html"];
  if (
    request.method === "GET" &&
    shell &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/assets/")
  ) {
    sendAsset(response, shell);
    return;
  }

  send(response, 404, { error: "Not found" });
}

function sendAsset(response: ServerResponse, asset: EmbeddedAsset): void {
  const body = Buffer.from(asset.body, asset.encoding);
  response.writeHead(200, {
    "content-type": asset.type,
    "content-length": body.byteLength,
    // Caching an immutable asset forever is safe for a sharper reason than usual: its URL carries
    // the bundler's content hash, so different content is a different URL by construction and there
    // is no revalidation path to get wrong. The corollary is that no-store on the shell is doing
    // real work — a cached shell would pin its reader to an asset hash that no longer exists.
    "cache-control": asset.immutable ? "public, max-age=31536000, immutable" : "no-store",
  });
  response.end(body);
}

function streamEvents(response: ServerResponse, host: SessionHost, sessionId: string, since: number): void {
  let log;
  try {
    log = host.logFor(sessionId);
  } catch (error) {
    send(response, 404, { error: error instanceof Error ? error.message : String(error) });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  const write = (entry: LoggedEvent): void => {
    response.write(`id: ${entry.seq}\ndata: ${JSON.stringify(entry)}\n\n`);
  };

  for (const entry of log.since(since)) write(entry);
  const unsubscribe = log.subscribe(write);
  response.on("close", unsubscribe);
}

/**
 * Same-origin only. A request with no Origin header is a non-browser client (the TUI, curl), which
 * a hostile page cannot forge on the user's behalf, so it is not what this check defends against.
 */
function originAllowed(request: IncomingMessage): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function presentedToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim();

  const cookie = request.headers.cookie;
  const match = cookie ? /(?:^|;\s*)goodharness=([^;]+)/.exec(cookie) : null;
  return match?.[1];
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8") || "{}";
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}
