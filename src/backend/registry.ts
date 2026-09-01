import type { AgentBackend, BackendCreateOptions, BackendSession } from "./types.ts";
import { ClaudeBackend } from "./claude/index.ts";
import { FakeBackend } from "./fake/index.ts";
import type { SessionHost } from "../daemon/host.ts";

/**
 * A Backend Adapter whose module is only loaded when a session actually uses it.
 *
 * pi is ESM-only and pulls in native and wasm packages, so a bundled build cannot require it at
 * startup. Loading it on demand keeps it optional: the binary runs without it, and asking for a pi
 * session when it is missing fails with something a person can act on.
 */
class LazyBackend implements AgentBackend {
  readonly name: string;

  private readonly load: () => Promise<AgentBackend>;
  private loaded: AgentBackend | undefined;

  constructor(name: string, load: () => Promise<AgentBackend>) {
    this.name = name;
    this.load = load;
  }

  async create(options: BackendCreateOptions): Promise<BackendSession> {
    if (!this.loaded) {
      try {
        this.loaded = await this.load();
      } catch (error) {
        throw new Error(
          `Backend "${this.name}" is not available in this build: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return this.loaded.create(options);
  }
}

export function registerBackends(host: SessionHost): void {
  host.registerBackend(new ClaudeBackend());
  host.registerBackend(
    new LazyBackend("pi", async () => new (await import("./pi/index.ts")).PiBackend()),
  );
  host.registerBackend(new FakeBackend());
}
