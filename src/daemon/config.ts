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
  /**
   * The Project Root, as typed — tilde and all. Absent when none is configured, which is not a
   * defaulted value but a real state: the Session Host then offers no Projects at all.
   *
   * Expanded at the point of use rather than here, by `expandHome` in ./projects.ts, for the reason
   * retention is stored in milliseconds and reported as `"1d"`: the file holds what a person wrote
   * and has to be able to read back.
   */
  projects?: Projects;
  /**
   * The Standing Authorisations. Absent when none has been granted, which is a real state and not a
   * defaulted value: a machine that has never answered a Permission Prompt with Always has none.
   */
  permissions?: Permissions;
};

/**
 * Tools authorised for every Agent Session on this machine, so no Permission Prompt is raised for
 * them again.
 *
 * Names as typed, and never normalised beyond a trim: a tool name is an identifier the backend
 * chose, and lower-casing `mcp__gdrive__trash_file` would silently stop matching it.
 */
export type Permissions = {
  allow?: string[];
};

export type Projects = {
  root?: string;
  /**
   * The opted-in Projects, as typed — relative to the Project Root, or absolute.
   *
   * This list *is* the Projects. A repository beneath the root is only a candidate until it appears
   * here, which is what keeps the dropdown as short as its owner wants (ADR 0011). Absent and empty
   * mean the same thing — no Projects — because "opted into nothing" and "not yet opted into
   * anything" are not usefully different states, and treating them differently would mean a client
   * had to explain the distinction.
   */
  include?: string[];
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
  const projects = parseProjects(parsed, warnings);
  const permissions = parsePermissions(parsed, warnings);

  return {
    config: {
      retention,
      fonts,
      ...(projects === undefined ? {} : { projects }),
      ...(permissions === undefined ? {} : { permissions }),
    },
    ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}),
  };
}

/**
 * The file's manner once more, and here it matters more than anywhere else: a malformed
 * `permissions.allow` must cost *nothing but itself*. Falling back to some other list would either
 * authorise a tool nobody granted or, worse, be read as having done so.
 *
 * So an unusable section grants nothing, an unusable entry is dropped, and both say why.
 */
function parsePermissions(parsed: unknown, warnings: string[]): Permissions | undefined {
  const section = (parsed as { permissions?: { allow?: unknown } })?.permissions;
  if (section === undefined || section === null) return undefined;
  if (section.allow === undefined) return undefined;

  if (!Array.isArray(section.allow)) {
    warnings.push("permissions.allow must be a list of tool names; authorising none");
    return undefined;
  }
  const usable = section.allow.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  );
  if (usable.length !== section.allow.length) {
    warnings.push("permissions.allow: ignoring an entry that is not a tool name");
  }
  return usable.length === 0 ? undefined : { allow: usable.map((entry) => entry.trim()) };
}

/**
 * The file's manner again: an unusable value costs only itself, and says so.
 *
 * The root and the list are parsed independently, so a typo in one does not cost the other — a bad
 * root still leaves absolute entries in `include` usable, and a malformed `include` still leaves
 * the root available for the Settings page to offer candidates from.
 */
function parseProjects(parsed: unknown, warnings: string[]): Projects | undefined {
  const section = (parsed as { projects?: { root?: unknown; include?: unknown } })?.projects;
  if (section === undefined || section === null) return undefined;

  const projects: Projects = {};

  if (section.root !== undefined) {
    const problem = checkProjectRoot(section.root);
    if (problem !== undefined) warnings.push(`${problem}; offering no Project Root`);
    else projects.root = (section.root as string).trim();
  }

  if (section.include !== undefined) {
    if (!Array.isArray(section.include)) {
      warnings.push("projects.include must be a list of paths; offering no Projects");
    } else {
      const usable = section.include.filter((entry): entry is string => typeof entry === "string");
      if (usable.length !== section.include.length) {
        warnings.push("projects.include: ignoring an entry that is not a path");
      }
      projects.include = usable;
    }
  }

  return projects.root === undefined && projects.include === undefined ? undefined : projects;
}

/**
 * Whether a value can serve as a Project Root, reported without saying what to do about it.
 *
 * Split for the same reason `checkFontFamily` is: the file warns and falls back, a PUT is refused
 * outright, and the rule itself must not know which caller it is answering.
 *
 * **Existence is deliberately not checked.** A root that is not there yields no Projects, and the
 * Settings page saying "no Projects found beneath <path>" tells its reader more than a refusal
 * would — while keeping `applyPatch` free of filesystem I/O, so a patch stays a pure merge.
 */
export function checkProjectRoot(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return "projects.root must be a path";
  }
  const path = value.trim();
  if (!path.startsWith("/") && !path.startsWith("~")) {
    // A relative root would resolve against the daemon's working directory, which is not a thing
    // its reader can see, so the same config.json would mean different directories per start.
    return `projects.root: "${path}" must be absolute, or start with ~`;
  }
  return undefined;
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
  refuseUnknownKeys(body, ["retention", "fonts", "projects", "permissions"], "config");
  const projects = patchProjects(current.projects, body.projects);
  const permissions = patchPermissions(current.permissions, body.permissions);
  return {
    retention: { settled: patchRetention(current.retention.settled, body.retention) },
    fonts: patchFonts(current.fonts, body.fonts),
    ...(projects === undefined ? {} : { projects }),
    ...(permissions === undefined ? {} : { permissions }),
  };
}

/**
 * The Standing Authorisations a client wants to end up with.
 *
 * **Replaced wholesale**, for the reason `projects.include` is and with more riding on it: a merged
 * list would make a revocation indistinguishable from an omission, and the thing left un-revoked here
 * is a tool the machine will run without asking. An empty list is therefore meaningful — it is how
 * the last grant is taken back — and clears the section rather than being ignored.
 */
function patchPermissions(
  current: Permissions | undefined,
  patch: SettingsPatch["permissions"],
): Permissions | undefined {
  if (patch === undefined) return current;
  refuseUnknownKeys(patch, ["allow"], "permissions");

  const allow: unknown = patch.allow;
  if (allow === undefined) return current;
  if (!Array.isArray(allow)) throw new ConfigError("permissions.allow must be a list of tool names");

  const names: string[] = [];
  for (const entry of allow as unknown[]) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigError("permissions.allow: every entry must be a tool name");
    }
    const trimmed = entry.trim();
    // Deduplicated rather than refused, as `projects.include` is: two clients racing to grant the
    // same tool is a mistake worth absorbing, not one worth failing a save over.
    if (!names.includes(trimmed)) names.push(trimmed);
  }
  return names.length === 0 ? undefined : { allow: names };
}

function patchProjects(
  current: Projects | undefined,
  patch: SettingsPatch["projects"],
): Projects | undefined {
  if (patch === undefined) return current;
  refuseUnknownKeys(patch, ["root", "include"], "projects");

  const next: Projects = { ...current };

  const root: unknown = patch.root;
  if (root !== undefined) {
    // An empty string is how a form says "clear this field", and is the one way back to having no
    // Project Root without hand-editing the file. It is distinct from omitting the key, which means
    // "leave it alone".
    if (root === "") delete next.root;
    else {
      const problem = checkProjectRoot(root);
      if (problem !== undefined) throw new ConfigError(problem);
      next.root = (root as string).trim();
    }
  }

  const include: unknown = patch.include;
  if (include !== undefined) {
    // Replaced wholesale rather than merged. Every other Setting is a value that can be patched in
    // isolation; this is a list, and "merge a list" has no meaning that would not surprise someone
    // — a removal would be indistinguishable from an omission.
    if (!Array.isArray(include)) throw new ConfigError("projects.include must be a list of paths");
    const entries: string[] = [];
    for (const entry of include as unknown[]) {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new ConfigError("projects.include: every entry must be a path");
      }
      const trimmed = entry.trim();
      // Deduplicated rather than refused: two clients racing to add the same Project is a mistake
      // worth absorbing, not one worth failing a save over.
      if (!entries.includes(trimmed)) entries.push(trimmed);
    }
    if (entries.length === 0) delete next.include;
    else next.include = entries;
  }

  return next.root === undefined && next.include === undefined ? undefined : next;
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
