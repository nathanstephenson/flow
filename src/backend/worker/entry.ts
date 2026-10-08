import type { AgentBackend, BackendSession, WorkflowSubagentHandle, PromptAttachment } from "../types.ts";
import type { McpSession, McpTool } from "../mcp.ts";
import type { WorkflowParent } from "../workflow-tools.ts";
import type { WorkflowBuilder } from "../workflow-builder.ts";
import type { EffortLevel, PermissionDecision } from "../../protocol/events.ts";
import { WorkerRpc, errorText } from "./rpc.ts";
import { snapshot, type CreateMetadata, type McpToolMetadata, type WorkflowMetadata, type SessionSnapshot } from "./protocol.ts";
import { killWorkerTree } from "./launcher.ts";
import type { ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { isSea } from "node:sea";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isFilesystemLauncher, runFilesystemLauncher } from "../../isolation/launcher.ts";

/** Private executable entry; no host/state initialization takes place in this process. */
export function runWorker(): void {
  if (isFilesystemLauncher()) {
    void runFilesystemLauncher().catch((error: unknown) => {
      console.error(errorText(error)); process.exitCode = 1;
    });
    return;
  }
  if (!process.send) throw new Error("Backend worker requires an IPC channel");
  let session: BackendSession | undefined;
  let published: SessionSnapshot | undefined;
  const publishSnapshot = () => (published = snapshot(session!));
  let creating = false;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  let tools: McpTool[] = [];
  const workflows = new Map<string, WorkflowSubagentHandle>();
  const send = (message: Parameters<NonNullable<typeof process.send>>[0]) => {
    if (!process.connected) throw new Error("Backend worker disconnected");
    process.send!(message, (error) => { if (error) void stop(); });
  };
  const rpc = new WorkerRpc(send, async (method, args) => {
    if (method === "create") {
      if (creating || closing) throw new Error("Backend worker already initialized");
      creating = true;
      const { mcpTools, workflowEnabled, workflowBuilderInstructions, backendModule, backend: backendName = "pi", ...options } = args[0] as CreateMetadata;
      const workflowBuilder: WorkflowBuilder | undefined = workflowBuilderInstructions === undefined ? undefined : {
        instructions: workflowBuilderInstructions,
        read: (path) => rpc.call("workflowBuilder.read", [path]),
        list: (path) => rpc.call("workflowBuilder.list", [path]),
        write: (content) => rpc.call("workflowBuilder.write", [content]),
      };
      updateTools(mcpTools ?? []);
      const workflow: WorkflowParent = {
        inspect: (input) => rpc.call("workflow.inspect", [input]),
        recover: (input, signal) => rpc.call("workflow.recover", [input], signal),
        relayEnquiry: (input, signal) => rpc.call("workflow.relayEnquiry", [input], signal),
        relayPermission: (input, signal) => rpc.call("workflow.relayPermission", [input], signal),
      };
      let backend: AgentBackend;
      try {
        backend = backendModule
          ? (isSea()
            ? createRequire(pathToFileURL(process.execPath))(fileURLToPath(backendModule)).default
            : (await import(backendModule)).default)
          : backendName === "claude" ? new (await import("../claude/index.ts")).ClaudeBackend()
          : new (await import("../pi/index.ts")).PiBackend();
      } catch (error) {
        throw new Error(`Backend "${backendName}" is not available in this build: ${errorText(error)}`);
      }
      session = await backend.create({
        ...options,
        ...(workflowBuilder ? { workflowBuilder } : {
          ...(mcpTools ? { mcp: { tools: () => tools } as McpSession } : {}),
          ...(workflowEnabled ? { workflow } : {}),
        }),
        emit: (event) => {
          // Models can be a large catalogue. Do not resend it for every text/tool delta, but do
          // mirror any changed state before the event that exposes it to the Session Host.
          const changed = session && (session.capabilities !== published?.capabilities || session.resumeToken() !== published?.resume);
          rpc.notify("event", { event, ...(changed ? { snapshot: publishSnapshot() } : {}) });
        },
      });
      if (closing) { await session.dispose(); throw new Error("Backend worker stopped during initialization"); }
      return publishSnapshot();
    }
    if (method === "dispose") {
      await disposeSession();
      // The RPC reply must be queued before disconnecting and exiting.
      setImmediate(() => { if (process.connected) process.disconnect(); process.exit(0); });
      return;
    }
    if (!session || closing) throw new Error("Backend worker is not running");
    let result: unknown;
    switch (method) {
      case "prompt": result = await session.prompt(args[0] as string, args[1] as PromptAttachment[] | undefined); break;
      case "abort": result = await session.abort(); break;
      case "setModel": result = await session.setModel(args[0] as string); break;
      case "setEffort": result = await session.setEffort(args[0] as EffortLevel); break;
      case "setPermissionMode": {
        const mode = args[0];
        if (mode !== "ask" && mode !== "auto" && mode !== "always") throw new Error("Invalid permission mode");
        if (!session.setPermissionMode) throw new Error("Permission mode changes are not supported");
        result = await session.setPermissionMode(mode);
        break;
      }
      case "compact": result = await session.compact?.(args[0] as string | undefined); break;
      case "skills": result = await session.skills?.(); break;
      case "answerEnquiry": result = await session.answerEnquiry?.(args[0] as string, args[1] as string[][]) ?? false; break;
      case "answerPermission": result = await session.answerPermission?.(args[0] as string, args[1] as PermissionDecision) ?? false; break;
      case "refreshMcp": updateTools(args[0] as McpToolMetadata[]); result = await session.refreshMcp?.(); break;
      case "workflow.start": {
        if (!session.startWorkflowSubagent) throw new Error("Workflow Subagents are not supported");
        const id = args[0] as string;
        if (workflows.has(id)) throw new Error("Duplicate workflow handle");
        const handle = session.startWorkflowSubagent({ ...(args[1] as WorkflowMetadata), emit: (activity) => rpc.notify("workflow.event", { id, activity }) });
        workflows.set(id, handle);
        void handle.done.then(
          (value) => rpc.notify("workflow.done", { id, value }),
          (error: unknown) => rpc.notify("workflow.done", { id, error: errorText(error) }),
        ).finally(() => workflows.delete(id)).catch(() => {});
        break;
      }
      case "workflow.answerEnquiry": result = await workflows.get(args[0] as string)?.answerEnquiry(args[1] as string, args[2] as string[][]) ?? false; break;
      case "workflow.answerPermission": result = await workflows.get(args[0] as string)?.answerPermission(args[1] as string, args[2] as PermissionDecision) ?? false; break;
      case "workflow.cancel": result = await workflows.get(args[0] as string)?.cancel(); break;
      default: throw new Error(`Unknown worker method: ${method}`);
    }
    rpc.notify("snapshot", publishSnapshot());
    return result;
  }, () => {});

  function updateTools(metadata: McpToolMetadata[]) {
    tools = metadata.map((tool) => ({ ...tool, call: (input, signal, timeoutMs) => rpc.call("mcp.call", [tool.name, input, timeoutMs], signal) }));
  }
  async function disposeSession() {
    closing = true;
    await Promise.allSettled([...workflows.values()].map((handle) => handle.cancel()));
    await session?.dispose();
  }
  function stop(): Promise<void> {
    return shutdown ??= (async () => {
      rpc.close(new Error("Backend worker disconnected"));
      const timer = setTimeout(() => {
        // The host may itself have died: retain the tree-kill fallback on this side too.
        void killWorkerTree({ pid: process.pid } as ChildProcess).finally(() => process.exit(1));
      }, 5000);
      try { await disposeSession(); } finally { clearTimeout(timer); process.exit(0); }
    })();
  }
  process.on("message", (message) => rpc.receive(message));
  process.once("disconnect", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}

if (process.env.FLOW_BACKEND_WORKER === "1" || isFilesystemLauncher()) runWorker();
