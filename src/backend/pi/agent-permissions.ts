import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { AgentPermissionMode, BackendEvent, PermissionDecision, Producer } from "../../protocol/events.ts";
import { callIdFor } from "./work.ts";

/** A single decision register shared by the parent and ordinary Subagents. Workflow Steps do not use it. */
export class PiAgentPermissions {
  mode: AgentPermissionMode;
  private readonly emit: (event: BackendEvent) => void;
  private readonly pending = new Map<string, { tool: string; settle: (decision: PermissionDecision | undefined) => void; producer?: Producer }>();
  private readonly grants: Set<string>;
  private readonly refused = new Set<string>();
  constructor(mode: AgentPermissionMode, standing: readonly string[], emit: (event: BackendEvent) => void) {
    if (mode === "auto") throw new Error("Pi does not support Auto permissions");
    this.mode = mode;
    this.emit = emit;
    this.grants = new Set(standing);
  }
  setMode(mode: AgentPermissionMode): void {
    if (mode === "auto") throw new Error("Pi does not support Auto permissions");
    this.mode = mode;
  }
  answer(id: string, decision: PermissionDecision): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle(decision);
    return true;
  }
  cancel(producer?: Producer): void {
    for (const entry of [...this.pending.values()]) {
      if (producer === undefined || (producer.subagentId === "" ? !entry.producer : entry.producer?.subagentId === producer.subagentId)) entry.settle(undefined);
    }
  }
  extension(producer?: Producer): InlineExtension {
    return { name: "flow-agent-permissions", hidden: true, factory: (pi) => {
      pi.on("tool_call", async (event, ctx) => {
        const tool = event.toolName;
        if (tool === "read" || tool === "ask_question" || tool === "subagent" || tool === "bash_output" || tool === "kill_shell" || tool.startsWith("workflow_") ||
            this.grants.has(tool) || this.mode === "always") return;
        const refusedKey = `${producer?.subagentId ?? "parent"}/${tool}`;
        if (this.refused.has(refusedKey)) return { block: true, reason: `${tool} is not authorised` };
        const id = callIdFor(event.toolCallId, producer);
        const decision = await new Promise<PermissionDecision | undefined>((resolve) => {
          let settled = false;
          const settle = (value: PermissionDecision | undefined) => {
            if (settled) return;
            settled = true;
            ctx.signal?.removeEventListener("abort", onAbort);
            this.pending.delete(id);
            this.emit(value ? { type: "permission", callId: id, tool, ...(producer ? { producer } : {}), state: "decided", decision: value } : { type: "permission", callId: id, tool, ...(producer ? { producer } : {}), state: "aborted" });
            resolve(value);
          };
          const onAbort = () => settle(undefined);
          this.pending.set(id, { tool, settle, ...(producer ? { producer } : {}) });
          ctx.signal?.addEventListener("abort", onAbort, { once: true });
          this.emit({ type: "permission", callId: id, tool, ...(producer ? { producer } : {}), state: "asked" });
          if (ctx.signal?.aborted) onAbort();
        });
        if (decision === "always") this.grants.add(tool);
        if (decision === "deny") this.refused.add(refusedKey);
        return decision === "allow" || decision === "always" ? undefined : { block: true, reason: `${tool} is not authorised` };
      });
      pi.on("agent_settled", () => { for (const key of this.refused) if (key.startsWith(`${producer?.subagentId ?? "parent"}/`)) this.refused.delete(key); });
    } };
  }
}
