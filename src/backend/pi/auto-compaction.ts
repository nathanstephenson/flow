import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { AutoCompaction } from "../../protocol/settings.ts";

export function piAutoCompaction(settings: SettingsManager, setting: AutoCompaction | undefined) {
  const defaults = settings.getCompactionSettings();
  return (model: { contextWindow?: number } | undefined): void => {
    const window = model?.contextWindow;
    const compaction = { ...defaults };
    if (setting?.mode === "disabled") compaction.enabled = false;
    else if (setting?.mode === "enabled" && window !== undefined && Number.isFinite(window) && window > 0) {
      compaction.enabled = true;
      compaction.reserveTokens = Math.floor(window * (1 - setting.targetPercent / 100));
    }
    settings.applyOverrides({ compaction });
  };
}
