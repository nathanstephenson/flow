import type { AutoCompaction } from "../../protocol/settings.ts";

export function claudeAutoCompactionEnv(
  setting: AutoCompaction | undefined,
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!setting) return undefined;
  const env = { ...inherited };
  delete env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE;
  env.DISABLE_AUTO_COMPACT = setting.mode === "disabled" ? "1" : "0";
  if (setting.mode === "enabled") env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE = String(setting.targetPercent);
  return env;
}
