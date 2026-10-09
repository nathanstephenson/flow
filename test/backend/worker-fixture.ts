import { spawn, type ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { readlinkSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { claudeMcpServers } from "../../src/backend/claude/mcp.ts";
import { AutoPermissionUnavailable } from "../../src/backend/permission-errors.ts";
import type { AgentBackend, BackendSession, WorkflowSubagentHandle } from "../../src/backend/types.ts";
import type { Capabilities } from "../../src/protocol/events.ts";

const capabilities: Capabilities = { providers: ["fixture"], models: [{ id: "fixture-model", provider: "fixture", label: "Fixture" }], compaction: true, fork: false, subagents: true, enquiries: true, permissions: true };
const backend: AgentBackend = {
  name: "fixture",
  async create(options) {
    if (options.modelId === "create-error") throw new Error("fixture create failed");
    if (options.modelId === "auto-unavailable" && options.permissionMode === "auto") throw new AutoPermissionUnavailable("fixture Auto unsupported");
    if (options.modelId === "create-hang") await new Promise(() => {});
    let permissionMode = options.permissionMode ?? "always";
    let resume = "initial-token";
    let activeCapabilities = capabilities;
    let finishPrompt: (() => void) | undefined;
    let ownedProcess: ChildProcess | undefined;
    const handles = new Set<WorkflowSubagentHandle>();
    const session: BackendSession = {
      get capabilities() { return activeCapabilities; },
      resumeToken: () => resume,
      async prompt(text) {
        options.emit({ type: "turn_started", turnId: "fixture-turn" });
        if (text === "crash") { process.exit(23); }
        if (text === "permission-mode") options.emit({ type: "message", id: "permission-mode", text: permissionMode, final: true });
        if (text === "late-crash") {
          options.emit({ type: "subagent", subagentId: "child", name: "child", state: "running" });
          options.emit({ type: "background_call", callId: "job", tool: "Bash", state: "running" });
          options.emit({ type: "permission", callId: "permission", tool: "Bash", state: "asked", producer: { subagentId: "child" } });
          setTimeout(() => process.exit(23), 100);
          return;
        }
        if (text === "hold") await new Promise<void>((resolve) => { finishPrompt = resolve; });
        if (text === "descendant") {
          ownedProcess = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
          options.emit({ type: "message", id: "process", text: JSON.stringify({ pid: ownedProcess.pid, namespace: readlinkSync("/proc/self/ns/pid") }), final: true });
        }
        if (text === "claude-mcp") {
          const servers = claudeMcpServers(options.mcp);
          const listings: Record<string, unknown> = {};
          for (const [id, server] of Object.entries(servers)) {
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            const client = new Client({ name: "fixture", version: "1" });
            try {
              await server.instance.connect(serverTransport);
              await client.connect(clientTransport);
              const { tools } = await client.listTools();
              listings[id] = tools.map((tool) => tool.name);
              if (tools.length) await client.callTool({ name: tools[0]!.name, arguments: { fixture: true } });
            } finally {
              await client.close();
              await server.instance.close();
            }
          }
          options.emit({ type: "message", id: "claude-mcp", text: JSON.stringify(listings), final: true });
        }
        if (text === "mcp-hold") await options.mcp!.tools()[0]!.call({ hold: true });
        if (text === "mcp") {
          const result = await options.mcp!.tools()[0]!.call({ fixture: true }, undefined, 1234);
          options.emit({ type: "message", id: "mcp", text: JSON.stringify(result), final: true });
        }
        if (text === "workflow") {
          const result = await options.workflow!.inspect({ section: "summary" });
          options.emit({ type: "message", id: "workflow", text: JSON.stringify(result), final: true });
        }
        if (text === "cancel-reverse") {
          const controller = new AbortController();
          const call = options.workflow!.relayEnquiry({ requestId: "f2ef600a-f80d-4801-9ecb-1322cbd75d03" }, controller.signal);
          setTimeout(() => controller.abort(), 50);
          await call.catch(() => {});
        }
        options.emit({ type: "turn_ended", turnId: "fixture-turn", reason: "complete" });
      },
      async abort() { finishPrompt?.(); },
      async setModel(modelId) {
        resume = modelId;
        activeCapabilities = { ...capabilities, providers: [modelId] };
        options.emit({ type: "capabilities_changed", capabilities: activeCapabilities });
        options.emit({ type: "model_changed", model: { id: modelId } });
      },
      async setEffort(effort) { options.emit({ type: "effort_changed", effort }); },
      async setPermissionMode(mode) {
        if (mode === "auto") throw new Error("Pi does not support Auto permissions");
        permissionMode = mode;
      },
      async compact() { options.emit({ type: "turn_started", turnId: "compaction" }); options.emit({ type: "turn_ended", turnId: "compaction", reason: "complete" }); },
      async skills() { return [{ name: "fixture", description: "fixture skill" }]; },
      async refreshMcp() { options.emit({ type: "message", id: "tools", text: options.mcp!.tools().map((tool) => tool.name).join(","), final: true }); },
      async answerEnquiry(askId) { if (askId !== "open") return false; finishPrompt?.(); return true; },
      async answerPermission(callId) { if (callId !== "open") return false; finishPrompt?.(); return true; },
      startWorkflowSubagent(workflow) {
        let resolve!: (text: string) => void;
        let reject!: (error: Error) => void;
        const handle: WorkflowSubagentHandle = {
          done: new Promise<string>((yes, no) => { resolve = yes; reject = no; }),
          async answerEnquiry(id) { if (id !== "ask") return false; resolve("answered"); return true; },
          async answerPermission(id) { if (id !== "permission") return false; resolve("allowed"); return true; },
          async cancel() { await new Promise((resolve) => setTimeout(resolve, 50)); reject(new Error("workflow cancelled")); },
        };
        handles.add(handle);
        void handle.done.finally(() => handles.delete(handle)).catch(() => {});
        workflow.emit({ subagentId: workflow.id, event: { type: "notice", level: "info", text: "started" } });
        if (workflow.instructions === "finish") queueMicrotask(() => resolve("finished"));
        return handle;
      },
      async dispose() {
        finishPrompt?.();
        await Promise.allSettled([...handles].map((handle) => handle.cancel()));
        if (options.modelId === "dispose-hang") await new Promise(() => {});
        if (ownedProcess) {
          const stopped = new Promise<void>((resolve) => ownedProcess!.once("close", () => resolve()));
          ownedProcess.kill();
          await stopped;
        }
        await writeFile(join(options.scope, "disposed"), "yes");
      },
    };
    options.emit({ type: "capabilities_changed", capabilities });
    return session;
  },
};
export default backend;
