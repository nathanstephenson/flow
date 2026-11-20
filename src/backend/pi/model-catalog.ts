import type { Api, Model, ModelCost, Provider } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';

export function registerPiNativeProvider(runtime: ModelRuntime, provider: Provider): void {
  const refresh = runtime.refresh;
  runtime.refresh = async () => ({ aborted: false, errors: new Map() });
  try { runtime.registerNativeProvider(provider); }
  finally { runtime.refresh = refresh; }
}

export function unregisterPiNativeProvider(runtime: ModelRuntime, providerId: string): void {
  const refresh = runtime.refresh;
  runtime.refresh = async () => ({ aborted: false, errors: new Map() });
  try { runtime.unregisterProvider(providerId); }
  finally { runtime.refresh = refresh; }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function rates(value: unknown): ModelCost | undefined {
  if (!object(value) || !finite(value.input) || !finite(value.output) || !finite(value.cacheRead) || !finite(value.cacheWrite)) return undefined;
  return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite };
}

export function projectPi099RadiusCatalog(providerId: string, value: unknown): readonly Model<Api>[] | undefined {
  if (!object(value) || typeof value.baseUrl !== 'string' || !Array.isArray(value.models)) return undefined;
  try {
    const url = new URL(value.baseUrl);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return undefined;
  } catch { return undefined; }
  const baseUrl = value.baseUrl;
  return value.models.flatMap<Model<Api>>(model => {
    if (!object(model) || typeof model.id !== 'string' || typeof model.name !== 'string' || typeof model.reasoning !== 'boolean'
      || !Array.isArray(model.input) || !model.input.every(input => input === 'text' || input === 'image')
      || !finite(model.contextWindow) || !finite(model.maxTokens)) return [];
    const cost = rates(model.cost);
    if (!cost) return [];
    if (object(model.cost) && Array.isArray(model.cost.tiers)) {
      cost.tiers = model.cost.tiers.flatMap(tier => {
        const tierRates = rates(tier);
        return object(tier) && finite(tier.inputTokensAbove) && tierRates ? [{ ...tierRates, inputTokensAbove: tier.inputTokensAbove }] : [];
      });
    }
    const projected: Model<Api> = { id: model.id, name: model.name, api: 'pi-messages', provider: providerId, baseUrl,
      reasoning: model.reasoning, input: [...model.input], cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens };
    if (object(model.thinkingLevelMap)) {
      projected.thinkingLevelMap = {};
      for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
        const value = model.thinkingLevelMap[level];
        if (value === null || typeof value === 'string') projected.thinkingLevelMap[level] = value;
      }
    }
    if (object(model.promptCache)) {
      projected.promptCache = {};
      for (const tier of ['short', 'long'] as const) if (finite(model.promptCache[tier])) projected.promptCache[tier] = model.promptCache[tier];
    }
    if (object(model.inputLimits)) {
      const limits = model.inputLimits;
      projected.inputLimits = {};
      if (finite(limits.maxRequestBytes)) projected.inputLimits.maxRequestBytes = limits.maxRequestBytes;
      if (object(limits.images)) {
        projected.inputLimits.images = {};
        for (const key of ['maxPerMessage', 'maxPerRequest'] as const) {
          if (finite(limits.images[key])) projected.inputLimits.images[key] = limits.images[key];
        }
        if (object(limits.images.resize)) {
          projected.inputLimits.images.resize = {};
          for (const key of ['maxWidth', 'maxHeight', 'maxBytes', 'jpegQuality'] as const) {
            if (finite(limits.images.resize[key])) projected.inputLimits.images.resize[key] = limits.images.resize[key];
          }
        }
      }
    }
    return [projected];
  });
}

export function withPi099RadiusCatalog(provider: Provider, cached: () => readonly Model<Api>[] | undefined): Provider {
  let hasStoredCatalog = false;
  const getModels = () => {
    const models = new Map(provider.getModels().map(model => [model.id, model]));
    if (!hasStoredCatalog) for (const model of cached() ?? []) models.set(model.id, model);
    return [...models.values()];
  };
  return {
    ...provider,
    getModels,
    getAllModels: getModels,
    async refreshModels(context) {
      await provider.refreshModels?.({ ...context, publish: publication => context.publish({ ...publication,
        update: () => {
          publication.update?.();
          if (context.stored || publication.persist) hasStoredCatalog = true;
        },
      }) });
    },
  };
}
