import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { BackendEvent } from "../../protocol/events.ts";

type Call = { process: ChildProcess; done: Promise<void>; output: string; truncated: boolean; exitCode: number | null; stopped: boolean };

export class WorkflowProcesses {
  private readonly calls = new Map<string, Call>();
  private closed = false;

  private readonly scope: string;
  private readonly emit: (event: BackendEvent) => void;

  constructor(scope: string, emit: (event: BackendEvent) => void) {
    this.scope = scope;
    this.emit = emit;
  }

  readonly server = createSdkMcpServer({ name: "workflow", tools: [
    tool("bash", "Run a shell command. Background calls are owned by this workflow step. Do not detach processes yourself.",
      { command: z.string(), run_in_background: z.boolean().optional(), call_id: z.string().optional() }, async (input) => {
        const id = this.start(input.command, input.run_in_background === true, input.call_id);
        if (!input.run_in_background) await this.calls.get(id)!.done;
        return this.result(id);
      }),
    tool("bash_output", "Read output and status of an owned shell call.", { call_id: z.string() }, async ({ call_id }) => this.result(call_id)),
    tool("kill_shell", "Stop an owned shell call and wait for it to exit.", { call_id: z.string() }, async ({ call_id }) => {
      const call = this.get(call_id);
      this.stop(call);
      await call.done;
      return this.result(call_id);
    }),
  ] });

  start(command: string, background: boolean, id: string = randomUUID()): string {
    if (this.closed) throw new Error("Workflow processes stopped");
    if (process.platform === "win32") throw new Error("Workflow shell tools require POSIX process groups");
    if (this.calls.has(id)) throw new Error(`Duplicate workflow shell call: ${id}`);
    const child = spawn("/bin/bash", ["-c", command], { cwd: this.scope, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const call: Call = { process: child, done: Promise.resolve(), output: "", truncated: false, exitCode: null, stopped: false };
    this.calls.set(id, call);
    if (background) this.emit({ type: "background_call", callId: id, tool: "mcp__workflow__bash", state: "running" });
    const append = (data: Buffer) => {
      const output = call.output + data.toString();
      call.truncated ||= output.length > 100_000;
      call.output = output.slice(-100_000);
    };
    child.stdout!.on("data", append);
    child.stderr!.on("data", append);
    child.on("error", (error) => append(Buffer.from(error.message)));
    child.on("exit", () => this.killGroup(call));
    call.done = new Promise((resolve) => child.once("close", (code) => {
      call.exitCode = code;
      if (background) this.emit({ type: "background_call", callId: id, tool: "mcp__workflow__bash",
        state: call.stopped ? "aborted" : code === 0 ? "complete" : "error" });
      resolve();
    }));
    return id;
  }

  private get(id: string): Call {
    const call = this.calls.get(id);
    if (!call) throw new Error(`Unknown workflow shell call: ${id}`);
    return call;
  }

  private result(id: string) {
    const call = this.get(id);
    return { content: [{ type: "text" as const, text: JSON.stringify({ call_id: id, output: call.output,
      ...(call.truncated ? { truncated: true } : {}), exitCode: call.exitCode, running: call.process.exitCode === null && call.process.signalCode === null }) }] };
  }

  private killGroup(call: Call): void {
    if (!call.process.pid) return;
    try { process.kill(-call.process.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  }

  private stop(call: Call): void {
    call.stopped = true;
    this.killGroup(call);
  }

  async drain(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.calls.values()].map((call) => call.done));
  }

  async dispose(): Promise<void> {
    this.closed = true;
    for (const call of this.calls.values()) {
      if (call.process.exitCode === null && call.process.signalCode === null) this.stop(call);
    }
    await this.drain();
  }
}
