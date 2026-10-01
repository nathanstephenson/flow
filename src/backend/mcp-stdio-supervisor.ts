import { spawn, type ChildProcess } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

export type StdioLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Pinned Bubblewrap sources, starting at fd 3. No server runs before boundary setup. */
  stdioFds?: number[];
};

/** Lifecycle ownership is independent of filesystem isolation. Use the SDK's public framing,
 * not its private subprocess fields. This code is statically loaded in npm and SEA builds;
 * there is no executable helper in a writable Scope or source-relative runtime asset.
 *
 * POSIX groups cover ordinary children, not deliberately detached unrestricted descendants.
 * Pipe closure is therefore separate from process exit: an escaped pipe holder must never
 * hold Retry/disposal open. Windows uses bounded, best-effort taskkill tree cleanup.
 */
export class SupervisedStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();
  private child?: ChildProcess;
  private started = false;
  private closed = false;
  private notified = false;
  private closing?: Promise<void>;
  private finishing?: Promise<void>;
  private leaderExited = false;
  private treeCleanup?: Promise<void>;
  private resolveExit!: () => void;
  /** Actual leader exit (not stdio 'close'), plus group cleanup. State must outlive this. */
  readonly exited = new Promise<void>((resolve) => { this.resolveExit = resolve; });

  private readonly launch: StdioLaunch;
  constructor(launch: StdioLaunch) { this.launch = launch; }

  async start(): Promise<void> {
    if (this.started || this.closed) throw new Error("MCP transport already started or closed");
    this.started = true;
    try {
      const child = this.child = spawn(this.launch.command, this.launch.args, {
        env: this.launch.env,
        cwd: this.launch.cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe", ...(this.launch.stdioFds ?? [])],
      });
      child.stdin!.on("error", error => this.onerror?.(error));
      child.stdout!.on("error", error => this.onerror?.(error));
      // Drain, but do not retain server diagnostics or host secrets.
      child.stderr!.on("error", error => this.onerror?.(error));
      child.stderr!.resume();
      child.stdout!.on("data", (chunk: Buffer) => {
        try { this.buffer.append(chunk); }
        catch (error) { this.onerror?.(error as Error); void this.close(); return; }
        while (!this.closed) {
          try {
            const message = this.buffer.readMessage();
            if (message === null) break;
            this.onmessage?.(message);
          } catch (error) { this.onerror?.(error as Error); }
        }
      });
      // 'close' can wait forever for a descendant's inherited stdout/stderr. 'exit' cannot.
      child.once("exit", () => { void this.finishExit(); });
      child.once("error", error => {
        this.onerror?.(error);
        if (!child.pid) void this.finishExit();
      });
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", resolve);
        child.once("error", reject);
      });
    } catch (error) {
      if (!this.child?.pid) await this.finishExit();
      throw error;
    }
  }

  private closePipes(): void {
    this.closed = true;
    this.child?.stdin?.destroy();
    this.child?.stdout?.destroy();
    this.child?.stderr?.destroy();
    this.buffer.clear();
  }

  private killTree(): Promise<void> {
    return this.treeCleanup ??= (async () => {
      const child = this.child;
      if (!child?.pid) return;
      if (process.platform !== "win32") {
        try { process.kill(-child.pid, "SIGKILL"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            // Retain the error, but still try to stop the leader and close its pipes.
            this.onerror?.(error as Error);
            child.kill("SIGKILL");
          }
        }
      } else {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        await bounded(new Promise<void>(resolve => {
          killer.once("error", () => resolve());
          killer.once("exit", () => resolve());
        }), 1000);
        killer.kill();
        killer.unref();
        child.kill("SIGKILL");
      }
    })();
  }

  private drainStdout(): Promise<void> {
    const stdout = this.child?.stdout;
    if (this.closed || !stdout || stdout.destroyed || stdout.readableEnded) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer);
        stdout.off("end", done);
        stdout.off("close", done);
        stdout.off("error", done);
        resolve();
      };
      const timer = setTimeout(done, 1000);
      stdout.once("end", done);
      stdout.once("close", done);
      stdout.once("error", done);
      stdout.resume();
    });
  }

  private finishExit(): Promise<void> {
    return this.finishing ??= (async () => {
      this.leaderExited = true;
      // Kill ordinary pipe holders first, but retain stdout until its already-written
      // final reply drains. 'exit' can precede those data events. A detached holder
      // cannot force an unbounded EOF wait; explicit disposal may discard replies.
      await this.killTree();
      await this.drainStdout();
      this.closePipes();
      this.resolveExit();
      this.notifyClose();
    })();
  }

  private notifyClose(): void {
    if (this.notified) return;
    this.notified = true;
    this.onclose?.();
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      this.closed = true;
      if (!this.started) { await this.finishExit(); return; }
      // Give a well-behaved server EOF, then always kill the group, even if its leader
      // exited cooperatively. A SIGTERM-ignoring child must not outlive its client.
      this.child?.stdin?.end();
      await bounded(this.exited, 500);
      await this.killTree();
      this.closePipes();
      // A kernel-stalled leader need not block host shutdown. Its mount state is retained
      // until the actual exit event; do not pretend this bounded wait means it has exited.
      await bounded(this.exited, 1000);
      this.child?.unref();
      this.notifyClose();
    })();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.closed || this.leaderExited || !stdin || stdin.destroyed) throw new Error("MCP transport not connected");
    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), error => error ? reject(error) : resolve());
    });
  }
}

async function bounded(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([promise, new Promise<void>(resolve => { timer = setTimeout(resolve, milliseconds); })]);
  } finally { clearTimeout(timer); }
}
