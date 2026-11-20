import { constants, closeSync, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AuthResult, CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { waitForAbort } from "../worker/rpc.ts";
import type { PiModelAuth, PiProviderAuth } from "./model-auth.ts";
import { projectPi099RadiusCatalog, registerPiNativeProvider } from "./model-catalog.ts";

type RawCredentials = Record<string, unknown>;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oauth(value: unknown): value is OAuthCredential {
  return object(value) && value.type === "oauth" && typeof value.access === "string"
    && typeof value.refresh === "string" && typeof value.expires === "number" && Number.isFinite(value.expires);
}

function stringMap(value: unknown): value is Record<string, string> {
  return object(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function radiusGateways(modelsPath: string): Map<string, string> {
  let fd: number;
  try {
    if (!lstatSync(modelsPath).isFile()) throw new Error();
    fd = openSync(modelsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw new Error("Pi models.json must be a readable regular file, not a symbolic link");
  }
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Pi models.json must be a regular file");
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(fd, "utf8").replace(/^\uFEFF/, "")); }
    catch { throw new Error("Invalid Pi models.json: expected valid JSON"); }
    if (!object(raw)) throw new Error("Invalid Pi models.json: expected an object");
    const gateways = new Map<string, string>();
    if (!object(raw.providers)) return gateways;
    for (const [id, config] of Object.entries(raw.providers)) {
      if (!object(config) || config.oauth !== "radius") continue;
      if (!id.trim() || typeof config.baseUrl !== "string") throw new Error("Invalid Pi models.json: native Radius requires a gateway URL");
      const base = config.baseUrl.replace(/\/v1\/?$/u, "");
      const gateway = (/^https?:\/\//iu.test(base) ? base : `https://${base}`).replace(/\/+$/u, "");
      try {
        const url = new URL(gateway);
        if ((!/^https?:\/\//iu.test(base) && base.includes('://'))
          || !['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash
          || /[\s\\!${}\u0000-\u001f\u007f]/u.test(gateway)) throw new Error();
      } catch { throw new Error("Invalid Pi models.json: native Radius requires a safe gateway URL"); }
      gateways.set(id, gateway);
    }
    return gateways;
  } finally { closeSync(fd); }
}

function metadata(raw: RawCredentials, gateways = new Map<string, string>()): PiProviderAuth[] {
  const entries = Object.entries(raw).flatMap<PiProviderAuth>(([providerId, credential]) => {
    if (!object(credential)) return [];
    if (oauth(credential)) {
      const ids = credential.availableModelIds;
      const cachedModels = projectPi099RadiusCatalog(providerId, credential.gatewayConfig);
      return [{ providerId, check: { type: "oauth" as const, source: "OAuth" },
        ...(Array.isArray(ids) && ids.every((id) => typeof id === "string") ? { availableModelIds: [...ids] } : {}),
        ...(cachedModels ? { cachedModels } : {}),
      }];
    }
    if (credential.type === "api_key" && (credential.key === undefined || typeof credential.key === "string")
      && (credential.env === undefined || stringMap(credential.env))) {
      return [{ providerId, check: { type: "api_key" as const, source: "stored credential" } }];
    }
    return [];
  });
  for (const [providerId, radiusGateway] of gateways) {
    if (providerId === "radius" && radiusGateway === "https://radius.pi.dev") continue;
    const entry = entries.find(entry => entry.providerId === providerId);
    if (entry) entry.radiusGateway = radiusGateway;
    else entries.push({ providerId, radiusGateway });
  }
  return entries;
}

class CanonicalCredentials implements CredentialStore {
  private readonly authPath: string;
  constructor(authPath: string) { this.authPath = authPath; }

  private exists(): boolean {
    try {
      if (!lstatSync(this.authPath).isFile()) throw new Error("Pi auth.json must be a regular file, not a symbolic link");
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  private open(flags: number): number {
    this.exists();
    const fd = openSync(this.authPath, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      throw new Error("Pi auth.json must be a regular file");
    }
    return fd;
  }

  private readRaw(): RawCredentials {
    if (!this.exists()) return {};
    const fd = this.open(constants.O_RDONLY);
    try {
      let raw: unknown;
      try { raw = JSON.parse(readFileSync(fd, "utf8").replace(/^\uFEFF/, "")); }
      catch { throw new Error("Invalid Pi auth.json: expected valid JSON"); }
      if (!object(raw)) throw new Error("Invalid Pi auth.json: expected an object");
      return raw;
    } finally { closeSync(fd); }
  }

  private writeRaw(raw: RawCredentials): void {
    const fd = this.open(constants.O_WRONLY);
    try {
      ftruncateSync(fd, 0);
      writeFileSync(fd, JSON.stringify(raw, null, 2), { encoding: "utf8", mode: 0o600 });
    } finally { closeSync(fd); }
  }

  private async locked<T>(fn: (raw: RawCredentials, assertLock: () => void) => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!this.exists()) return fn({}, () => {});
    const deadline = Date.now() + 30_000;
    let compromised: Error | undefined;
    let release: (() => Promise<void>) | undefined;
    const assertLock = () => { if (compromised) throw compromised; };
    for (let attempt = 0; !release; attempt++) {
      signal?.throwIfAborted();
      try {
        release = await lockfile.lock(this.authPath, {
          realpath: false, stale: 30_000, retries: 0,
          onCompromised: (error) => { compromised = error; },
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
        await sleep(Math.min(10 * 2 ** Math.min(attempt, 7), 1000, deadline - Date.now()), undefined, signal ? { signal } : {});
      }
    }
    try {
      assertLock();
      signal?.throwIfAborted();
      return await fn(this.readRaw(), assertLock);
    } finally {
      try { await release(); } catch (error) { if (!compromised) throw error; }
    }
  }

  raw(signal?: AbortSignal): Promise<RawCredentials> {
    return this.locked((raw) => raw, signal);
  }

  async read(providerId: string, options?: { signal?: AbortSignal }): Promise<OAuthCredential | undefined> {
    const raw = await this.raw(options?.signal);
    const credential = Object.hasOwn(raw, providerId) ? raw[providerId] : undefined;
    return oauth(credential) ? structuredClone(credential) : undefined;
  }

  async list(options?: { signal?: AbortSignal }) {
    return metadata(await this.raw(options?.signal)).map(({ providerId, check }) => ({ providerId, type: check!.type }));
  }

  async modify(providerId: string, fn: Parameters<CredentialStore["modify"]>[1], options?: { signal?: AbortSignal }) {
    return this.locked(async (raw, assertLock) => {
      const current = Object.hasOwn(raw, providerId) ? raw[providerId] : undefined;
      if (!oauth(current)) return undefined;
      const next = await fn(structuredClone(current));
      assertLock();
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        if (!oauth(next)) throw new Error("Pi host can only persist OAuth credentials");
        raw[providerId] = next;
        this.writeRaw(raw);
        assertLock();
      }
      return next ?? current;
    }, options?.signal);
  }

  async delete(): Promise<never> {
    throw new Error("Pi host credential deletion is not supported");
  }
}

export function createPiModelAuth(options: { authPath?: string } = {}): PiModelAuth {
  const path = options.authPath ?? join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi/agent'), 'auth.json');
  const authPath = resolve(/^~[\\/\\\\]/.test(path) ? join(homedir(), path.slice(2)) : path);
  const store = new CanonicalCredentials(authPath);
  const modelsPath = join(dirname(authPath), "models.json");
  const registeredGateways = new Map<string, string>();
  let runtime: Promise<ModelRuntime> | undefined;
  const pending = new Map<string, Promise<AuthResult | undefined>>();
  const admitted = new Set<Promise<unknown>>();
  let closing: Promise<void> | undefined;
  let closed = false;
  function admit<T>(operation: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new Error("Pi model auth is closed"));
    const result = Promise.resolve().then(operation);
    admitted.add(result);
    void result.then(() => admitted.delete(result), () => admitted.delete(result));
    return result;
  }
  return {
    close() {
      closed = true;
      closing ??= (async () => {
        await Promise.allSettled([...admitted]);
        await Promise.allSettled([...pending.values()]);
      })();
      return closing;
    },
    snapshot(signal) {
      return admit(async () => {
        const raw = await store.raw(signal);
        signal?.throwIfAborted();
        return metadata(raw, radiusGateways(modelsPath));
      });
    },
    resolve(providerId, signal) {
      return admit(async () => {
        signal?.throwIfAborted();
        if (typeof providerId !== "string" || !providerId) throw new Error("Unknown Pi provider");
        const raw = await store.raw(signal);
        signal?.throwIfAborted();
        if (!metadata(raw).some((entry) => entry.providerId === providerId)) throw new Error("Unknown Pi provider");
        const gateways = radiusGateways(modelsPath);
        const credential = raw[providerId];
        if (object(credential) && credential.type === "api_key") {
          if (typeof credential.key === "string" && credential.key.startsWith("!")) {
            throw new Error("Pi host refuses !command credentials in auth.json. Move the command to models.json so it runs only in the worker.");
          }
          return { auth: { ...(typeof credential.key === "string" ? { apiKey: credential.key } : {}) },
            ...(stringMap(credential.env) ? { env: { ...credential.env } } : {}), source: "stored credential" };
        }
        runtime ??= import('@earendil-works/pi-coding-agent').then(({ ModelRuntime }) =>
          ModelRuntime.create({ credentials: store, modelsPath: null, refreshOnCreate: false }));
        const current = await waitForAbort(runtime, signal);
        signal?.throwIfAborted();
        const gateway = gateways.get(providerId);
        if (gateway !== undefined || (providerId === "radius" && registeredGateways.has(providerId))) {
          const signature = gateway ?? "https://radius.pi.dev";
          if (registeredGateways.get(providerId) !== signature) {
            const { radiusProvider } = await import('@earendil-works/pi-ai/providers/all');
            signal?.throwIfAborted();
            if (registeredGateways.get(providerId) !== signature) {
              registerPiNativeProvider(current, radiusProvider({ id: providerId, gateway: signature }));
              registeredGateways.set(providerId, signature);
            }
          }
        } else if (registeredGateways.has(providerId)) {
          throw new Error(`Pi provider ${providerId} does not support native OAuth`);
        }
        const provider = current.getProvider(providerId);
        if (!provider?.auth.oauth) throw new Error(`Pi provider ${providerId} does not support native OAuth`);
        delete provider.auth.apiKey;
        let operation = pending.get(providerId);
        if (!operation) {
          operation = current.getAuth(providerId).then((result) => result ? {
            auth: {
              ...(result.auth.apiKey !== undefined ? { apiKey: result.auth.apiKey } : {}),
              ...(result.auth.headers ? { headers: result.auth.headers } : {}),
              ...(result.auth.baseUrl !== undefined ? { baseUrl: result.auth.baseUrl } : {}),
            },
            ...(result.env ? { env: result.env } : {}),
            ...(result.source !== undefined ? { source: result.source } : {}),
          } : undefined);
          pending.set(providerId, operation);
          const owned = operation;
          void operation.then(() => { if (pending.get(providerId) === owned) pending.delete(providerId); },
            () => { if (pending.get(providerId) === owned) pending.delete(providerId); });
        }
        return waitForAbort(operation, signal);
      });
    },
  };
}
