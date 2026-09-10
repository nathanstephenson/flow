import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

import { mediaTypeOf } from "../protocol/attachments.ts";
import type { Command } from "../protocol/commands.ts";
import type { SettingsPatch } from "../protocol/settings.ts";
import { ConfigError } from "./config.ts";
import type { ConfigStore } from "./config-store.ts";
import type { LoggedEvent } from "../protocol/events.ts";
import type { Project } from "../protocol/projects.ts";
import { discoverProjects, includedProjects, searchDirectories } from "./projects.ts";
import type { ShellClientFrame, ShellServerFrame } from "../protocol/shells.ts";
import type { AssetManifest, EmbeddedAsset } from "../web/assets.ts";
import type { BranchList } from "../protocol/git.ts";
import { gitAvailable, head, isRepository, localBranches, MAX_BRANCHES } from "./git.ts";
import { tokenMatches } from "./auth.ts";
import { CommandRefused, type SessionHost } from "./host.ts";
import type { ShellRegistry } from "./shell.ts";
import type { TranscriptStore } from "./store.ts";

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
  /**
   * Where Attachment bytes are read from. Omitted means this deployment keeps no state, so it has
   * no Attachments to serve and the route 404s — the same shape of omission `shells` and `config`
   * already have, and it agrees with the Session Host, which refuses a send carrying one for the
   * same reason.
   */
  store?: TranscriptStore;
  /**
   * The web client to serve, injected rather than imported so that nothing under src/ depends on a
   * build output (ADR 0017). Required rather than optional, unlike the omissions above: forgetting
   * it would serve no client at all, and the SPA fallback would degrade to a 404 with every test
   * still green, so the compiler is made to ask. An empty manifest is the honest way to say this
   * deployment has no client, which is what a source run passes.
   */
  assets: AssetManifest;
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
      "set-cookie": `flow=${presented}; HttpOnly; SameSite=Strict; Path=/`,
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
      // The Project Root first: it is the directory this deployment is anchored to, and a client
      // with no working directory of its own has nothing better to say it is open on. Resolved here
      // rather than in main.ts on purpose — computing it at startup is the exact bug ADR 0009
      // exists to prevent, where editing the root in a browser only reaches the *next* daemon.
      scope: options.config?.projectRoot() ?? options.scope ?? process.cwd(),
      backends: options.host.backendNames(),
      // Whether this build can open a Shell at all. The web client hides the control when it cannot
      // rather than offering one that fails on click — the rule Capabilities already sets for
      // backends, applied to a host-wide facility.
      shell: (await options.shells?.available()) ?? false,
      // Whether this build can run git at all — exactly the question `shell` above asks, and the
      // same answer: hide the control rather than offer one that fails on click. git is a
      // documented prerequisite rather than a dependency, so a single-executable build or a bare
      // container has none, and without this a Scope's `.git` would promise a control that then
      // fails with ENOENT.
      git: await gitAvailable(),
      // The two Project lists, disjoint, both derived and both asked fresh on each request.
      //
      // `projectList` is what a client offers: the opted-in Projects, resolved from
      // `projects.include`. `projectCandidates` is what the Settings page offers to opt *into*:
      // repositories found beneath the Project Root that are not already in the list. Separating
      // them here rather than sending one annotated list means neither consumer has to filter, and
      // the dropdown cannot accidentally show a candidate.
      //
      // Beside the Settings rather than inside them: both are *derived* state, and folding them in
      // would break the invariant that `settingsOf()` is one function serving both the file and the
      // wire, so that GET cannot report something config.json does not hold (ADR 0009). Uncached
      // for a plainer reason — cloning a repository changes the answer without changing the file, so
      // a cache would need a filesystem watcher to make it more often wrong.
      ...projectLists(options.config),
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

  /*
   * `GET /api/directories?q=…` — directories to opt in as Projects.
   *
   * Its own endpoint rather than more of /api/config, because it answers a *query* rather than
   * reporting state: it changes with every keystroke and none of its answers are worth folding into
   * the document every other client polls.
   *
   * This enumerates the filesystem to whoever holds the token. That is not a new privilege — ADR
   * 0004 has it that anything able to reach this daemon can already run commands as this user — but
   * it is the first endpoint whose whole job is to read outside the state root, so it is worth being
   * deliberate: it returns directory *names* only, never file contents, and never follows a symlink.
   */
  if (request.method === "GET" && url.pathname === "/api/directories") {
    send(response, 200, searchDirectories(
      options.config?.rawProjectRoot(),
      url.searchParams.get("q") ?? "",
    ));
    return;
  }

  /*
   * `GET /api/branches?scope=…` — the branches a Scope could be switched to.
   *
   * Its own endpoint rather than more of `/api/config`, and a query rather than state, for the
   * reason `/api/directories` is (ADR 0011): the answer changes outside Flow — a `git
   * branch` in a terminal, a `git fetch` — so there is nothing worth folding into the document
   * every client polls, and a cache would need a filesystem watcher in order to be more often
   * wrong.
   *
   * Answers for a *Scope* rather than for an Agent Session, because the New Agent Session dialog
   * has to ask before there is a session to ask about: picking the branch to cut a worktree from
   * happens first. `head` is reported here as well as on `SessionSummary`, and the two cannot
   * disagree, because both are `head()` in `src/daemon/git.ts`.
   *
   * A Scope that is not a repository is a 200 carrying `repository: false`, not a 404: the
   * directory exists, and reporting the state distinguishes "not a repository" from a typo better
   * than a status code would.
   */
  if (request.method === "GET" && url.pathname === "/api/branches") {
    const scope = url.searchParams.get("scope");
    if (!scope) {
      send(response, 400, { error: "scope is required" });
      return;
    }
    send(response, 200, await branchList(scope));
    return;
  }

  /*
   * `GET /api/models` — what each Backend Adapter can reach, for the Providers section to offer.
   *
   * Its own endpoint rather than more of `/api/config`, and a query rather than state, for the
   * reason `/api/directories` and `/api/branches` are: a client polling the config document every
   * few seconds must not be made to spawn a process per backend to get it.
   *
   * A backend that cannot answer is a **200 carrying a `problem`**, never a 404 — the choice
   * `/api/branches` makes for a Scope that is not a repository, and for the same reason: naming the
   * state tells the reader more than a status code, and here it is what turns a picker into a text
   * field rather than into an empty list nobody can explain.
   *
   * Unlike its two neighbours, the answer is cached — see `SessionHost.models` for why, and
   * `?refresh=1` for the way out.
   */
  if (request.method === "GET" && url.pathname === "/api/models") {
    const scope = options.config?.projectRoot() ?? options.scope ?? process.cwd();
    send(response, 200, await options.host.models(scope, url.searchParams.get("refresh") === "1"));
    return;
  }

  /*
   * `GET /api/skills?scope=…&backend=…` — the Skills a Scope offers, before it has an Agent Session.
   *
   * The `list_skills` Command already answers this for a session that exists, and cannot answer it
   * for one that does not: it reads a live Backend Session. The New Agent Session view needs the
   * menu before there is anything to read, so this opens a throwaway session the way
   * `/api/models` does (ADR 0020) and disposes of it.
   *
   * **Both parameters are required.** `scope` because the view asks about a Scope it has picked,
   * which is why `/api/models`' shortcut of using the Project Root would be wrong here — this is the
   * `/api/branches` shape, not the `/api/models` one. `backend` because the two adapters genuinely
   * disagree about what a Skill is (pi folds its PromptTemplates in), so defaulting to the first
   * registered one would quietly answer with a different adapter's menu than the session is about to
   * be created on. The client already knows the names: `/api/config` hands it the same list it picks
   * the backend from.
   *
   * A backend that cannot answer is a **200 carrying a `problem`**, the choice both neighbours make.
   * It matters more here than for either of them: `CommandRefused` → 409 is wired only for
   * `POST /api/command`, so anything thrown in this handler would reach the reader as a bare 500.
   * `SessionHost.skillsFor` therefore never throws, including for a backend name it does not know.
   *
   * No `?refresh=1`, because nothing is cached to refresh — see `SessionHost.skillsFor`.
   */
  if (request.method === "GET" && url.pathname === "/api/skills") {
    const scope = url.searchParams.get("scope");
    const backend = url.searchParams.get("backend");
    if (!scope || !backend) {
      send(response, 400, { error: "scope and backend are required" });
      return;
    }
    send(response, 200, await options.host.skillsFor(scope, backend));
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
  // has to be spelled out as the Entry Document.
  const asset = options.assets[url.pathname === "/" ? "/index.html" : url.pathname];
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

  /**
   * `GET /api/sessions/:id/attachments/:attachmentId` — the bytes behind an id in a transcript.
   *
   * Under the Agent Session rather than in a store of its own, because that is where the bytes live
   * and an Attachment has no life apart from the transcript naming it. Behind the same bearer check
   * as everything else, which is what lets the web client render one with a plain `<img src>`: the
   * token is in an HttpOnly cookie (ADR 0004) and the client is same-origin, so the browser presents
   * it without the page having to.
   */
  const attachmentMatch = /^\/api\/sessions\/([^/]+)\/attachments\/([^/]+)$/.exec(url.pathname);
  if (request.method === "GET" && attachmentMatch) {
    sendAttachment(response, options.store, attachmentMatch[1] ?? "", attachmentMatch[2] ?? "");
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/command") {
    const command = JSON.parse(await readBody(request)) as Command;
    try {
      send(response, 200, { result: (await options.host.execute(command)) ?? null });
    } catch (error) {
      // A refusal is the caller asking for something this Agent Session cannot do in the state it
      // is in — a turn in flight, a checkout git itself declined — and its message is the whole of
      // what is worth showing. Anything else is ours, and `serve`'s catch turns it into a 500. The
      // same asymmetry as `ConfigError` → 400, at the status `/api/shells` already answers when an
      // Agent Session's state forbids the request.
      if (!(error instanceof CommandRefused)) throw error;
      send(response, 409, { error: error.message });
    }
    return;
  }

  // An Agent Session is deep-linkable, so an unknown path is the client router's business — except
  // under /api, where a 404 must stay JSON, and under /assets, where a missing hashed file is a bug
  // and must not be answered with HTML the browser will try to execute.
  const entryDocument = options.assets["/index.html"];
  if (
    request.method === "GET" &&
    entryDocument &&
    !url.pathname.startsWith("/api/") &&
    !url.pathname.startsWith("/assets/")
  ) {
    sendAsset(response, entryDocument);
    return;
  }

  send(response, 404, { error: "Not found" });
}

/**
 * The opted-in Projects, and the candidates not yet among them.
 *
 * Candidates are the discovered repositories minus whatever is already opted in, compared on the
 * resolved absolute path so that `work/api` and `/home/me/workspace/work/api` are recognised as the
 * same directory — which they are, and a candidate list that offered a Project you already have
 * would be a list that never emptied.
 */
/**
 * What `/api/branches` answers.
 *
 * The `isRepository` gate comes first so a Scope that is not a repository costs one `statSync` and
 * spawns nothing — which is most of the calls, since the New Agent Session dialog asks on every
 * settled keystroke of a free-text Scope field.
 *
 * A repository git cannot list is reported as a repository with no branches rather than as no
 * repository, because those are different things to a reader: the first is a state to explain, and
 * lying about the second would hide a broken checkout behind a missing control.
 */
async function branchList(scope: string): Promise<BranchList> {
  if (!isRepository(scope) || !(await gitAvailable())) {
    return { scope, repository: false, branches: [] };
  }

  const listed = await localBranches(scope);
  const found = await head(scope);
  const branches = listed.ok ? listed.value : [];

  return {
    scope,
    repository: true,
    branches: branches.slice(0, MAX_BRANCHES),
    ...(branches.length > MAX_BRANCHES ? { truncated: true as const } : {}),
    ...(found.ok ? { head: found.value } : {}),
  };
}

function projectLists(config: ConfigStore | undefined): {
  projectList: Project[];
  projectCandidates: Project[];
} {
  if (!config) return { projectList: [], projectCandidates: [] };

  const projectList = includedProjects(config.rawProjectRoot(), config.projectInclude());
  const included = new Set(projectList.map((project) => project.path));
  return {
    projectList,
    projectCandidates: discoverProjects(config.projectRoot()).filter(
      (candidate) => !included.has(candidate.path),
    ),
  };
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

/**
 * One Attachment's bytes.
 *
 * `mediaTypeOf` is the only check on the id, and that is deliberate: it accepts a uuid and one of
 * four extensions and nothing else, so it is simultaneously the content-type lookup and the reason
 * `../../token` cannot reach `readAttachment`. A second traversal guard would be a second rule able
 * to drift from this one.
 *
 * Cached forever, on the same reasoning as a hashed asset: the bytes at an id never change, because
 * an id is minted per write and a Presentation Transcript is never rewritten (ADR 0001).
 */
function sendAttachment(
  response: ServerResponse,
  store: TranscriptStore | undefined,
  sessionId: string,
  attachmentId: string,
): void {
  const mediaType = mediaTypeOf(attachmentId);
  const bytes = mediaType && store ? store.readAttachment(sessionId, attachmentId) : undefined;
  if (!mediaType || !bytes) {
    send(response, 404, { error: "Not found" });
    return;
  }
  response.writeHead(200, {
    "content-type": mediaType,
    "content-length": bytes.byteLength,
    "cache-control": "private, max-age=31536000, immutable",
  });
  response.end(bytes);
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
  const match = cookie ? /(?:^|;\s*)flow=([^;]+)/.exec(cookie) : null;
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
