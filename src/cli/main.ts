import { parseArgs } from "node:util";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { registerBackends } from "../backend/registry.ts";
import { readOrCreateToken } from "../daemon/auth.ts";
import { ConfigStore } from "../daemon/config-store.ts";
import { SessionHost } from "../daemon/host.ts";
import { serve, type RunningServer } from "../daemon/server.ts";
import { ShellRegistry } from "../daemon/shell.ts";
import { defaultStateRoot, TranscriptStore } from "../daemon/store.ts";
import { connect, type Connection } from "../client/connection.ts";
import { answerLines } from "../client/enquiry.ts";
import { initialState, reduce, type ViewState } from "../client/reduce.ts";
import type { EffortLevel } from "../protocol/events.ts";
import { runTui } from "../tui/app.ts";

const USAGE = `usage:
  flow tui   [--scope DIR] [--backend claude|pi|fake]   interactive terminal client
  flow serve [--port N] [--address HOST]                run the Session Host in the foreground
  flow list                                             list Agent Sessions
  flow [--session ID] [--scope DIR] [--backend B] [--model M] [--effort L] "<prompt>"
                                                               one prompt, then exit

  tui without --scope uses the Project Root from config.json, else this directory.
  A one-shot prompt always uses this directory unless --scope names another.`;

type Daemon = { url: string; token: string };

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // No default, deliberately: `?? process.cwd()` at each read site would be indistinguishable
      // from the reader having typed it, and the Project Root has to sit between the two.
      scope: { type: "string" },
      backend: { type: "string", default: "claude" },
      model: { type: "string" },
      effort: { type: "string" },
      session: { type: "string" },
      port: { type: "string" },
      address: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === "serve") {
    const { running, daemon } = await startHost(
      values.port ? Number(values.port) : undefined,
      values.address,
    );
    writeDaemonFile(daemon);
    console.log(`Session Host listening on ${running.url}`);
    if (values.address && values.address !== LOOPBACK) {
      // ADR 0004 binds loopback because tools are pre-approved: reaching this host means running
      // commands as this user. Off-loopback, the bearer token is the only thing in the way.
      console.log(`  WARNING: bound to ${values.address}, not loopback. Anything that can route`);
      console.log("           here can run commands as you if it has the token.");
    }
    console.log(`  web handoff: ${daemon.url}/auth?token=${daemon.token}`);
    await new Promise<void>((resolve) => running.server.on("close", resolve));
    return 0;
  }

  if (command === "tui") {
    const { connection, stop } = await clientConnection();
    try {
      await runTui({
        connection,
        scope: values.scope ?? configuredScope() ?? process.cwd(),
        backend: values.backend ?? "claude",
      });
    } finally {
      await stop();
    }
    return 0;
  }

  if (command === "list") {
    const { connection, stop } = await clientConnection();
    try {
      for (const summary of await connection.listSessions()) {
        console.log(`${summary.id}  ${summary.status.padEnd(8)} ${summary.backend.padEnd(7)} ${summary.title}`);
      }
    } finally {
      await stop();
    }
    return 0;
  }

  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    console.log(USAGE);
    return 1;
  }
  return await oneShot(prompt, values);
}

/**
 * The Project Root, for a client that named no Scope.
 *
 * Read straight off disk rather than asked of the daemon, because the TUI may be talking to one it
 * did not start, and `/api/config`'s `scope` falls back to *that process's* working directory —
 * which is not this reader's. Only the configured root is a safe answer to borrow; the fallback to
 * `process.cwd()` has to happen here, where the cwd is the right one.
 *
 * A one-time read rather than a read-through, and that does not contradict ADR 0009: an Agent
 * Session's Scope is fixed for its whole life, so this value is consumed the moment it is asked for
 * and there is no later one for it to go stale against.
 */
function configuredScope(): string | undefined {
  return new ConfigStore().projectRoot();
}

/** Build a Session Host with every Backend Adapter registered and prior sessions loaded. */
const LOOPBACK = "127.0.0.1";

/** How often a running Session Host sweeps for Settled Agent Sessions past their window. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

async function startHost(
  port?: number,
  address?: string,
): Promise<{ running: RunningServer; daemon: Daemon; host: SessionHost }> {
  const root = defaultStateRoot();
  // One owner of config.json, read through by both the reaper and the HTTP surface, so a Setting
  // changed from a browser applies to this daemon rather than to the next one.
  const config = new ConfigStore(root);
  if (config.warning) console.error(`  WARNING: ${config.warning}`);

  // One store, shared: the Session Host writes Attachments through it and the HTTP surface reads
  // them back through the same one, so there is no second opinion about where they live.
  const store = new TranscriptStore();
  const host = new SessionHost({ store, retention: config.retention });
  registerBackends(host);
  // load() sweeps once, so a daemon that was off for a week catches up on the way in.
  await host.load();
  // unref: a one-shot prompt and the tests build a host in-process and must still be able to exit.
  // `void`-ed rather than awaited: the sweep now runs git to decide whether a worktree is safe to
  // remove, and nothing is waiting on the answer.
  setInterval(() => void host.reap(), SWEEP_INTERVAL_MS).unref();

  // Shells exit with the Agent Session they were opened beside. The host announces the closure and
  // stays ignorant of what listened — it owns Agent Sessions, not the things hanging off them.
  const shells = new ShellRegistry();
  host.onSessionClosed((sessionId) => shells.killFor(sessionId));

  const token = readOrCreateToken(root);
  const running = await serve({
    host,
    token,
    shells,
    config,
    store,
    scope: process.cwd(),
    ...(port === undefined ? {} : { port }),
    ...(address === undefined ? {} : { address }),
  });
  // Clients on this machine should dial loopback even when the socket is bound wider.
  const url = running.url.replace(`//${address ?? LOOPBACK}:`, `//${LOOPBACK}:`);
  return { running, daemon: { url, token }, host };
}

/**
 * Connect to a running Session Host, or run one in this process if there isn't one.
 *
 * Either way the client only ever speaks the wire protocol, so an embedded host is a deployment
 * detail rather than a second code path.
 */
async function clientConnection(): Promise<{ connection: Connection; stop: () => Promise<void> }> {
  const existing = readDaemonFile();
  if (existing && (await reachable(existing))) {
    return { connection: connect(existing), stop: async () => undefined };
  }

  const { running, daemon } = await startHost();
  return { connection: connect(daemon), stop: () => running.close() };
}

async function oneShot(
  prompt: string,
  values: { scope?: string; backend?: string; model?: string; effort?: string; session?: string },
): Promise<number> {
  const effort = effortLevel(values.effort);
  const { running, daemon, host } = await startHost();
  const connection = connect(daemon);
  try {
    const sessionId =
      values.session ??
      (await connection.command<string>({
        type: "create",
        scope: values.scope ?? process.cwd(),
        backend: values.backend ?? "claude",
        ...(values.model ? { modelId: values.model } : {}),
        ...(effort ? { effort } : {}),
      }));

    console.log(
      values.session ? `resuming ${sessionId}` : `session ${sessionId}\n  resume with: --session ${sessionId}`,
    );

    let state: ViewState = initialState();
    let rendered = 0;
    let done: (() => void) | undefined;
    const finished = new Promise<void>((resolve) => {
      done = resolve;
    });

    const unsubscribe = connection.subscribe({
      sessionId,
      since: 0,
      onEntry: (entry) => {
        state = reduce(state, entry);
        rendered = render(state, rendered);
        /*
         * Nobody is here to answer, so the Enquiry is aborted rather than waited on.
         *
         * This runner takes one prompt and exits; it has no input at all. An Enquiry holds the turn
         * until a human answers it, so without this the run simply never returns — and a hang is the
         * worst of the three things that could happen, because it looks like a slow model rather
         * than like a question. Aborting ends the turn, which prints the `aborted` row below and
         * gets the transcript written; the Agent Session is left Dormant like any other, so `--session`
         * can pick it up in the TUI or the web client, where it *can* be answered.
         */
        if (entry.event.type === "enquiry" && entry.event.state === "asked") {
          console.log("  ? the model asked a question, and this runner has no way to answer it");
          console.log(`  ? resume with: --session ${sessionId}  (or open it in the TUI)`);
          void connection.command({ type: "abort", sessionId });
        }
        if (entry.event.type === "turn_ended") done?.();
      },
    });

    await connection.command({ type: "send", sessionId, text: prompt, when: "now" });
    await finished;
    render(state, rendered, true);
    unsubscribe();
    // Leave the session Dormant rather than ending it: the point of a transcript is coming back.
    await host.shutdown();
    return 0;
  } finally {
    await running.close();
  }
}

/**
 * Print entries settled since the last render. The final entry is held back while the turn runs,
 * because assistant text arrives as snapshots that keep growing; `flush` releases it at turn end.
 */
function render(state: ViewState, alreadyRendered: number, flush = false): number {
  const settled = flush ? state.entries.length : state.entries.length - 1;
  for (let index = alreadyRendered; index < settled; index += 1) {
    const entry = state.entries[index];
    if (entry) console.log(format(entry));
  }
  return Math.max(alreadyRendered, settled);
}

function format(entry: NonNullable<ViewState["entries"][number]>): string {
  switch (entry.kind) {
    case "user":
      return `\n> ${entry.text}`;
    case "assistant":
      return `\n${entry.text}`;
    case "thinking":
      return `\n[thinking] ${entry.text}`;
    case "tool":
      return `  · ${entry.name} (${entry.status})`;
    case "subagent":
      return `  ⤷ ${entry.name} (${entry.waitingOn ? `waiting on ${entry.waitingOn}` : entry.status})`;
    case "enquiry": {
      // This runner takes no input, so an Enquiry it sees is one it aborts (see `oneShot`) — what
      // reaches here is therefore `aborted`, and what it prints is what was asked and went
      // unanswered. The TUI and the web client are where one can actually be answered.
      const asked = answerLines(entry.questions, entry.answers).join("; ");
      return `  ? [${entry.status}] ${asked}`;
    }
    case "notice":
      return `  ! ${entry.level}: ${entry.text}`;
    case "marker":
      // A break in the Agent Session's life, not a message about it, so it reads as a rule.
      return `\n── ${entry.text} ──`;
  }
}

function daemonFilePath(): string {
  return join(defaultStateRoot(), "daemon.json");
}

function writeDaemonFile(daemon: Daemon): void {
  // Carries the bearer token, so it is a credential too. mode: on writeFileSync only applies to a
  // file it creates; chmod covers the case where one is already there with looser permissions.
  const path = daemonFilePath();
  writeFileSync(path, `${JSON.stringify(daemon, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function readDaemonFile(): Daemon | undefined {
  try {
    return JSON.parse(readFileSync(daemonFilePath(), "utf8")) as Daemon;
  } catch {
    return undefined;
  }
}

/** A bad --effort is worth rejecting outright rather than starting a session that ignores it. */
function effortLevel(value: string | undefined): EffortLevel | undefined {
  if (value === undefined) return undefined;
  const levels: EffortLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const level = levels.find((candidate) => candidate === value);
  if (!level) throw new Error(`--effort must be one of: ${levels.join(", ")}`);
  return level;
}

async function reachable(daemon: Daemon): Promise<boolean> {
  try {
    const response = await fetch(`${daemon.url}/api/sessions`, {
      headers: { authorization: `Bearer ${daemon.token}` },
      signal: AbortSignal.timeout(500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
