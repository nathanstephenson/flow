import { randomUUID } from 'node:crypto';
import { closeSync, constants, fchmodSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
type StoredOperation = UpdateOperation & { pid?: number };

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

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/((?:token|secret|password)[=:]\s*)[^\s;,]+/gi, '$1[redacted]')
    .slice(0, 2000);
}

/** Called by the detached `flow update` helper after restoration/recovery has settled. */
export function finishWebUpdate(root: string, id: string, result: UpdateResult | undefined, error?: unknown): void {
  const current = readOperation(root);
  if (!current || current.id !== id || current.state !== 'updating') return;
  const finishedAt = new Date().toISOString();
  if (error !== undefined) {
    writeOperation(root, { ...current, state: 'failed', finishedAt, message: publicError(error) });
    return;
  }
  if (!result?.changed) {
    writeOperation(root, {
      ...current,
      state: 'failed',
      installedVersion: result?.installedVersion ?? current.previousVersion,
      finishedAt,
      message: `npm completed, but Flow remains at ${result?.installedVersion ?? current.previousVersion}. No update was installed.`,
    });
    return;
  }
  writeOperation(root, {
    ...current,
    state: 'succeeded',
    installedVersion: result.installedVersion,
    finishedAt,
    message: `Flow updated from ${result.previousVersion} to ${result.installedVersion}.`,
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
    try {
      const existing = this.operation(this.installedVersion());
      if (existing?.state === 'updating') throw new UpdateRefusal('An update is already in progress.');
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
        startedAt: new Date().toISOString(),
        message: 'Starting the guarded npm update.',
      };
      writeOperation(this.options.root, operation);
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
      if (!child.pid) throw new Error('The update helper did not start');
      const current = readOperation(this.options.root);
      // A fast refusal can finish before the parent observes `spawn`; never overwrite that durable
      // failure with an older "updating" snapshot merely to add the helper pid.
      if (current?.id === id && current.state === 'updating') writeOperation(this.options.root, { ...current, pid: child.pid });
      return await this.status(false);
    } catch (error) {
      const operation = readOperation(this.options.root);
      if (operation?.state === 'updating' && operation.pid === undefined) {
        writeOperation(this.options.root, { ...operation, state: 'failed', finishedAt: new Date().toISOString(), message: publicError(error) });
      }
      throw error;
    } finally { this.launching = false; }
  }

  private installedVersion(): string {
    try { return this.options.installation ? inspectUpdateInstallation(this.options.installation).version : this.options.installedVersion; }
    catch { return this.options.installedVersion; }
  }

  private eligibility(): UpdateEligibility {
    if (this.options.mode !== 'background') {
      return { state: 'unsupported', reason: 'Web updates require a background Session Host. Start Flow with `flow serve start`.' };
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
    const stored = readOperation(this.options.root);
    if (!stored) return undefined;
    if (stored.state === 'updating' && stored.pid !== undefined && !processAlive(stored.pid)) {
      const failed: StoredOperation = {
        ...stored,
        state: 'unverified',
        finishedAt: new Date().toISOString(),
        message: 'The update helper stopped before it reported a verified result. Reconnect to the Session Host; if it remains unavailable, repair the installation manually with npm.',
      };
      writeOperation(this.options.root, failed);
      return failed;
    }
    if (stored.state === 'succeeded' && stored.installedVersion !== installedVersion) {
      return {
        ...stored,
        state: 'unverified',
        message: `The update reported ${stored.installedVersion}, but the running Session Host is ${installedVersion}. Restart or repair Flow manually.`,
      };
    }
    const { pid: _pid, ...operation } = stored;
    return operation;
  }
}
