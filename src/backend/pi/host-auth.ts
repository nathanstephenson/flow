import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Api, AuthResult, CredentialStore, Model, OAuthCredential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { waitForAbort } from "../worker/rpc.ts";
import type { PiModelAuth, PiProviderAuth } from "./model-auth.ts";
import { projectPi099RadiusCatalog, projectPiStoredRadiusCatalog, registerPiNativeProvider } from "./model-catalog.ts";
import { parsePiModelConfig } from "./model-config.ts";
import { PiCanonicalJson } from "./canonical-json.ts";

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
    try { raw = parsePiModelConfig(readFileSync(fd, "utf8")); }
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

class CanonicalCatalogs extends PiCanonicalJson {
  constructor(path: string) { super(path, "models-store.json"); }

  async importLegacy(providerId: string, models: readonly Model<Api>[], signal?: AbortSignal): Promise<void> {
    await this.locked((raw, assertLock) => {
      if (Object.hasOwn(raw, providerId)) {
        if (!object(raw[providerId]) || !Array.isArray(raw[providerId].models)) throw new Error("Invalid Pi models-store.json: expected a catalog");
        return;
      }
      assertLock();
      this.writeRaw({ ...raw, [providerId]: { models, checkedAt: Date.now() } });
      assertLock();
    }, signal, true);
  }
}

class CanonicalCredentials extends PiCanonicalJson implements CredentialStore {
  private readonly catalogs: CanonicalCatalogs;
  constructor(authPath: string, catalogs: CanonicalCatalogs) { super(authPath, "auth.json"); this.catalogs = catalogs; }

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
      const legacy = projectPi099RadiusCatalog(providerId, current.gatewayConfig);
      if (legacy) await this.catalogs.importLegacy(providerId, legacy, options?.signal);
      assertLock();
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
  const catalogs = new CanonicalCatalogs(join(dirname(authPath), "models-store.json"));
  const store = new CanonicalCredentials(authPath, catalogs);
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
        const entries = metadata(raw, radiusGateways(modelsPath));
        const radius = entries.filter(entry => entry.check && (entry.providerId === "radius" || entry.radiusGateway !== undefined || entry.cachedModels !== undefined));
        if (radius.length) {
          const stored = await catalogs.raw(signal);
          signal?.throwIfAborted();
          for (const entry of radius) {
            const models = projectPiStoredRadiusCatalog(entry.providerId, stored[entry.providerId]);
            if (models) entry.cachedModels = models;
          }
        }
        return entries;
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
