import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  applyPatch,
  formatDuration,
  loadConfig,
  type Config,
  type Settings,
  type SettingsPatch,
  type SummaryModel,
} from "./config.ts";
import { expandHome } from "./projects.ts";
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
   * The Project Root as an absolute path, asked fresh, or undefined when none is configured.
   *
   * The expanded counterpart to `view().projects.root`, which reports the string as typed. Both are
   * needed and they are not interchangeable: the Settings page has to read back the `~` its reader
   * wrote, and the walk has to be given a path the filesystem understands. Retention makes exactly
   * the same split for the same reason — milliseconds for the reaper, `"1d"` for the person.
   */
  readonly projectRoot = (): string | undefined => {
    const root = this.config.projects?.root;
    return root === undefined ? undefined : expandHome(root);
  };

  /**
   * The Project Root exactly as it was written, unexpanded, for resolving `include` entries against.
   *
   * Separate from `projectRoot()` because the resolver in ./projects.ts expands as it goes and
   * handing it an already-expanded root would be harmless but would put the same rule in two
   * places.
   */
  readonly rawProjectRoot = (): string | undefined => this.config.projects?.root;

  /** The opted-in Projects, as configured. Empty when none — see `Projects.include`. */
  readonly projectInclude = (): readonly string[] => this.config.projects?.include ?? [];

  /**
   * The Standing Authorisations, asked fresh. Empty when none has been granted.
   *
   * Read at Backend Session create time rather than watched, which is why this is a getter and not a
   * subscription: ADR 0009 rejected the observer shape, and a grant made in one Agent Session
   * reaching every other live one would be exactly that. A session that has not asked does not care,
   * and one that asks again after a grant elsewhere prompts once more and then picks the list up on
   * its next Revive.
   */
  readonly standingAuthorisations = (): readonly string[] => this.config.permissions?.allow ?? [];

  /**
   * The Default Model for one Backend Adapter, asked fresh, or undefined when none is configured.
   *
   * Read once when an Agent Session is created and never again — see `SessionHost.create`. A bound
   * method rather than the store itself, for the reason `retention` is one.
   */
  readonly defaultModel = (backend: string): string | undefined => this.config.providers?.defaults?.[backend];

  /** The Summary Model, asked fresh. Undefined means no Agent Session is named by a model. */
  readonly summaryModel = (): SummaryModel | undefined => this.config.providers?.summary;

  /**
   * Grant a Standing Authorisation for one tool — what an Always decision leaves behind.
   *
   * Additive, and the one write on this store that is: `update` replaces the list wholesale, which is
   * right for a client sending the list it wants but wrong for a single click, where two sessions
   * granting different tools at once would each erase the other's. Idempotent, so a second click on
   * a tool already granted writes nothing.
   *
   * A bound method rather than the store itself, for the reason `retention` is one: `SessionHost`
   * owns Agent Sessions, and it must not become the owner of config.json to do this.
   */
  readonly allowTool = (name: string): void => {
    const granted = this.standingAuthorisations();
    if (granted.includes(name)) return;
    this.update({ permissions: { allow: [...granted, name] } });
  };

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

    const document: Record<string, unknown> = { ...this.readRaw(), ...settingsOf(next) };
    // A section that is now *absent* has to be deleted, not merely left unwritten. The merge above
    // preserves whatever the file already holds — which is what keeps a hand-written key this
    // daemon has never heard of alive, and would otherwise keep a Project Root that the patch just
    // cleared. Both optional sections can be cleared, so both are deleted when absent — and for
    // `permissions` that is not tidiness: a section left behind would keep a Standing Authorisation
    // the human had just revoked.
    if (next.projects === undefined) delete document["projects"];
    if (next.permissions === undefined) delete document["permissions"];
    if (next.providers === undefined) delete document["providers"];

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
    // Omitted rather than defaulted when there is no Project Root, which is what
    // `Settings["projects"]` being optional means — see src/protocol/settings.ts.
    ...(config.projects === undefined ? {} : { projects: config.projects }),
    ...(config.permissions === undefined ? {} : { permissions: config.permissions }),
    ...(config.providers === undefined ? {} : { providers: config.providers }),
  };
}
