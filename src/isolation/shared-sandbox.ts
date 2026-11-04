import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createSandbox, sandboxUnavailable, type Sandbox, type SandboxMount, type SandboxProvider } from "./sandbox.ts";

/** The fixed folder for Workflow builder Scopes and temporary sandbox state, so that one mount covers them. */
export function workflowBuilderFolder(): string {
  const path = join(tmpdir(), "flow-workflow-builders");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  return realpathSync(path);
}

/** One VM for all sandbox sessions of a Session Host. sbx cannot add mounts after create, so it mounts fixed roots. */
export class SharedSandbox {
  private vm: { sandbox: Sandbox; mounts: SandboxMount[] } | undefined;
  private holds = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly stateRoot: string;
  private readonly projectRoot: () => string | undefined;
  constructor(stateRoot: string, projectRoot: () => string | undefined) { this.stateRoot = stateRoot; this.projectRoot = projectRoot; }

  /** Project Root, Worktrees folder and builder folder hold shared Scopes; the sessions folder holds session state. */
  roots(): string[] {
    const projectRoot = this.projectRoot();
    if (!projectRoot) throw new Error(`${sandboxUnavailable().message}: a shared sandbox needs a Project Root`);
    const worktrees = join(this.stateRoot, "worktrees"), sessions = join(this.stateRoot, "sessions");
    for (const path of [worktrees, sessions]) mkdirSync(path, { recursive: true });
    return [realpathSync(projectRoot), realpathSync(worktrees), workflowBuilderFolder(), realpathSync(sessions)];
  }

  /** Single-flight: creates the VM when none fits the mounts and no session holds it. */
  acquire(provider: SandboxProvider, workspace: string, mounts: SandboxMount[], signal?: AbortSignal) {
    const next = this.queue.then(() => this.take(provider, workspace, mounts, signal));
    this.queue = next.catch(() => {});
    return next;
  }

  private async take(provider: SandboxProvider, workspace: string, mounts: SandboxMount[], signal?: AbortSignal) {
    let startup = { remove: 0, create: 0 };
    const missing = mounts.filter((mount) => !this.vm?.mounts.some((vm) =>
      (mount.path === vm.path || mount.path.startsWith(vm.path + sep)) && (mount.readOnly || !vm.readOnly)));
    if (this.vm && missing.length) {
      if (this.holds) throw new Error(`${sandboxUnavailable().message}: the shared sandbox is in use and does not mount ${missing.map((mount) => mount.path).join(", ")}`);
      await this.vm.sandbox.close();
      this.vm = undefined;
    }
    if (!this.vm) {
      const folder = join(this.stateRoot, "sandbox");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const name = `flow-shared-${createHash("sha256").update(this.stateRoot).digest("hex").slice(0, 16)}`;
      const sandbox = await createSandbox(provider, { name, workspace, mounts, env: {} }, join(folder, "shared.json"), signal);
      this.vm = { sandbox, mounts };
      startup = sandbox.startup;
    }
    const hold = this.vm.sandbox.hold();
    this.holds++;
    let released = false;
    return { sandbox: this.vm.sandbox, startup, release: () => { if (!released) { released = true; this.holds--; hold(); } } };
  }

  /** Removes the VM when the Session Host stops, after every hold is released. */
  async close(): Promise<void> {
    await this.queue;
    await this.vm?.sandbox.close();
  }
}
