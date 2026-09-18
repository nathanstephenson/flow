#!/usr/bin/env node
import { parseArgs } from "node:util";
import { readFileSync, statSync, mkdirSync, realpathSync, openSync, closeSync, fchmodSync } from "node:fs";
import { spawn } from 'node:child_process';
import { acquireHost, readHost, oidcFingerprint, type HostIdentity } from '../daemon/ownership.ts';
import { join, resolve } from "node:path";

import { registerBackends } from "../backend/registry.ts";
import { createOidcGateFromEnv, readOrCreateToken } from "../daemon/auth.ts";
import { ConfigStore } from "../daemon/config-store.ts";
import { SecretStore } from '../daemon/secret-store.ts';
import { WorkflowStore } from '../workflows/store.ts';
import { WorkflowExecutionService } from '../daemon/workflow-executions.ts';
import { embeddedWorkflowRuntime } from '../workflows/runtime-asset.ts';
import { fileURLToPath } from 'node:url';
import { getAsset, isSea } from 'node:sea';
import { SessionHost } from "../daemon/host.ts";
import { serve, type RunningServer } from "../daemon/server.ts";
import { ShellRegistry } from "../daemon/shell.ts";
import { EMBEDDED } from "../web/embedded.ts";
import { manifestOf, NoWebBuild } from "../web/manifest.ts";
import { defaultStateRoot, TranscriptStore } from "../daemon/store.ts";
import { connect, type Connection } from "../client/connection.ts";
import { answerLines } from "../client/enquiry.ts";
import { authorisationLabel } from "../client/permission.ts";
import { initialState, reduce, type ViewState } from "../client/reduce.ts";
import type { EffortLevel } from "../protocol/events.ts";
import type { AssetManifest } from "../web/assets.ts";
import { runTui } from "../tui/app.ts";

const USAGE = `usage:
  flow --version                                        print the installed version
  flow tui   [--scope DIR] [--backend claude|pi|fake]   interactive terminal client
  flow serve [--port N] [--address HOST]                run the Session Host in the foreground
  flow serve start|status|stop|restart [--force]          control a background Session Host
  flow list                                             list Agent Sessions
  flow [--session ID] [--scope DIR] [--backend B] [--model M] [--effort L] "<prompt>"
                                                               one prompt, then exit

  tui without --scope uses the Project Root from config.json, else this directory.
  A one-shot prompt always uses this directory unless --scope names another.`;

type Daemon = { url: string; token: string };

function installedVersion(): string {
  return JSON.parse(isSea() ? getAsset('package.json', 'utf8') : readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
}

/**
 * The web client to serve. The binary carries its own, injected in place of src/web/embedded.ts at
 * bundle time; a source run has an empty one and reads the Vite build off disk instead.
 *
 * Missing is fatal rather than a silent API-only host: `npm start` builds first (prestart), so an
 * absent web/dist means something skipped that, and a Session Host answering 404 for every page is a
 * far worse thing to debug than a refusal that names the command to run.
 */
function webClient(): AssetManifest {
  if (Object.keys(EMBEDDED).length > 0) return EMBEDDED;
  try {
    return manifestOf(join(import.meta.dirname, "../../web/dist"));
  } catch (error) {
    if (!(error instanceof NoWebBuild)) throw error;
    throw new Error(`${error.message}; run \`npm run build:web\``);
  }
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      // No default, deliberately: `?? process.cwd()` at each read site would be indistinguishable
      // from the reader having typed it, and the Project Root has to sit between the two.
      scope: { type: "string" },
      backend: { type: "string" },
      model: { type: "string" },
      effort: { type: "string" },
      session: { type: "string" },
      port: { type: "string" },
      address: { type: "string" },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      force: { type: 'boolean', default: false },
      'background-host': { type: 'boolean', default: false },
    },
  });

  if (values.version) {
    console.log(installedVersion());
    return 0;
  }

  const command = positionals[0];
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === "serve") {
    if (positionals.length > 2) throw new Error(`Unexpected serve arguments: ${positionals.slice(2).join(' ')}`);
    if (positionals[1]) return await controlHost(positionals[1], values);
    const { running, daemon } = await startHost(
      values.port ? Number(values.port) : undefined,
      values.address,
      values['background-host'] ? 'background' : 'foreground',
    );
    console.log(`Session Host listening on ${running.url}`);
    if (values.address && values.address !== LOOPBACK) {
      // ADR 0004 binds loopback because tools are pre-approved: reaching this host means running
      // commands as this user. Off-loopback, the bearer token is the only thing in the way.
      console.log(`  WARNING: bound to ${values.address}, not loopback. Anything that can route`);
      console.log("           here can run commands as you if it has the token.");
    }
    if (running.oidc) {
      console.log(`  browser sign-in: ${running.oidc.config.publicAppUrl}/oauth/login`);
      console.log(`  OIDC callback:   ${running.oidc.callbackUrl()}`);
      console.log(`  back-channel:    ${running.oidc.backchannelLogoutUrl()}`);
    } else {
      console.log(`  web handoff: ${daemon.url}/auth?token=${daemon.token}`);
    }
    await new Promise<void>((resolve) => running.server.on("close", resolve));
    return 0;
  }

  if (command === "tui") {
    const { connection, stop } = await clientConnection();
    try {
      await runTui({
        connection,
        scope: values.scope ?? configuredScope() ?? process.cwd(),
        ...(values.backend === undefined ? {} : { backend: values.backend }),
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
  mode: HostIdentity['mode'] = 'embedded',
): Promise<{ running: RunningServer; daemon: Daemon; stop: () => Promise<void> }> {
  const ownership = acquireHost(defaultStateRoot());
  const root = ownership.root;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    const previous = readHost(root);
    if (previous && await reachable(previous)) throw new Error('A Session Host is already reachable for this state root');
    // One owner of config.json, read through by both the reaper and the HTTP surface, so a Setting
    // changed from a browser applies to this daemon rather than to the next one.
    const config = new ConfigStore(root);
    const { McpAuth } = await import("../daemon/mcp-auth.ts");
    const mcpAuth = new McpAuth(root);
    if (config.warning) console.error(`  WARNING: ${config.warning}`);

    // One store, shared: the Session Host writes Attachments through it and the HTTP surface reads
    // them back through the same one, so there is no second opinion about where they live.
    const store = new TranscriptStore(root);
    const secrets = new SecretStore(root);
    const host = new SessionHost({
      store,
      resolveSecret: (name) => secrets.resolve(name),
      retention: config.retention,
      mcpConnections: config.mcpConnections,
      mcpAuth,
      standingAuthorisations: config.standingAuthorisations,
      allowTool: config.allowTool,
      defaultBackend: config.defaultBackend,
      defaultModel: config.defaultModel,
      defaultEffort: config.defaultEffort,
      autoCompaction: config.autoCompaction,
      summaryModel: config.summaryModel,
    });
    cleanup = async () => { await host.shutdown(); mcpAuth.dispose(); };
    registerBackends(host);
    const workflows = new WorkflowStore(root);
    const workflowExecutions = new WorkflowExecutionService(host, workflows, secrets, config,
      isSea() ? embeddedWorkflowRuntime() : fileURLToPath(new URL('../../build/workflow-runtime.cjs', import.meta.url)));
    // load() sweeps once, so a daemon that was off for a week catches up on the way in.
    await host.load();
    workflowExecutions.reconcile();
    // unref: a one-shot prompt and the tests build a host in-process and must still be able to exit.
    // `void`-ed rather than awaited: the sweep now runs git to decide whether a worktree is safe to
    // remove, and nothing is waiting on the answer.
    let reaping = Promise.resolve();
    const sweep = setInterval(() => { reaping = reaping.then(async () => { await host.reap(); }); }, SWEEP_INTERVAL_MS);
    sweep.unref();

    // Shells exit with the Agent Session they were opened beside. The host announces the closure and
    // stays ignorant of what listened — it owns Agent Sessions, not the things hanging off them.
    const shells = new ShellRegistry();
    host.onSessionClosed((sessionId) => shells.killFor(sessionId));
    cleanup = async () => { clearInterval(sweep); await host.shutdown(); await shells.killAll(); mcpAuth.dispose(); };

    const token = readOrCreateToken(root);
    // Discovery happens before listen(): partial configuration, an issuer mismatch, or an unreachable
    // provider fails closed without briefly exposing a host under local-mode browser semantics.
    const oidc = await createOidcGateFromEnv(root);
    let running: RunningServer | undefined;
    let stopping: Promise<void> | undefined;
    const signal = () => { void stop().then(() => process.exit(0), error => { console.error(error); }); };
    const stop = (): Promise<void> => stopping ??= (async () => {
      clearInterval(sweep);
      await running?.stopAdmission(async () => { await Promise.all([host.shutdown(), shells.killAll(), reaping]); });
      if (running) await running.stopAdmission(() => host.shutdown());
      else await host.shutdown();
      await shells.killAll();
      if (running) await running.close();
      else { mcpAuth.dispose(); oidc?.dispose(); }
      ownership.release();
      process.off('SIGINT', signal);
      process.off('SIGTERM', signal);
      process.off('SIGHUP', signal);
    })();
    cleanup = stop;
    const identity: HostIdentity = {
      instanceId: ownership.instanceId, pid: process.pid, version: installedVersion(), url: '', token, mode,
      settings: { port: port ?? 0, address: address ?? LOOPBACK, cwd: process.cwd(), oidc: oidcFingerprint() },
    };
    running = await serve({
      control: { identity, stop },
      host,
      token,
      shells,
      config,
      mcpAuth,
      store,
      workflows,
      secrets,
      workflowExecutions,
      assets: webClient(),
      scope: process.cwd(),
      ...(oidc === undefined ? {} : { oidc }),
      ...(port === undefined ? {} : { port }),
      ...(address === undefined ? {} : { address }),
    });
    // Clients on this machine should dial loopback even when the socket is bound wider.
    const url = running.url.replace(`//${address ?? LOOPBACK}:`, `//${LOOPBACK}:`);
    identity.url = url;
    ownership.publish(identity);
    process.on('SIGINT', signal);
    process.on('SIGTERM', signal);
    process.on('SIGHUP', signal);
    return { running, daemon: { url, token }, stop };
  } catch (error) {
    await cleanup?.();
    ownership.release();
    throw error;
  }
}

/**
 * Connect to a running Session Host, or run one in this process if there isn't one.
 *
 * Either way the client only ever speaks the wire protocol, so an embedded host is a deployment
 * detail rather than a second code path.
 */
async function clientConnection(): Promise<{ connection: Connection; stop: () => Promise<void> }> {
  const existing = readHost(defaultStateRoot());
  if (existing && (await reachable(existing))) {
    return { connection: connect(existing), stop: async () => undefined };
  }

  const { daemon, stop } = await startHost();
  return { connection: connect(daemon), stop };
}

async function oneShot(
  prompt: string,
  values: { scope?: string; backend?: string; model?: string; effort?: string; session?: string },
): Promise<number> {
  const effort = effortLevel(values.effort);
  const { daemon, stop } = await startHost();
  const connection = connect(daemon);
  try {
    const sessionId =
      values.session ??
      (await connection.command<string>({
        type: "create",
        scope: values.scope ?? process.cwd(),
        ...(values.backend === undefined ? {} : { backend: values.backend }),
        ...(values.model ? { modelId: values.model } : {}),
        ...(effort ? { effort } : {}),
      }));

    console.log(
      values.session ? `resuming ${sessionId}` : `session ${sessionId}\n  resume with: --session ${sessionId}`,
    );

    let state: ViewState = initialState();
    let rendered = 0;
    /** The call already refused, so a snapshot arriving while the decision is in flight is ignored. */
    let refused: string | undefined;
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
        /*
         * Denied rather than aborted, which is the one place this parts company with the Enquiry
         * above — and the reason is the third option an Enquiry does not have.
         *
         * A denial is a *complete* answer to a Permission Prompt: the model is told the tool is not
         * available and carries on, which is exactly what this runner did before prompts existed. So
         * refusing keeps `flow "do X"` finishing its turn, where aborting would kill every headless
         * run that touched an MCP tool. An Enquiry has no such answer — nothing stands in for what a
         * human would have chosen — so there, ending the turn is the only honest move.
         *
         * Printed rather than silent, because a refused tool may be the reason the answer is thin,
         * and the human should know where it can be authorised instead.
         *
         * Driven off `state.authorising` rather than off the event, and that is not a style choice.
         * This subscribes at `since: 0`, so `--session` replays the whole transcript — and every
         * `asked` snapshot in it. The reducer already knows which of them was decided afterwards and
         * which is genuinely still waiting, so asking it is what stops a resumed run refusing a
         * dozen long-settled calls. `refused` then stops it sending twice for the one that is open,
         * since `authorising` stays set until the decision comes back over the stream.
         */
        if (state.authorising && state.authorising.callId !== refused) {
          const { tool, callId } = state.authorising;
          refused = callId;
          console.log(`  ! ${tool} needs authorising, and this runner has no way to ask; refusing it`);
          console.log(`  ! authorise it with: --session ${sessionId}  (or open it in the TUI)`);
          // Rejection swallowed rather than dropped: `--session` resumes a live Agent Session, and a
          // call decided in another client between the reducer seeing it and this landing comes back
          // as a refusal. There is nothing to do about that — the prompt is settled either way — and
          // an unhandled rejection here would take the process down over somebody else's click.
          void connection
            .command({ type: "answer_permission", sessionId, callId, decision: "deny" })
            .catch(() => undefined);
        }
        if (entry.event.type === "turn_ended") done?.();
      },
    });

    await connection.command({ type: "send", sessionId, text: prompt, when: "now" });
    await finished;
    render(state, rendered, true);
    unsubscribe();
    // Leave the session Dormant rather than ending it: the point of a transcript is coming back.
    return 0;
  } finally {
    await stop();
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
    case "tool": {
      // The authorisation only when there is one: most rows have none, and printing something for
      // them would suggest a judgement nobody was asked to make.
      const authorised = authorisationLabel(entry.authorisation);
      return `  · ${entry.name} (${entry.status}${authorised ? `, ${authorised}` : ""})`;
    }
    case "subagent":
      return `  ⤷ ${entry.name} (${entry.waitingOn ? `waiting on ${entry.waitingOn}` : entry.status})`;
    case "background_call":
      return `  ⟳ ${entry.tool} in the background (${entry.status})`;
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

async function hostStatus(identity: HostIdentity): Promise<HostIdentity | undefined> {
  try {
    const response = await fetch(`${identity.url}/api/host`, { headers: { authorization: `Bearer ${identity.token}` }, signal: AbortSignal.timeout(1000) });
    if (!response.ok) return undefined;
    const status = await response.json() as HostIdentity;
    return status.instanceId === identity.instanceId ? status : undefined;
  } catch { return undefined; }
}

async function waitUntil(check: () => Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function startBackground(settings: HostIdentity['settings']): Promise<void> {
  mkdirSync(resolve(defaultStateRoot()), { recursive: true, mode: 0o700 });
  const root = realpathSync(resolve(defaultStateRoot()));
  const logPath = join(root, 'host.log');
  const log = openSync(logPath, 'a', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    fchmodSync(log, 0o600);
    child = spawn(process.execPath, [...(isSea() ? [] : [...process.execArgv, resolve(process.argv[1]!)]), 'serve', '--background-host', '--port', String(settings.port), '--address', settings.address], {
      cwd: settings.cwd, detached: true, stdio: ['ignore', log, log], env: { ...process.env, FLOW_STATE_DIR: root },
    });
  } finally { closeSync(log); }
  let failure: Error | undefined;
  child.on('error', error => { failure = error; });
  child.on('exit', code => { failure = new Error(`Session Host startup failed (${code})`); });
  child.unref();
  try {
    await waitUntil(async () => {
      if (failure) throw failure;
      const identity = readHost(root);
      return !!identity && identity.pid === child.pid && !!await hostStatus(identity);
    }, 'Session Host startup timed out; inspect serve status before retrying');
  } catch (error) {
    child.kill('SIGTERM');
    throw new Error(`${error instanceof Error ? error.message : String(error)}; see ${logPath}`);
  }
  console.log('Session Host started');
}

async function controlHost(command: string, values: { port?: string; address?: string; force: boolean }): Promise<number> {
  const identity = readHost(defaultStateRoot());
  const status = identity ? await hostStatus(identity) : undefined;
  if (command === 'status') {
    console.log(`Installed version: ${installedVersion()}`);
    console.log(status ? `Session Host: ${status.mode} ${status.url}\nRunning version: ${status.version}` : 'Session Host: not reachable');
    return status ? 0 : 1;
  }
  if (command === 'start') {
    if (status) throw new Error('A Session Host is already running');
    await startBackground({ port: values.port ? Number(values.port) : 0, address: values.address ?? LOOPBACK, cwd: process.cwd(), oidc: oidcFingerprint() });
    return 0;
  }
  if (command !== 'stop' && command !== 'restart') throw new Error(`Unknown serve command: ${command}`);
  if (!identity || !status) throw new Error('No reachable Session Host');
  if (command === 'restart') {
    if (status.mode !== 'background') throw new Error('Only a background-owned Session Host can restart');
    if (status.settings.oidc !== oidcFingerprint()) throw new Error('Restart requires matching OIDC configuration');
    if (!statSync(status.settings.cwd).isDirectory()) throw new Error('Saved working directory is unavailable');
  }
  const response = await fetch(`${identity.url}/api/host/stop`, {
    method: 'POST', headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ instanceId: identity.instanceId, force: values.force }), signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(await response.text());
  await waitUntil(async () => readHost(defaultStateRoot())?.instanceId !== identity.instanceId, 'Session Host stop timed out; it is still stopping');
  console.log('Session Host stopped');
  if (command === 'restart') await startBackground(status.settings);
  return 0;
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
    if (readHost(defaultStateRoot())?.pid !== process.pid) process.exit(1);
    process.exitCode = 1;
  });
