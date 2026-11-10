import { WorkerRpc } from "../../src/backend/worker/rpc.ts";
import { encodeFrame, frameDecoder } from "../../src/backend/worker/frames.ts";

const rpc = new WorkerRpc(message => { process.stdout.write(encodeFrame(message)); }, async (method, args) => {
  if (method === "create") {
    const metadata = args[0] as Record<string, unknown>;
    rpc.notify("event", { event: { type: "message", id: "metadata", text: JSON.stringify({
      sessionToolsEnabled: metadata.sessionToolsEnabled, sessionToolsPresent: "sessionTools" in metadata,
    }), final: true } });
    return { capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
      resume: undefined, methods: [] };
  }
  if (method === "prompt") {
    const request = JSON.parse(args[0] as string) as { method: string; input: unknown };
    const result = await rpc.call(request.method, [request.input]);
    rpc.notify("event", { event: { type: "message", id: "result", text: JSON.stringify(result), final: true } });
  }
  if (method === "dispose") setImmediate(() => process.stdout.end(() => process.exit(0)));
}, () => {});
process.stdin.on("data", frameDecoder(message => rpc.receive(message)));
