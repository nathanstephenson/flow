import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  DEFAULT_CHROME_FONT,
  DEFAULT_MONOSPACE_FONT,
  defaultFonts,
  type Fonts,
} from "../protocol/fonts.ts";
import {
  formatDuration,
  parseDuration,
  type Settings,
  type SettingsPatch,
} from "../protocol/settings.ts";

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

/**
 * The file's own shape, which is not quite the wire's: retention is milliseconds here because that
 * is what the reaper compares against, and a duration string there because that is what a person
 * typed. `view()` on the ConfigStore is where the two meet.
 */
export type Config = {
  retention: Retention;
  fonts: Fonts;
};

/**
 * The shape a client reads and writes, and the two halves of a duration's round trip. All declared
 * in the protocol, because the browser needs them too and cannot import a module that reads a file.
 */
export type { Settings, SettingsPatch };
export { formatDuration, parseDuration };

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
 *
 * Split from `readFontFamily` because the same rule has to answer to two callers with opposite
 * manners: a file on disk warns and falls back, and a PUT from a client is refused outright. So this
 * reports the problem and says nothing about what to do about it.
 */
export function checkFontFamily(value: unknown, field: string): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return `${field} must be a CSS font-family list`;
  }
  if (!/^[\w\s,'"-]+$/.test(value)) {
    return `${field}: "${value}" is not a font-family list`;
  }
  return undefined;
}

/** The file's manner: an unusable value costs only its own default, and says so. */
export function readFontFamily(
  value: unknown,
  field: string,
  fallback: string,
  warnings: string[],
): string {
  if (value === undefined) return fallback;
  const problem = checkFontFamily(value, field);
  if (problem !== undefined) {
    warnings.push(`${problem}; using the default`);
    return fallback;
  }
  return (value as string).trim();
}

/** A patch that cannot be applied. The message is shown to whoever sent it, so it names the field. */
export class ConfigError extends Error {}

/**
 * Merge a patch onto the current Config, refusing anything unusable.
 *
 * The opposite manner to `loadConfig`, deliberately. A file is parsed leniently because a typo must
 * not stop the daemon that owns your Presentation Transcripts from starting; a patch is refused
 * outright because there is a person waiting on the other end who can fix it, and silently keeping
 * the old value while reporting success is the one behaviour a settings page must never have.
 */
export function applyPatch(current: Config, patch: unknown): Config {
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    throw new ConfigError("expected an object");
  }
  const body = patch as SettingsPatch;
  refuseUnknownKeys(body, ["retention", "fonts"], "config");
  return {
    retention: { settled: patchRetention(current.retention.settled, body.retention) },
    fonts: patchFonts(current.fonts, body.fonts),
  };
}

function patchRetention(
  current: number | "never",
  patch: SettingsPatch["retention"],
): number | "never" {
  if (patch === undefined) return current;
  refuseUnknownKeys(patch, ["settled"], "retention");

  const settled: unknown = patch.settled;
  if (settled === undefined) return current;
  if (settled === "never") return "never";
  if (typeof settled !== "string") {
    throw new ConfigError(`retention.settled must be a duration like "1d", or "never"`);
  }
  const ms = parseDuration(settled);
  if (ms === undefined) {
    throw new ConfigError(`retention.settled: cannot read "${settled}" as a duration`);
  }
  // Zero parses, and would reap every Settled Agent Session on the next sweep. "never" is how you
  // say "do not reap"; zero is how you say it by accident.
  if (ms <= 0) throw new ConfigError(`retention.settled must be longer than zero, or "never"`);
  return ms;
}

function patchFonts(current: Fonts, patch: SettingsPatch["fonts"]): Fonts {
  if (patch === undefined) return current;
  refuseUnknownKeys(patch, ["chrome", "monospace"], "fonts");

  for (const field of ["chrome", "monospace"] as const) {
    const value: unknown = patch[field];
    if (value === undefined) continue;
    const problem = checkFontFamily(value, `fonts.${field}`);
    if (problem !== undefined) throw new ConfigError(problem);
  }
  return {
    chrome: patch.chrome?.trim() ?? current.chrome,
    monospace: patch.monospace?.trim() ?? current.monospace,
  };
}

/**
 * A key this daemon does not know is a mistake worth reporting, not one to ignore.
 *
 * The read path does ignore them — see `ConfigStore.update`, which preserves whatever a person
 * hand-wrote into the file. That is a different question: keeping a stranger's key is courtesy,
 * whereas accepting one over the wire and doing nothing with it is a client bug that would present
 * as a setting that will not stick.
 */
function refuseUnknownKeys(value: object, known: readonly string[], field: string): void {
  const unknown = Object.keys(value).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    throw new ConfigError(`${field}: unknown ${unknown.length === 1 ? "field" : "fields"} ${unknown.join(", ")}`);
  }
}
