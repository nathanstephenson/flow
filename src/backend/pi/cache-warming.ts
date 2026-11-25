import type { InlineExtension, SettingsManager } from "@earendil-works/pi-coding-agent";

export function streamingCacheWarming(settings: SettingsManager): InlineExtension {
  return { name: "flow-streaming-cache-warming", hidden: true, factory: (pi) => {
    pi.on("cache_warming_decision", (_event, ctx) => {
      if (settings.getGlobalSettings().cacheWarming !== "idle" && ctx.isIdle()) return { action: "stop" };
    });
  } };
}
