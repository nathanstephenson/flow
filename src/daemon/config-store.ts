import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyPatch,
  formatDuration,
  loadConfig,
  type Config,
  type Settings,
  type SettingsPatch,
} from "./config.ts";
import { defaultStateRoot } from "./store.ts";

/**
 * The one owner of `<stateRoot>/config.json`.
 *
 * Everything that needs a setting reads *through* this rather than being handed a copy at startup.
 * That is the whole point: the reaper asks for the retention window at each sweep and the HTTP
 * surface asks for the Settings on each request, so an edit takes effect without restarting the
 * daemon — and there is no second copy to go stale. Shaped after TranscriptStore, its neighbour:
 * a root in the constructor, synchronous fs, no cleverness.
 *
 * Reading is lenient and writing is strict, and the asymmetry is deliberate — see `applyPatch` in
 * ./config.ts for why.
 */
export class ConfigStore {
  private readonly path: string;
  private readonly root: string;
  private config: Config;
  /** Why part of the file on disk was ignored, for the daemon to print on the way up. */
  readonly warning: string | undefined;

  constructor(root: string = defaultStateRoot()) {
    this.root = root;
    this.path = join(root, "config.json");
    const loaded = loadConfig(root);
    this.config = loaded.config;
    this.warning = loaded.warning;
  }

  /** The current Config, in the file's own units. Cheap: held in memory, not re-read. */
  current(): Config {
    return this.config;
  }

  /** The current Settings, in the wire's units — a duration a person can read and edit. */
  view(): Settings {
    return settingsOf(this.config);
  }

  /**
   * How long a Settled Agent Session survives, asked fresh. This is what the SessionHost is given.
   *
   * A bound method rather than the store itself, so `SessionHost` needs to know nothing about
   * config.json — it owns Agent Sessions, and a file full of typefaces is not its business.
   */
  readonly retention = (): number | "never" => this.config.retention.settled;

  /**
   * Merge a patch in, write it out, and report the result. Throws ConfigError on anything unusable,
   * having changed nothing.
   *
   * Read-modify-write against the file rather than against `this.config`, so a key no version of
   * this daemon has heard of survives being edited around. Someone who hand-wrote a field we do not
   * parse yet should not lose it because they later changed a font in a browser.
   */
  update(patch: SettingsPatch): Settings {
    const next = applyPatch(this.config, patch);

    const document = { ...this.readRaw(), ...settingsOf(next) };
    mkdirSync(this.root, { recursive: true });
    // Written beside the target and renamed over it: a crash mid-write leaves the old config intact
    // rather than a truncated one, and `loadConfig` treats a truncated file as "use the defaults" —
    // which would silently reset every setting on the next start.
    const scratch = `${this.path}.${process.pid}.tmp`;
    writeFileSync(scratch, `${JSON.stringify(document, null, 2)}\n`);
    renameSync(scratch, this.path);

    this.config = next;
    return this.view();
  }

  /** The file as it stands, verbatim. An unreadable or non-object file contributes nothing. */
  private readRaw(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
      return parsed as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

/**
 * A Config as Settings: durations back in the form they were written in.
 *
 * One function for both the wire and the file, because they *are* the same shape — the file is the
 * thing a person edits and the wire carries what they typed. Two functions here would be two chances
 * for `/api/config` to report a value the file does not hold.
 */
function settingsOf(config: Config): Settings {
  const { settled } = config.retention;
  return {
    retention: { settled: settled === "never" ? "never" : formatDuration(settled) },
    fonts: config.fonts,
  };
}
