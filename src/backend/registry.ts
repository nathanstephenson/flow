import { WorkerBackend } from "./worker/index.ts";
import { FakeBackend } from "./fake/index.ts";
import type { SessionHost } from "../daemon/host.ts";

export function registerBackends(host: SessionHost): void {
  const stateRoot = host.filesystemStateRoot();
  const policy = stateRoot ? { stateRoot } : {};
  host.registerBackend(new WorkerBackend({ backend: "claude", ...policy }));
  host.registerBackend(new WorkerBackend({ backend: "pi", ...policy }));
  host.registerBackend(new FakeBackend());
}
