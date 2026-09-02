import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_CHROME_FONT,
  DEFAULT_MONOSPACE_FONT,
  defaultFonts,
  type Fonts,
} from "../protocol/fonts.ts";

/**
 * The Session Host's configuration file: `<stateRoot>/config.json`, beside daemon.json and
 * sessions/.
 *
 * Retention governs a machine-wide store of Agent Sessions spanning many Scopes, which is why this
 * lives in the state root rather than in a working directory. A config file that cannot be read is
 * a warning and not a failure: a typo should not stop the daemon that owns your Presentation
 * Transcripts from starting — and that rule holds for every section below, which is why each is
 * parsed independently and a bad one costs only its own defaults.
 */

export type Retention = {
  /** How long a Settled Agent Session survives before it is reaped. `"never"` disables reaping. */
  settled: number | "never";
};

/**
 * The typefaces live in the protocol, not here: both the host that serves them and the client that
 * draws with them need the same defaults (src/protocol/fonts.ts).
 */
export type { Fonts };
export { DEFAULT_CHROME_FONT, DEFAULT_MONOSPACE_FONT };

export type Config = {
  retention: Retention;
  fonts: Fonts;
};

export const DEFAULT_SETTLED_RETENTION = 24 * 60 * 60 * 1000;

export function defaultConfig(): Config {
  return { retention: { settled: DEFAULT_SETTLED_RETENTION }, fonts: defaultFonts() };
}

export type LoadedConfig = {
  config: Config;
  /** Why part of the file was ignored, for the host to surface rather than swallow. */
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

  const warnings: string[] = [];
  const retention = parseRetention(parsed, warnings);
  const fonts = parseFonts(parsed, warnings);

  return {
    config: { retention, fonts },
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
}

function parseRetention(parsed: unknown, warnings: string[]): Retention {
  const settled = (parsed as { retention?: { settled?: unknown } })?.retention?.settled;
  if (settled === undefined) return { settled: DEFAULT_SETTLED_RETENTION };
  if (settled === "never") return { settled: "never" };

  if (typeof settled !== "string") {
    warnings.push(`retention.settled must be a duration like "1d"; using defaults`);
    return { settled: DEFAULT_SETTLED_RETENTION };
  }
  const parsedDuration = parseDuration(settled);
  if (parsedDuration === undefined) {
    warnings.push(`retention.settled: cannot read "${settled}" as a duration; using defaults`);
    return { settled: DEFAULT_SETTLED_RETENTION };
  }
  return { settled: parsedDuration };
}

function parseFonts(parsed: unknown, warnings: string[]): Fonts {
  const configured = (parsed as { fonts?: { chrome?: unknown; monospace?: unknown } })?.fonts;
  return {
    chrome: readFontFamily(configured?.chrome, "fonts.chrome", DEFAULT_CHROME_FONT, warnings),
    monospace: readFontFamily(configured?.monospace, "fonts.monospace", DEFAULT_MONOSPACE_FONT, warnings),
  };
}

/**
 * A font-family list is only ever family names, so anything outside that alphabet is refused.
 *
 * This value is set as a CSS custom property in a browser. The CSSOM would reject a malformed one
 * rather than execute it, so the check is not the only thing standing between a config file and the
 * page — but a config file that silently does nothing is worse than one that says why, and a
 * validated alphabet is how the reader finds out they typed something impossible.
 */
export function readFontFamily(
  value: unknown,
  field: string,
  fallback: string,
  warnings: string[],
): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || value.trim() === "") {
    warnings.push(`${field} must be a CSS font-family list; using the default`);
    return fallback;
  }
  if (!/^[\w\s,'"-]+$/.test(value)) {
    warnings.push(`${field}: "${value}" is not a font-family list; using the default`);
    return fallback;
  }
  return value.trim();
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
