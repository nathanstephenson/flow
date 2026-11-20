import type { Api, ApiKeyAuth, ApiKeyCredential, AuthCheck, AuthResult, CredentialStore, Model, Provider } from '@earendil-works/pi-ai';
import { registerPiNativeProvider, unregisterPiNativeProvider, withPi099RadiusCatalog } from './model-catalog.ts';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
export { createPiModelAuth } from './host-auth.ts';

export interface PiProviderAuth {
  providerId: string;
  check?: AuthCheck;
  availableModelIds?: readonly string[];
  cachedModels?: readonly Model<Api>[];
  radiusGateway?: string;
}

export interface PiModelAuth {
  close?(): Promise<void>;
  snapshot(signal?: AbortSignal): Promise<readonly PiProviderAuth[]>;
  resolve(providerId: string, signal?: AbortSignal): Promise<AuthResult | undefined>;
}

const emptyCredentials: CredentialStore = {
  async read(_providerId, options) { options?.signal?.throwIfAborted(); return undefined; },
  async list(options) { options?.signal?.throwIfAborted(); return []; },
  async modify() { throw new Error('Worker Pi credentials are read-only'); },
  async delete() { throw new Error('Worker Pi credentials are read-only'); },
};

export async function createWorkerPiModelRuntime(auth: PiModelAuth, modelsPath: string | null, signal?: AbortSignal): Promise<ModelRuntime> {
  let metadata = new Map((await auth.snapshot(signal)).map(entry => [entry.providerId, entry]));
  const storedKey = Symbol('host credential metadata');
  type StoredKey = ApiKeyCredential & { [storedKey]?: true };
  const credentials: CredentialStore = {
    ...emptyCredentials,
    async read(id, options) {
      options?.signal?.throwIfAborted();
      const entry = metadata.get(id);
      if (entry?.check?.type === 'api_key') return { type: 'api_key', [storedKey]: true };
      if (entry?.check?.type === 'oauth') return {
        type: 'oauth', access: '', refresh: '', expires: Number.MAX_SAFE_INTEGER,
        ...(entry.availableModelIds ? { availableModelIds: [...entry.availableModelIds] } : {}),
      };
      return undefined;
    },
  };
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  const { builtinProviders, radiusProvider } = await import('@earendil-works/pi-ai/providers/all');
  const runtime = await ModelRuntime.create({ credentials, modelsPath, refreshOnCreate: false, ...(signal ? { signal } : {}) });
  const refresh = runtime.refresh.bind(runtime);
  const builtins = new Map(builtinProviders().map(provider => [provider.id, provider]));
  const registered = new Set<string>();
  const registeredGateways = new Map<string, string>();

  const expandKey = async (key: string | undefined, env: ApiKeyCredential['env'], signal: AbortSignal) => {
    if (!key?.includes('$')) return key;
    const resolver = await ModelRuntime.create({ credentials: emptyCredentials, modelsPath: null, refreshOnCreate: false, signal });
    const refresh = resolver.refresh;
    resolver.refresh = async () => ({ aborted: false, errors: new Map() });
    try { resolver.registerProvider('worker-key-template', { apiKey: key }); }
    finally { resolver.refresh = refresh; }
    return (await resolver.getAuth('worker-key-template', { ...(env ? { env } : {}), signal }))?.auth.apiKey;
  };

  const genericApiKey: ApiKeyAuth = {
    name: 'API key',
    async resolve({ credential }) {
      return credential?.key ? { auth: { apiKey: credential.key }, ...(credential.env ? { env: credential.env } : {}) } : undefined;
    },
  };
  const brokered = (provider: Provider): Provider => {
    const id = provider.id;
    const apiKey = provider.auth.apiKey ?? genericApiKey;
    const oauth = provider.auth.oauth;
    return {
      ...provider,
      auth: {
        ...(apiKey ? { apiKey: {
          ...apiKey,
          async check(input) {
            input.signal.throwIfAborted();
            if ((input.credential as StoredKey | undefined)?.[storedKey]) return metadata.get(id)?.check;
            if (apiKey.check) return apiKey.check(input);
            const result = await apiKey.resolve(input);
            return result ? { type: 'api_key' as const, ...(result.source !== undefined ? { source: result.source } : {}) } : undefined;
          },
          async resolve(input) {
            if (!(input.credential as StoredKey | undefined)?.[storedKey]) return apiKey.resolve(input);
            const result = await auth.resolve(id, input.signal);
            if (!result) return undefined;
            const env = { ...result.env, ...input.credential?.env };
            const key = await expandKey(result.auth.apiKey, env, input.signal);
            return apiKey.resolve({ ...input, credential: { type: 'api_key', ...(key !== undefined ? { key } : {}), env },
              ctx: { ...input.ctx, env: async name => env[name] ?? input.ctx.env(name) } });
          },
        } } : {}),
        ...(oauth ? { oauth: {
          ...oauth,
          async toAuth() {
            const result = await auth.resolve(id);
            if (!result) throw new Error('Session Host auth is unavailable');
            return result.auth;
          },
        } } : {}),
      },
      ...(provider.refreshModels ? { async refreshModels(context) {
        if (context.allowNetwork && context.credential?.type === 'oauth') {
          const result = await auth.resolve(id, context.signal);
          if (!result) return;
          return provider.refreshModels!({ ...context, credential: {
            ...context.credential, access: result.auth.apiKey ?? '', refresh: '',
          } });
        }
        return provider.refreshModels!(context);
      } } : {}),
    };
  };

  const registerProviders = () => {
    if (!metadata.has('radius') && registered.delete('radius')) {
      unregisterPiNativeProvider(runtime, 'radius');
      registeredGateways.delete('radius');
    }
    const gateways = new Map([...metadata.values()].flatMap(entry => entry.radiusGateway !== undefined
      ? [[entry.providerId, entry.radiusGateway] as const] : []));
    const baseUrl = runtime.getProvider('radius')?.baseUrl;
    if (metadata.has('radius') && !gateways.has('radius') && (!baseUrl || /^https:\/\/radius\.pi\.dev(?:\/v1)?\/?$/u.test(baseUrl)
      || registeredGateways.has('radius'))) gateways.set('radius', '');
    for (const [id, gateway] of gateways) {
      if (registeredGateways.get(id) === gateway) continue;
      const provider = radiusProvider({ id, ...(gateway ? { gateway } : {}) });
      registerPiNativeProvider(runtime, brokered(withPi099RadiusCatalog(provider, () => metadata.get(id)?.cachedModels)));
      registeredGateways.set(id, gateway);
      registered.add(id);
    }
    for (const entry of metadata.values()) {
      const id = entry.providerId;
      if (registered.has(id)) continue;
      const provider = builtins.get(id) ?? {
        id, name: id, getModels: () => [],
        auth: { apiKey: genericApiKey },
        stream() { throw new Error('Provider requires configured models and API'); },
        streamSimple() { throw new Error('Provider requires configured models and API'); },
      } satisfies Provider;
      registerPiNativeProvider(runtime, brokered(provider));
      registered.add(id);
    }
  };
  registerProviders();
  runtime.refresh = async (options = {}) => {
    metadata = new Map((await auth.snapshot(options.signal)).map(entry => [entry.providerId, entry]));
    registerProviders();
    return refresh(options);
  };
  await refresh({ allowNetwork: false, ...(signal ? { signal } : {}) });
  return runtime;
}
