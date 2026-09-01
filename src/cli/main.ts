import { parseArgs } from "node:util";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ClaudeBackend } from "../backend/claude/index.ts";
import { FakeBackend } from "../backend/fake/index.ts";
import { PiBackend } from "../backend/pi/index.ts";
import { readOrCreateToken } from "../daemon/auth.ts";
import { SessionHost } from "../daemon/host.ts";
import { serve, type RunningServer } from "../daemon/server.ts";
import { defaultStateRoot, TranscriptStore } from "../daemon/store.ts";
import { connect, type Connection } from "../client/connection.ts";
import { initialState, reduce, type ViewState } from "../client/reduce.ts";
import { runTui } from "../tui/app.ts";

const USAGE = `usage:
  goodharness tui   [--scope DIR] [--backend claude|pi|fake]   interactive terminal client
  goodharness serve [--port N]                                 run the Session Host in the foreground
  goodharness list                                             list Agent Sessions
  goodharness [--session ID] [--scope DIR] [--backend B] "<prompt>"   one prompt, then exit`;

type Daemon = { url: string; token: string };

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scope: { type: "string", default: process.cwd() },
      backend: { type: "string", default: "claude" },
      model: { type: "string" },
      session: { type: "string" },
      port: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  const command = positionals[0];
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === "serve") {
    const { running, daemon } = await startHost(values.port ? Number(values.port) : undefined);
    writeDaemonFile(daemon);
    console.log(`Session Host listening on ${daemon.url}`);
    console.log(`  web handoff: ${daemon.url}/auth?token=${daemon.token}`);
    await new Promise<void>((resolve) => running.server.on("close", resolve));
    return 0;
  }

  if (command === "tui") {
    const { connection, stop } = await clientConnection();
    try {
      await runTui({
        connection,
        scope: values.scope ?? process.cwd(),
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

/** Build a Session Host with every Backend Adapter registered and prior sessions loaded. */
async function startHost(port?: number): Promise<{ running: RunningServer; daemon: Daemon; host: SessionHost }> {
  const host = new SessionHost({ store: new TranscriptStore() });
  host.registerBackend(new ClaudeBackend());
  host.registerBackend(new PiBackend());
  host.registerBackend(new FakeBackend());
  await host.load();

  const token = readOrCreateToken(defaultStateRoot());
  const running = await serve({
    host,
    token,
    scope: process.cwd(),
    ...(port === undefined ? {} : { port }),
  });
  return { running, daemon: { url: running.url, token }, host };
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

async function oneShot(prompt: string, values: { scope?: string; backend?: string; model?: string; session?: string }): Promise<number> {
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
    case "notice":
      return `  ! ${entry.level}: ${entry.text}`;
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
