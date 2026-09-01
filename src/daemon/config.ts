import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Session Host's configuration file: `<stateRoot>/config.json`, beside daemon.json and
 * sessions/.
 *
 * Retention governs a machine-wide store of Agent Sessions spanning many Scopes, which is why this
 * lives in the state root rather than in a working directory. A config file that cannot be read is
 * a warning and not a failure: a typo should not stop the daemon that owns your Presentation
 * Transcripts from starting.
 */

export type Retention = {
  /** How long a Settled Agent Session survives before it is reaped. `"never"` disables reaping. */
  settled: number | "never";
};

export type Config = {
  retention: Retention;
};

export const DEFAULT_SETTLED_RETENTION = 24 * 60 * 60 * 1000;

export function defaultConfig(): Config {
  return { retention: { settled: DEFAULT_SETTLED_RETENTION } };
}

export type LoadedConfig = {
  config: Config;
  /** Why the file was ignored, for the host to surface rather than swallow. */
  warning?: string;
};

export function loadConfig(stateRoot: string): LoadedConfig {
  let raw: string;
  try {
    raw = readFileSync(join(stateRoot, "config.json"), "utf8");
  } catch {
    // No config file is the normal case, not an error worth mentioning.
    return { config: defaultConfig() };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: defaultConfig(), warning: "config.json is not valid JSON; using defaults" };
  }

  const settled = (parsed as { retention?: { settled?: unknown } })?.retention?.settled;
  if (settled === undefined) return { config: defaultConfig() };
  if (settled === "never") return { config: { retention: { settled: "never" } } };

  if (typeof settled !== "string") {
    return { config: defaultConfig(), warning: `retention.settled must be a duration like "1d"; using defaults` };
  }
  const parsedDuration = parseDuration(settled);
  if (parsedDuration === undefined) {
    return { config: defaultConfig(), warning: `retention.settled: cannot read "${settled}" as a duration; using defaults` };
  }
  return { config: { retention: { settled: parsedDuration } } };
}

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/** `"90m"`, `"36h"`, `"1d"` — a duration in milliseconds, or undefined if it is not one. */
export function parseDuration(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];
  if (!amount || !unit) return undefined;
  const scale = UNITS[unit];
  if (scale === undefined) return undefined;
  return Number(amount) * scale;
}
