const packageName = '@nathanstephenson/flow';

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
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

/** `latest` must itself be stable, and must advance rather than select a channel or downgrade. */
export function newerStableVersion(installed: string, latest: string): boolean {
  return STABLE.test(latest) && compareVersions(latest, installed) > 0;
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
  private cached: { at: number; result: ReleaseCheck } | undefined;
  private inFlight: Promise<ReleaseCheck> | undefined;
  private readonly options: ReleaseCheckerOptions;

  constructor(options: ReleaseCheckerOptions = {}) { this.options = options; }

  check(refresh = false): Promise<ReleaseCheck> {
    const now = (this.options.now ?? Date.now)();
    const cacheMs = this.options.cacheMs ?? 15 * 60 * 1000;
    if (!refresh && this.cached && now - this.cached.at < cacheMs) return Promise.resolve(this.cached.result);
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchLatest().then(result => {
      this.cached = { at: (this.options.now ?? Date.now)(), result };
      return result;
    }).finally(() => { this.inFlight = undefined; });
    return this.inFlight;
  }

  private async fetchLatest(): Promise<ReleaseCheck> {
    const checkedAt = new Date((this.options.now ?? Date.now)()).toISOString();
    try {
      const response = await (this.options.fetch ?? fetch)(
        this.options.registryUrl ?? `https://registry.npmjs.org/${packageName.replace('/', '%2F')}/latest`,
        {
          headers: { accept: 'application/json' },
          signal: AbortSignal.timeout(this.options.timeoutMs ?? 5000),
        },
      );
      if (!response.ok) throw new Error(`npm registry answered ${response.status}`);
      const length = Number(response.headers.get('content-length'));
      if (Number.isFinite(length) && length > 64 * 1024) throw new Error('npm registry response was too large');
      const text = await response.text();
      if (Buffer.byteLength(text) > 64 * 1024) throw new Error('npm registry response was too large');
      const body: unknown = JSON.parse(text);
      const latestVersion = body && typeof body === 'object' && 'version' in body
        ? (body as { version?: unknown }).version
        : undefined;
      if (typeof latestVersion !== 'string' || !STABLE.test(latestVersion)) {
        throw new Error('npm latest tag is not a stable semantic version');
      }
      return { checkedAt, latestVersion };
    } catch (error) {
      const message = error instanceof Error && error.name === 'TimeoutError'
        ? 'The npm registry check timed out. Try again.'
        : `Could not check the npm registry: ${error instanceof Error ? error.message : String(error)}`;
      return { checkedAt, error: message };
    }
  }
}
