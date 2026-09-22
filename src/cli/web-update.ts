import { systemdUpdate, launchSystemdUpdate, SystemdLaunchUncertain } from './systemd-update.ts';
import { randomUUID } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import type { WebUpdateStatus, UpdateOperation, UpdateEligibility } from '../protocol/update.ts';
import { newerStableVersion, ReleaseChecker } from '../daemon/release-checker.ts';
import { UpdateRefusal } from '../daemon/update-api.ts';
export { UpdateRefusal } from '../daemon/update-api.ts';
import { processAlive } from './host-control.ts';
import { inspectUpdateInstallation, type UpdateResult } from './update.ts';
import type { Installation } from './install-guard.ts';

const STATUS_FILE = 'web-update.json';
const STATUS_LOCK = 'web-update-lock';
const STATUS_LOCK_ATTEMPTS = 100;
const STATUS_LOCK_WAIT_MS = 25;
export const WEB_UPDATE_LAUNCH_WINDOW_MS = 15_000;
type StoredOperation = UpdateOperation & { pid?: number; launcherPid?: number };
type LockOwner = { pid: number; id: string };

function statusPath(root: string): string { return join(root, STATUS_FILE); }

function readOperation(root: string): StoredOperation | undefined {
  try {
    const value = JSON.parse(readFileSync(statusPath(root), 'utf8')) as StoredOperation;
    if (!value || typeof value.id !== 'string' || !['updating', 'succeeded', 'failed', 'unverified'].includes(value.state)) return undefined;
    return value;
  } catch { return undefined; }
}

function writeOperation(root: string, operation: StoredOperation): void {
  const temporary = join(root, `${STATUS_FILE}-${process.pid}-${randomUUID()}`);
  writeFileSync(temporary, JSON.stringify(operation), { mode: 0o600 });
  renameSync(temporary, statusPath(root));
}

function removeLockOwner(path: string, filename: string): void {
  try { unlinkSync(join(path, filename)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { rmdirSync(path); }
  catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** Serialize cross-process status transitions so reconciliation cannot replace a helper's result. */
function transitionOperation(root: string, transition: (current: StoredOperation | undefined) => StoredOperation | undefined): StoredOperation | undefined {
  const ownerId = randomUUID();
  const filename = `${ownerId}.json`;
  const candidate = join(root, `${STATUS_LOCK}-${ownerId}`);
  const lock = join(root, STATUS_LOCK);
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, filename), JSON.stringify({ pid: process.pid, id: ownerId }), { mode: 0o600 });
  let acquired = false;
  try {
    for (let attempt = 0; !acquired; attempt++) {
      try { renameSync(candidate, lock); acquired = true; }
      catch (error) {
        if (!['ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        if (attempt >= STATUS_LOCK_ATTEMPTS) throw new Error('Web update status is busy');
        let entries: string[];
        try { entries = readdirSync(lock); }
        catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        if (entries.length === 0) { sleep(STATUS_LOCK_WAIT_MS); continue; }
        if (entries.length !== 1 || !/^[a-f0-9-]+\.json$/.test(entries[0]!)) throw new Error('Invalid web update status owner');
        let owner: LockOwner;
        try { owner = JSON.parse(readFileSync(join(lock, entries[0]!), 'utf8')) as LockOwner; }
        catch (readError) {
          if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw readError;
        }
        if (!owner || typeof owner !== 'object' || !Number.isInteger(owner.pid) || owner.pid <= 0 || owner.id !== entries[0]!.slice(0, -5)) {
          throw new Error('Invalid web update status owner');
        }
        if (!processAlive(owner.pid)) removeLockOwner(lock, entries[0]!);
        sleep(STATUS_LOCK_WAIT_MS);
      }
    }
    const current = readOperation(root);
    const next = transition(current);
    if (next !== undefined && next !== current) writeOperation(root, next);
    return next;
  } finally { removeLockOwner(acquired ? lock : candidate, filename); }
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:token|secret|password)[=:]\s*)[^\s;,]+/gi, '$1[redacted]')
    .slice(0, 2000);
}

export function claimWebUpdate(root: string, id: string): void {
  transitionOperation(root, current => current?.id === id && ['updating', 'unverified'].includes(current.state)
    ? { ...current, state: 'updating', pid: process.pid } : current);
}

/** Called by the detached `flow update` helper after restoration/recovery has settled. */
export function finishWebUpdate(root: string, id: string, result: UpdateResult | undefined, error?: unknown): void {
  transitionOperation(root, current => {
    // A replacement host may have reconciled the launch to unverified when the old host exited before
    // recording the helper PID. The ID still binds this completion to the authorized detached helper,
    // so its eventual verified result may safely replace that provisional recovery-needed state.
    if (!current || current.id !== id || !['updating', 'unverified'].includes(current.state)) return current;
    const finishedAt = new Date().toISOString();
    if (error !== undefined) return { ...current, state: 'failed', finishedAt, message: publicError(error) };
    if (!result?.changed) {
      return {
        ...current,
        state: 'failed',
        installedVersion: result?.installedVersion ?? current.previousVersion,
        finishedAt,
        message: `npm completed, but Flow remains at ${result?.installedVersion ?? current.previousVersion}. No update was installed.`,
      };
    }
    return {
      ...current,
      state: 'succeeded',
      installedVersion: result.installedVersion,
      finishedAt,
      message: `Flow updated from ${result.previousVersion} to ${result.installedVersion}.`,
    };
  });
}

/**
 * The authenticated web surface can start exactly one fixed command: this installation's guarded
 * `flow update`. It cannot name a package, version, prefix, command, or force flag.
 */
type WebUpdateControllerOptions = {
  root: string;
  installedVersion: string;
  mode: 'foreground' | 'background' | 'embedded';
  installation?: Installation;
  bootstrapEntry?: string;
  unsupportedReason?: string;
  hasActiveWork(): boolean;
  checker?: ReleaseChecker;
  now?: () => number;
};

export class WebUpdateController {
  private launching = false;
  private readonly options: WebUpdateControllerOptions;
  private readonly checker: ReleaseChecker;

  constructor(options: WebUpdateControllerOptions) {
    this.options = options;
    const registryUrl = process.env.FLOW_UPDATE_REGISTRY_URL;
    this.checker = options.checker ?? new ReleaseChecker(registryUrl ? { registryUrl } : {});
  }

  async status(refresh = false): Promise<WebUpdateStatus> {
    const installedVersion = this.installedVersion();
    const check = await this.checker.check(refresh);
    const operation = this.operation(installedVersion);
    return {
      installedVersion,
      updateAvailable: 'latestVersion' in check && newerStableVersion(installedVersion, check.latestVersion),
      ...('latestVersion' in check ? { latestVersion: check.latestVersion } : { checkError: check.error }),
      checkedAt: check.checkedAt,
      eligibility: this.eligibility(),
      ...(operation === undefined ? {} : { operation }),
    };
  }

  async start(confirmedVersion: string): Promise<WebUpdateStatus> {
    if (this.launching) throw new UpdateRefusal('An update request is already starting.');
    this.launching = true;
    let launchedOperationId: string | undefined;
    let helperStarted = false;
    try {
      const initiallyInstalledVersion = this.installedVersion();
      this.refuseUnsettledOperation(this.operation(initiallyInstalledVersion), initiallyInstalledVersion);
      const eligibility = this.eligibility();
      if (eligibility.state !== 'eligible') throw new UpdateRefusal(eligibility.reason);
      const installedVersion = this.installedVersion();
      // Mutation never trusts the up-to-fifteen-minute discovery cache. The confirmed version must
      // still be npm's stable latest tag, and the detached helper installs that exact version.
      const release = await this.checker.check(true);
      if ('error' in release) throw new UpdateRefusal(`${release.error} Check again before updating.`);
      if (!newerStableVersion(installedVersion, release.latestVersion)) {
        throw new UpdateRefusal(`Flow ${installedVersion} is already up to date.`);
      }
      if (release.latestVersion !== confirmedVersion) {
        throw new UpdateRefusal(`The latest release changed from ${confirmedVersion} to ${release.latestVersion}. Check again and confirm the new version.`);
      }

      // Revalidate after the asynchronous release check and immediately before spawning. The helper
      // repeats installation and target checks yet again before beginning its transaction.
      const finalEligibility = this.eligibility();
      if (finalEligibility.state !== 'eligible') throw new UpdateRefusal(finalEligibility.reason);
      const installation = this.options.installation;
      const bootstrapEntry = this.options.bootstrapEntry;
      if (!installation || !bootstrapEntry) throw new UpdateRefusal('This Flow installation cannot update itself.');
      const id = randomUUID();
      const operation: StoredOperation = {
        id,
        state: 'updating',
        previousVersion: installedVersion,
        targetVersion: confirmedVersion,
        startedAt: new Date(this.now()).toISOString(),
        message: 'Starting the guarded npm update.',
        launcherPid: process.pid,
      };
      transitionOperation(this.options.root, current => {
        // Discovery is asynchronous. Recheck under the cross-process status lock so an old helper
        // cannot become provisional while this request replaces its operation ID.
        this.refuseUnsettledOperation(current, installedVersion);
        return operation;
      });
      launchedOperationId = id;
      const managed = systemdUpdate(this.options.root);
      if (managed) {
        await launchSystemdUpdate(this.options.root, managed, { id, version: confirmedVersion, force: false });
        helperStarted = true;
        return await this.status(false);
      }
      const log = openSync(join(this.options.root, 'web-update.log'), constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
      let child: ReturnType<typeof spawn>;
      try {
        fchmodSync(log, 0o600);
        child = spawn(process.execPath, [bootstrapEntry, 'update'], {
          cwd: process.cwd(),
          detached: true,
          stdio: ['ignore', log, log],
          env: {
            ...process.env,
            FLOW_STATE_DIR: this.options.root,
            FLOW_WEB_UPDATE_ID: id,
            FLOW_WEB_UPDATE_VERSION: confirmedVersion,
          },
        });
      } finally { closeSync(log); }
      await new Promise<void>((resolvePromise, reject) => {
        child.once('spawn', resolvePromise);
        child.once('error', reject);
      });
      child.unref();
      const helperPid = child.pid;
      if (!helperPid) throw new Error('The update helper did not start');
      helperStarted = true;
      // A fast refusal can finish before the parent observes `spawn`; the locked transition never
      // overwrites that durable result merely to add the helper pid.
      transitionOperation(this.options.root, current =>
        current?.id === id && current.state === 'updating' ? { ...current, pid: helperPid } : current);
      return await this.status(false);
    } catch (error) {
      if (launchedOperationId !== undefined && !helperStarted) {
        const operationId = launchedOperationId;
        transitionOperation(this.options.root, operation => {
          if (!operation || operation.id !== operationId || !['updating', 'unverified'].includes(operation.state) || operation.pid !== undefined) return operation;
          return { ...operation, state: error instanceof SystemdLaunchUncertain ? 'unverified' : 'failed', finishedAt: new Date(this.now()).toISOString(), message: publicError(error) };
        });
      }
      throw error;
    } finally { this.launching = false; }
  }

  private installedVersion(): string {
    try { return this.options.installation ? inspectUpdateInstallation(this.options.installation).version : this.options.installedVersion; }
    catch { return this.options.installedVersion; }
  }

  private eligibility(): UpdateEligibility {
    let managed;
    try { managed = systemdUpdate(this.options.root); }
    catch (error) { return { state: 'unsupported', reason: publicError(error) }; }
    if ((managed && (this.options.mode !== 'foreground' || process.env.FLOW_SYSTEMD_HOST !== '1')) ||
        (!managed && this.options.mode !== 'background')) {
      return { state: 'unsupported', reason: 'Web updates require a background Session Host or configured systemd updater. Start Flow with `flow serve start`, or follow docs/systemd-updates.md.' };
    }
    if (!this.options.installation || !this.options.bootstrapEntry) {
      return { state: 'unsupported', reason: this.options.unsupportedReason ?? 'This installation cannot update itself. Use npm to update Flow manually.' };
    }
    try { inspectUpdateInstallation(this.options.installation); }
    catch (error) { return { state: 'unsupported', reason: publicError(error) }; }
    if (this.options.hasActiveWork()) {
      return {
        state: 'blocked',
        reason: 'Finish active Agent Sessions, Workflow Executions, and Shells before updating. Then try again.',
      };
    }
    return { state: 'eligible' };
  }

  private operation(installedVersion: string): UpdateOperation | undefined {
    const observed = readOperation(this.options.root);
    if (!observed) return undefined;
    let recoveryMessage: string | undefined;
    if (observed.state === 'updating' && observed.pid !== undefined && !processAlive(observed.pid)) {
      recoveryMessage = 'The update helper stopped before it reported a verified result. Reconnect to the Session Host; if it remains unavailable, repair the installation manually with npm.';
    } else if (observed.state === 'updating' && observed.pid === undefined && this.launchWasAbandoned(observed)) {
      recoveryMessage = 'The Session Host stopped or timed out before it recorded the update helper process. Flow cannot verify whether the update started. Reconnect; if the host remains unavailable, repair the private global npm installation manually and restart it.';
    }
    const stored = recoveryMessage === undefined ? observed : transitionOperation(this.options.root, current => {
      // `processAlive` and the abandonment checks happen outside the lock. Compare the launch fields
      // again under the lock: a helper result or parent PID write that won meanwhile is authoritative.
      if (current?.id !== observed.id || current.state !== 'updating' || current.startedAt !== observed.startedAt ||
          current.pid !== observed.pid || current.launcherPid !== observed.launcherPid) return current;
      return {
        ...current,
        state: 'unverified',
        finishedAt: new Date(this.now()).toISOString(),
        message: recoveryMessage,
      };
    });
    if (!stored) return undefined;
    if (stored.state === 'succeeded' && stored.installedVersion !== installedVersion) {
      return this.publicOperation({
        ...stored,
        state: 'unverified',
        message: `The update reported ${stored.installedVersion}, but the running Session Host is ${installedVersion}. Restart or repair Flow manually.`,
      });
    }
    return this.publicOperation(stored);
  }

  private refuseUnsettledOperation(operation: UpdateOperation | undefined, installedVersion: string): void {
    if (operation?.state === 'updating') throw new UpdateRefusal('An update is already in progress.');
    if (operation?.state === 'unverified' ||
        (operation?.state === 'succeeded' && operation.installedVersion !== installedVersion)) {
      throw new UpdateRefusal('The previous update still has an unverified result. Reconnect and verify or repair the Session Host before starting another update.');
    }
  }

  private launchWasAbandoned(operation: StoredOperation): boolean {
    const startedAt = Date.parse(operation.startedAt);
    const now = this.now();
    if (!Number.isFinite(startedAt) || startedAt > now || now - startedAt >= WEB_UPDATE_LAUNCH_WINDOW_MS) return true;
    if (operation.launcherPid === undefined) return false;
    if (!Number.isInteger(operation.launcherPid) || operation.launcherPid <= 0) return true;
    return !processAlive(operation.launcherPid);
  }

  private publicOperation(stored: StoredOperation): UpdateOperation {
    const { pid: _pid, launcherPid: _launcherPid, ...operation } = stored;
    return operation;
  }

  private now(): number { return (this.options.now ?? Date.now)(); }
}
