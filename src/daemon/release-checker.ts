import type { UpdateChannel } from '../protocol/update.ts';

const packageName = '@nathanstephenson/flow';

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BETA = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-beta\.(0|[1-9]\d*)$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parsed(version: string): { core: [number, number, number]; prerelease: string[] } | undefined {
  const match = SEMVER.exec(version);
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : undefined;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : undefined;
  if (leftNumber !== undefined && rightNumber !== undefined) return Math.sign(leftNumber - rightNumber);
  if (leftNumber !== undefined) return -1;
  if (rightNumber !== undefined) return 1;
  return left.localeCompare(right);
}

export function compareVersions(left: string, right: string): number {
  const a = parsed(left), b = parsed(right);
  if (!a || !b) throw new Error('Invalid semantic version');
  for (let index = 0; index < 3; index += 1) {
    const difference = a.core[index]! - b.core[index]!;
    if (difference) return Math.sign(difference);
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const av = a.prerelease[index], bv = b.prerelease[index];
    if (av === undefined) return -1;
    if (bv === undefined) return 1;
    const difference = compareIdentifiers(av, bv);
    if (difference) return difference;
  }
  return 0;
}

/** The same exact-version policy applies to discovery and persisted update requests. */
export function isReleaseVersion(version: string): boolean {
  return STABLE.test(version) || BETA.test(version);
}

/** A release must be stable or `X.Y.Z-beta.N`, and must advance rather than downgrade. */
export function newerReleaseVersion(installed: string, candidate: string): boolean {
  return isReleaseVersion(candidate) && compareVersions(candidate, installed) > 0;
}

export type ReleaseCheck =
  | { checkedAt: string; latestVersion: string }
  | { checkedAt: string; error: string };

type ReleaseCheckerOptions = {
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  registryUrl?: string;
};

export class ReleaseChecker {
  private readonly cached = new Map<UpdateChannel, { at: number; result: ReleaseCheck }>();
  private readonly inFlight = new Map<UpdateChannel, Promise<ReleaseCheck>>();
  private readonly options: ReleaseCheckerOptions;

  constructor(options: ReleaseCheckerOptions = {}) { this.options = options; }

  check(refresh = false, channel: UpdateChannel = 'stable'): Promise<ReleaseCheck> {
    const now = (this.options.now ?? Date.now)();
    const cacheMs = this.options.cacheMs ?? 15 * 60 * 1000;
    const cached = this.cached.get(channel);
    if (!refresh && cached && now - cached.at < cacheMs) return Promise.resolve(cached.result);
    const running = this.inFlight.get(channel);
    if (running) return running;
    const pending = this.fetchChannel(channel).then(result => {
      this.cached.set(channel, { at: (this.options.now ?? Date.now)(), result });
      return result;
    }).finally(() => { this.inFlight.delete(channel); });
    this.inFlight.set(channel, pending);
    return pending;
  }

  private async fetchChannel(channel: UpdateChannel): Promise<ReleaseCheck> {
    const checkedAt = new Date((this.options.now ?? Date.now)()).toISOString();
    try {
      const latest = await this.fetchTag('latest') ?? '';
      if (!STABLE.test(latest)) throw new Error('npm latest tag is not a stable semantic version');
      if (channel === 'stable') return { checkedAt, latestVersion: latest };
      const beta = await this.fetchTag('beta');
      if (beta === undefined) return { checkedAt, latestVersion: latest };
      if (!BETA.test(beta)) throw new Error('npm beta tag is not an X.Y.Z-beta.N version');
      return { checkedAt, latestVersion: compareVersions(beta, latest) > 0 ? beta : latest };
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError'
        ? 'The npm registry check timed out. Try again.'
        : `Could not check the npm registry: ${error instanceof Error ? error.message : String(error)}`;
      return { checkedAt, error: message };
    }
  }

  private async fetchTag(tag: 'latest' | 'beta'): Promise<string | undefined> {
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.registryUrl ?? `https://registry.npmjs.org/${packageName.replace('/', '%2F')}`}/${tag}`,
      {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
      },
    );
    if (tag === 'beta' && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`npm registry answered ${response.status}`);
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 64 * 1024) throw new Error('npm registry response was too large');
    const text = await response.text();
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error('npm registry response was too large');
    const body: unknown = JSON.parse(text);
    const version = body && typeof body === 'object' && 'version' in body ? (body as { version?: unknown }).version : undefined;
    return typeof version === 'string' ? version : '';
  }
}
