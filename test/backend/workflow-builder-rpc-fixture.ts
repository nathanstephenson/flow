import { WorkerRpc } from "../../src/backend/worker/rpc.ts";

const rpc = new WorkerRpc(message => process.send!(message), async (method, args) => {
  if (method === "create") {
    const errors: string[] = [];
    for (const name of ["mcp.call", "workflow.inspect", "workflow.recover", "workflow.relayEnquiry", "workflow.relayPermission", "constructor"]) {
      try { await rpc.call(name, ["external", {}]); errors.push("unexpected success"); }
      catch (error) { errors.push(String(error)); }
    }
    for (const name of ["workflowBuilder.read", "workflowBuilder.list", "workflowBuilder.write"]) {
      try { await rpc.call(name, [{}]); errors.push("unexpected success"); }
      catch (error) { errors.push(String(error)); }
    }
    rpc.notify("event", { event: { type: "message", id: "rpc", text: JSON.stringify(errors), final: true } });
    return { capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
      resume: undefined, methods: [] };
  }
  if (method === "dispose") setImmediate(() => { process.disconnect(); process.exit(0); });
}, () => {});
process.on("message", message => rpc.receive(message));
