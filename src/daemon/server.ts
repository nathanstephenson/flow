import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import type { Command } from "../protocol/commands.ts";
import type { SettingsPatch } from "../protocol/settings.ts";
import { ConfigError } from "./config.ts";
import type { ConfigStore } from "./config-store.ts";
import type { LoggedEvent } from "../protocol/events.ts";
import type { ShellClientFrame, ShellServerFrame } from "../protocol/shells.ts";
import type { EmbeddedAsset } from "../web/assets.ts";
import { ASSETS } from "../web/assets.generated.ts";
import { tokenMatches } from "./auth.ts";
import type { SessionHost } from "./host.ts";
import type { ShellRegistry } from "./shell.ts";

/**
 * The Session Host's loopback HTTP surface (ADR 0004).
 *
 * Commands are POSTed and events arrive over SSE. SSE rather than WebSocket because the transcript
 * is one-directional and sequence-numbered — reconnect is `?since=N`, which is a replay rather than
 * a resynchronisation protocol — and because it needs no dependency in Node or the browser.
 *
 * A Shell is the one thing here that is not the transcript, and none of that reasoning covers it:
 * it is bidirectional, it carries raw bytes rather than sequenced events, and it has no `?since=N`.
 * So Shells alone speak WebSocket (ADR 0008). The gate is the same on both — same cookie, same
 * strict Origin check — because an upgrade request is an ordinary HTTP request until it is not.
 */

export type ServeOptions = {
  host: SessionHost;
  token: string;
  port?: number;
  /** Default Scope offered to clients creating a session. */
  scope?: string;
  /** Loopback only. Overridable for tests, never for deployment (ADR 0004). */
  address?: string;
  /** Omitted means this deployment serves no Shells, and clients are told so via /api/config. */
  shells?: ShellRegistry;
  /**
   * The Settings, read through rather than copied in — /api/config reports whatever it holds now,
   * and PUT /api/config writes through it. Omitted means this deployment has no Settings to serve,
   * so the clients fall back to the defaults in src/protocol/fonts.ts.
   */
  config?: ConfigStore;
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

  const shells = options.shells;
  if (shells) {
    server.on("upgrade", (request, socket, head) => {
      void handleUpgrade(request, socket, head, options.token, shells).catch(() => refuse(socket, 500));
    });
  }

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
    send(response, 200, {
      scope: options.scope ?? process.cwd(),
      backends: options.host.backendNames(),
      // Whether this build can open a Shell at all. The web client hides the control when it cannot
      // rather than offering one that fails on click — the rule Capabilities already sets for
      // backends, applied to a host-wide facility.
      shell: (await options.shells?.available()) ?? false,
      // Reported rather than decided by the client: the daemon owns config.json, and a font is the
      // one piece of presentation whose right answer depends on the machine (src/daemon/config.ts).
      // Spread rather than nested so `fonts` stays where it was on the wire.
      ...(options.config?.view() ?? {}),
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/config") {
    await handleSettingsUpdate(request, response, options.config);
    return;
  }

  if (options.shells && url.pathname === "/api/shells") {
    await handleShellCollection(request, response, url, options.host, options.shells);
    return;
  }

  const shellMatch = /^\/api\/shells\/([^/]+)$/.exec(url.pathname);
  const shellId = shellMatch?.[1];
  if (options.shells && request.method === "DELETE" && shellId) {
    if (!options.shells.get(shellId)) {
      send(response, 404, { error: `No Shell ${shellId}` });
      return;
    }
    options.shells.kill(shellId);
    send(response, 200, { ok: true });
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

/**
 * `PUT /api/config` — merge a patch into the Settings.
 *
 * Refuses rather than warns, which is the opposite of how the same values are read off disk. A file
 * is parsed leniently so a typo cannot stop the daemon starting; a person watching a form has to be
 * told their value was rejected, because a settings page that reports success and keeps the old
 * value is worse than one that has no save button at all.
 *
 * Retention is not swept here. The next hourly sweep applies it, which is what the UI says, so
 * saving a shorter window is never itself the thing that deletes a Presentation Transcript.
 */
async function handleSettingsUpdate(
  request: IncomingMessage,
  response: ServerResponse,
  config: ConfigStore | undefined,
): Promise<void> {
  if (!config) {
    send(response, 404, { error: "This Session Host serves no Settings" });
    return;
  }

  let patch: SettingsPatch;
  try {
    patch = JSON.parse(await readBody(request)) as SettingsPatch;
  } catch {
    send(response, 400, { error: "expected a JSON object" });
    return;
  }

  try {
    send(response, 200, config.update(patch));
  } catch (error) {
    // A rejected value is the client's fault and its message names the field, so it is safe and
    // useful to pass back. Anything else is ours, and `handle`'s caller turns it into a 500.
    if (!(error instanceof ConfigError)) throw error;
    send(response, 400, { error: error.message });
  }
}

/**
 * `/api/shells` — list the Shells beside one Agent Session, or open another.
 *
 * Addressed as a collection rather than as `/api/sessions/:id/shell`, because an Agent Session may
 * own several Shells and a singular path would have to be broken to admit the second one.
 */
async function handleShellCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  host: SessionHost,
  shells: ShellRegistry,
): Promise<void> {
  if (request.method === "GET") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) {
      send(response, 400, { error: "sessionId is required" });
      return;
    }
    send(response, 200, shells.listFor(sessionId));
    return;
  }

  if (request.method !== "POST") {
    send(response, 405, { error: "Method not allowed" });
    return;
  }

  const body = JSON.parse(await readBody(request)) as {
    sessionId?: string;
    cols?: number;
    rows?: number;
  };
  if (!body.sessionId) {
    send(response, 400, { error: "sessionId is required" });
    return;
  }

  // The Scope is read from the Agent Session rather than taken from the request: a client that
  // could name its own working directory would make the Agent Session's Scope decorative.
  const summary = host.list().find((candidate) => candidate.id === body.sessionId);
  if (!summary) {
    send(response, 404, { error: `No Agent Session ${body.sessionId}` });
    return;
  }
  if (summary.status === "settled" || summary.status === "ended") {
    // Refused rather than opened-and-immediately-killed: the same rule that exits a Shell on Settle
    // has to also stop one being opened afterwards, or the two disagree.
    send(response, 409, { error: `Agent Session ${summary.id} is ${summary.status}` });
    return;
  }

  try {
    send(response, 200, await shells.create({
      sessionId: summary.id,
      cwd: summary.scope,
      ...(body.cols === undefined ? {} : { cols: body.cols }),
      ...(body.rows === undefined ? {} : { rows: body.rows }),
    }));
  } catch (error) {
    send(response, 503, { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * The Shell socket: `GET /api/shells/:id/stream`, upgraded.
 *
 * Binary frames are bytes in both directions — keystrokes up, output down — and text frames carry
 * the out-of-band messages. Splitting them by frame type rather than by envelope means the hot path
 * does no parsing and no base64.
 */
async function handleUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  token: string,
  shells: ShellRegistry,
): Promise<void> {
  if (!originAllowed(request)) return refuse(socket, 403);
  if (!tokenMatches(token, presentedToken(request))) return refuse(socket, 401);

  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  const shellId = /^\/api\/shells\/([^/]+)\/stream$/.exec(url.pathname)?.[1];
  if (!shellId) return refuse(socket, 404);
  const summary = shells.get(shellId);
  if (!summary) return refuse(socket, 404);

  // Imported here rather than at module scope so that `ws` is only loaded by a host that was given
  // a ShellRegistry, and so the module graph of a Shell-less deployment stays as it was.
  const { WebSocketServer } = await import("ws");
  const wss = new WebSocketServer({ noServer: true });
  wss.handleUpgrade(request, socket, head, (ws) => {
    const tell = (frame: ShellServerFrame): void => ws.send(JSON.stringify(frame));
    tell({ type: "ready", shell: summary });

    const detach = shells.attach(shellId, {
      output: (chunk) => ws.send(chunk, { binary: true }),
      exit: (code, signal) => {
        tell({ type: "exit", code, signal });
        ws.close();
      },
    });

    ws.on("message", (data: Buffer, isBinary: boolean) => {
      if (isBinary) {
        shells.write(shellId, data);
        return;
      }
      // A malformed control frame is dropped rather than allowed to tear down a live Shell.
      let frame: ShellClientFrame;
      try {
        frame = JSON.parse(data.toString("utf8")) as ShellClientFrame;
      } catch {
        return;
      }
      if (frame.type === "resize") shells.resize(shellId, frame.cols, frame.rows);
    });

    // Detach only. Closing the pane, closing the tab and losing the network all arrive here
    // identically, and none of them is a reason to kill a Shell someone left `npm run dev` in.
    ws.on("close", detach);
    ws.on("error", detach);
  });
}

/** An upgrade cannot be answered with a JSON body, so a refusal is a bare status line. */
function refuse(socket: Duplex, status: number): void {
  const text =
    { 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 500: "Internal Server Error" }[status] ??
    "Error";
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
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
  // writeHead only buffers; Node sends the headers with the first body write. A client resuming at
  // `since: lastSeq` has nothing to replay, so without this its fetch() would not resolve until the
  // Agent Session next said something — which for an idle one is never.
  response.flushHeaders();

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
