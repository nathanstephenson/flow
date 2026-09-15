import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ModelAutoCompaction } from "../../protocol/settings.ts";

export function piAutoCompaction(settings: SettingsManager, snapshot: ModelAutoCompaction) {
  const defaults = settings.getCompactionSettings();
  return (model: { id: string; provider?: string; contextWindow?: number } | undefined): void => {
    const id = model?.provider ? `${model.provider}/${model.id}` : model?.id;
    const setting = id ? snapshot[id] : undefined;
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
