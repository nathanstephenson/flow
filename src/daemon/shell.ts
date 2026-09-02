import { randomUUID } from "node:crypto";
import { platform } from "node:os";

import type { ShellSummary } from "../protocol/shells.ts";

/**
 * The Shells: pseudo-terminals the Session Host owns, opened beside an Agent Session and started in
 * its Scope.
 *
 * A Shell is not an Agent Session and it is not served by one. It holds no Presentation Transcript,
 * it is never Revived, and it does not survive a daemon restart — a process cannot. What it does
 * hold is a Scrollback: a bounded ring of the bytes it most recently wrote, kept only so a client
 * that closes the pane and reopens it does not arrive at a blank screen. That ring is lossy by
 * design and is never written to disk, which is the whole distinction from a Presentation
 * Transcript (ADR 0001).
 *
 * node-pty is imported lazily and its absence is reported rather than thrown. It is a native addon,
 * so `npm run build:binary` cannot contain it — the same position `koffi` and the pi adapter are
 * already in (scripts/build-binary.mjs). `available()` is what lets the web client hide the control
 * instead of offering one that breaks, which is the rule Capabilities already encodes for backends.
 */

/** Bytes of output kept per Shell for reattach. One screen of `ls -R` and change; not a history. */
const SCROLLBACK_LIMIT = 256 * 1024;

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** The subset of node-pty this file uses, declared here so the lazy import needs no type dependency. */
export type Pty = {
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number | undefined }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type PtyModule = {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): Pty;
};

export type ShellSink = {
  output(chunk: Buffer): void;
  exit(code: number | undefined, signal: number | undefined): void;
};

type ShellRecord = {
  summary: ShellSummary;
  pty: Pty;
  /** Newest last. Trimmed from the front once the total passes SCROLLBACK_LIMIT. */
  scrollback: Buffer[];
  scrollbackBytes: number;
  sinks: Set<ShellSink>;
  cols: number;
  rows: number;
  exited: boolean;
};

export type CreateShellOptions = {
  sessionId: string;
  cwd: string;
  cols?: number;
  rows?: number;
};

export type ShellRegistryOptions = {
  /**
   * How to obtain the pty binding. Overridable so the unavailable path is testable: it is the
   * behaviour of every build that cannot load the addon, and asserting it any other way would mean
   * uninstalling a dependency.
   */
  loadPty?: () => Promise<PtyModule>;
};

export class ShellRegistry {
  private readonly shells = new Map<string, ShellRecord>();
  private readonly loadPty: () => Promise<PtyModule>;
  private pty: PtyModule | undefined;
  private ptyLoad: Promise<PtyModule | undefined> | undefined;

  constructor(options: ShellRegistryOptions = {}) {
    this.loadPty = options.loadPty ?? (() => import("node-pty") as unknown as Promise<PtyModule>);
  }

  /**
   * Whether this build can open a Shell at all.
   *
   * Resolved by actually loading node-pty rather than by guessing from `process.platform`, because
   * the thing that fails is the addon load and nothing else predicts it.
   */
  async available(): Promise<boolean> {
    return (await this.load()) !== undefined;
  }

  async create(options: CreateShellOptions): Promise<ShellSummary> {
    const pty = await this.load();
    if (!pty) throw new Error("This build cannot open a Shell: node-pty is unavailable");

    const cols = options.cols ?? DEFAULT_COLS;
    const rows = options.rows ?? DEFAULT_ROWS;
    const id = randomUUID();
    const child = pty.spawn(shellCommand(), [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd: options.cwd,
      // TERM is set explicitly because the daemon may have been started by a launcher with no TERM
      // at all, and a shell that inherits an empty one renders as a dumb terminal.
      env: { ...stringEnv(), TERM: "xterm-256color" },
    });

    const record: ShellRecord = {
      summary: {
        id,
        sessionId: options.sessionId,
        cwd: options.cwd,
        createdAt: new Date().toISOString(),
      },
      pty: child,
      scrollback: [],
      scrollbackBytes: 0,
      sinks: new Set(),
      cols,
      rows,
      exited: false,
    };
    this.shells.set(id, record);

    child.onData((data) => {
      const chunk = Buffer.from(data, "utf8");
      remember(record, chunk);
      for (const sink of record.sinks) sink.output(chunk);
    });

    child.onExit(({ exitCode, signal }) => {
      record.exited = true;
      for (const sink of record.sinks) sink.exit(exitCode, signal);
      record.sinks.clear();
      this.shells.delete(id);
    });

    return record.summary;
  }

  get(shellId: string): ShellSummary | undefined {
    return this.shells.get(shellId)?.summary;
  }

  listFor(sessionId: string): ShellSummary[] {
    return [...this.shells.values()]
      .filter((record) => record.summary.sessionId === sessionId)
      .map((record) => record.summary);
  }

  /**
   * Watch a Shell, starting with its Scrollback.
   *
   * The replay is written to this sink alone rather than broadcast, so a second client attaching
   * does not repaint the first one's screen. Returns the detach, which does not kill the Shell:
   * closing the pane is hide, not kill.
   */
  attach(shellId: string, sink: ShellSink): () => void {
    const record = this.shells.get(shellId);
    if (!record) throw new Error(`No Shell ${shellId}`);

    if (record.scrollbackBytes > 0) sink.output(Buffer.concat(record.scrollback));
    record.sinks.add(sink);
    return () => record.sinks.delete(sink);
  }

  write(shellId: string, data: Buffer): void {
    const record = this.shells.get(shellId);
    if (!record || record.exited) return;
    record.pty.write(data.toString("utf8"));
  }

  /**
   * Resize the pty.
   *
   * Last writer wins, deliberately. Two clients watching one Shell at different window sizes cannot
   * both be satisfied — a pty has one size — and the alternative, taking the minimum, punishes the
   * person actually typing for a tab someone left open.
   */
  resize(shellId: string, cols: number, rows: number): void {
    const record = this.shells.get(shellId);
    if (!record || record.exited) return;
    if (cols <= 0 || rows <= 0) return;
    if (record.cols === cols && record.rows === rows) return;
    record.cols = cols;
    record.rows = rows;
    record.pty.resize(cols, rows);
  }

  kill(shellId: string): void {
    const record = this.shells.get(shellId);
    if (!record) return;
    // Left in the map: onExit removes it, and does so after telling every sink why the screen
    // stopped. Deleting here would strand watchers on a socket that never says anything again.
    record.pty.kill();
  }

  /** Every Shell opened beside one Agent Session. The Settle, End and Reap path. */
  killFor(sessionId: string): void {
    for (const record of this.shells.values()) {
      if (record.summary.sessionId === sessionId) record.pty.kill();
    }
  }

  killAll(): void {
    for (const record of this.shells.values()) record.pty.kill();
  }

  private async load(): Promise<PtyModule | undefined> {
    if (this.pty) return this.pty;
    // Memoised on the promise, not the result: two concurrent creates must not both import.
    this.ptyLoad ??= this.loadPty()
      .then((module) => {
        this.pty = module;
        return this.pty;
      })
      .catch(() => undefined);
    return await this.ptyLoad;
  }
}

function remember(record: ShellRecord, chunk: Buffer): void {
  record.scrollback.push(chunk);
  record.scrollbackBytes += chunk.byteLength;
  while (record.scrollbackBytes > SCROLLBACK_LIMIT && record.scrollback.length > 1) {
    const dropped = record.scrollback.shift();
    record.scrollbackBytes -= dropped?.byteLength ?? 0;
  }
}

/**
 * The reader's own shell. $SHELL is what they chose; the fallbacks are only for a daemon started
 * without an environment.
 */
function shellCommand(): string {
  const configured = process.env["SHELL"];
  if (configured) return configured;
  return platform() === "win32" ? "powershell.exe" : "/bin/sh";
}

/** process.env with the undefined values dropped, which is what node-pty's env type wants. */
function stringEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}
