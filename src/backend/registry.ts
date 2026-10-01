import { WorkerBackend } from "./worker/index.ts";
import { ClaudeBackend } from "./claude/index.ts";
import { FakeBackend } from "./fake/index.ts";
import type { SessionHost } from "../daemon/host.ts";

export function registerBackends(host: SessionHost): void {
  host.registerBackend(new ClaudeBackend());
  host.registerBackend(new WorkerBackend());
  host.registerBackend(new FakeBackend());
}
