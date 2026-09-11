import { truncateTail, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BackendEvent, Producer, TurnEndReason } from "../../protocol/events.ts";

export type ToolResult = AgentToolResult<unknown>;
export type WorkBrief =
  | { type: "subagent"; subagentId: string; name: string; description: string }
  | { type: "background_call"; callId: string; tool: string; producer?: Producer };
export type Completion = { brief: WorkBrief; state: TurnEndReason; result: ToolResult };
type Work = { brief: WorkBrief; controller: AbortController; done: Promise<Completion>; state: "running" | "waiting" | TurnEndReason; result: ToolResult };

export function textResult(text: string): ToolResult {
  const cut = truncateTail(text);
  return { content: [{ type: "text", text: cut.content + (cut.truncated ? "\n[Output truncated]" : "") }], details: undefined };
}

export function resultText(result: ToolResult): string {
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}

export function callIdFor(id: string, producer?: Producer): string {
  return producer ? `${producer.subagentId}/${id}` : id;
}

export class PiWork {
  private readonly jobs = new Map<string, Work>();
  private disposed = false;
  private readonly emit: (event: BackendEvent) => void;
  private readonly completed: (completion: Completion) => void;

  constructor(emit: (event: BackendEvent) => void, completed: (completion: Completion) => void) {
    this.emit = emit;
    this.completed = completed;
  }

  async run(brief: WorkBrief, execute: (signal: AbortSignal, update: (result: ToolResult) => void) => Promise<ToolResult>, background: boolean, parentSignal?: AbortSignal): Promise<ToolResult> {
    if (this.disposed || parentSignal?.aborted) throw new Error("Backend Session stopped");
    const id = brief.type === "subagent" ? brief.subagentId : brief.callId;
    const controller = new AbortController();
    const signal = !background && parentSignal ? AbortSignal.any([controller.signal, parentSignal]) : controller.signal;
    const done = Promise.resolve().then(async (): Promise<Completion> => {
      try {
        signal.throwIfAborted();
        const result = await execute(signal, (result) => { work.result = result; });
        return { brief, state: signal.aborted ? "aborted" : "complete", result };
      } catch (error) {
        return { brief, state: signal.aborted ? "aborted" : "error", result: textResult(error instanceof Error ? error.message : String(error)) };
      }
    }).then((completion) => {
      work.state = completion.state;
      work.result = completion.result;
      if (brief.type === "subagent") this.jobs.delete(id);
      this.emit({ ...brief, state: completion.state });
      if (background && !this.disposed) this.completed(completion);
      return completion;
    });
    const work: Work = { brief, controller, done, state: "running", result: textResult("Running") };
    this.jobs.set(id, work);
    this.emit({ ...brief, state: "running" });
    if (background) return textResult(JSON.stringify({ callId: id, state: "running" }));
    const completion = await done;
    if (completion.state !== "complete") throw new Error(resultText(completion.result));
    return completion.result;
  }

  waiting(id: string, waiting: boolean): void {
    const work = this.jobs.get(id);
    if (!work || work.brief.type !== "subagent" || !["running", "waiting"].includes(work.state)) return;
    const state = waiting ? "waiting" : "running";
    if (work.state === state) return;
    work.state = state;
    this.emit(waiting ? { ...work.brief, state: "waiting", on: "provider" } : { ...work.brief, state: "running" });
  }

  read(id: string, producer?: Producer): ToolResult {
    const work = this.call(id, producer);
    return { ...work.result, content: [
      { type: "text", text: JSON.stringify({ callId: id, state: work.state }) }, ...work.result.content,
    ] };
  }

  async stop(id: string, producer?: Producer): Promise<ToolResult> {
    const work = this.call(id, producer);
    work.controller.abort();
    await work.done;
    return this.read(id, producer);
  }

  private call(id: string, producer?: Producer): Work {
    const work = this.jobs.get(id);
    if (!work || work.brief.type !== "background_call" ||
      (producer && work.brief.producer?.subagentId !== producer.subagentId)) throw new Error(`Unknown Background Call: ${id}`);
    return work;
  }

  async stopOwnedCalls(subagentId: string): Promise<void> {
    const jobs = [...this.jobs.values()].filter((work) => work.brief.type === "background_call" && work.brief.producer?.subagentId === subagentId);
    for (const work of jobs) work.controller.abort();
    await Promise.all(jobs.map((work) => work.done));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    const jobs = [...this.jobs.values()];
    for (const work of jobs) work.controller.abort();
    await Promise.all(jobs.map((work) => work.done));
    this.jobs.clear();
  }
}
