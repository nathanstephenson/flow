/**
 * The Settings, as they cross the wire.
 *
 * Settings are machine-wide: they live in the Session Host's state root, not in a Scope, so one
 * value governs every Agent Session on the machine. That is the fact most likely to be got wrong by
 * someone editing them from a browser window that is showing one Scope, which is why it is said here
 * and in CONTEXT.md rather than left to be inferred.
 *
 * In the protocol rather than beside the daemon because both ends need the same shape: the Session
 * Host reports `Settings` on /api/config and accepts a `SettingsPatch` on PUT, and the web client
 * renders the first and sends the second. `src/daemon/config.ts` owns how they are parsed and what
 * they mean on disk; this file owns only their shape.
 */

import type { Fonts } from "./fonts.ts";

export type Settings = {
  retention: {
    /**
     * How long a Settled Agent Session survives before it is reaped — a duration like `"1d"`, or
     * `"never"`.
     *
     * A string rather than the milliseconds the reaper actually compares against, because this is a
     * value a person typed and has to be able to read back. `formatDuration` and `parseDuration` in
     * src/daemon/config.ts are the two halves of that round trip.
     */
    settled: string;
  };
  fonts: Fonts;
  /**
   * Where the Session Host looks for Projects — the Project Root, as the string a person typed, so
   * `~/workspace` survives the round trip rather than being reported back expanded.
   *
   * **Absent rather than defaulted**, which is the one way this section differs from the two above.
   * A retention window and a typeface both have a right answer for a machine that has never been
   * configured; a Project Root does not, and "none" is the state every installation starts in. So
   * the key is omitted entirely when unset, and a client checks for it rather than comparing
   * against a default it would have to know.
   */
  projects?: {
    root?: string;
    /**
     * The opted-in Projects, as typed — each relative to the Project Root, or absolute.
     *
     * This list is what a client offers; a repository merely *found* beneath the root is a
     * candidate, reported separately on /api/config and not a Project until it appears here.
     * Absent means none, and is not distinguished from an empty list.
     */
    include?: string[];
  };
  /**
   * The Standing Authorisations: tools a human has authorised for every Agent Session on the machine,
   * so a Permission Prompt is never raised for them again.
   *
   * **Absent rather than defaulted**, as `projects` is: a machine that has never granted one has none,
   * and that is the state every installation starts in rather than a value with a right answer.
   *
   * Names, not rules. `allow` cannot express `Bash(git:*)` or "this MCP server, read tools only", so
   * one grant on a tool authorises every future call of it whatever the arguments — which is why this
   * is the one section of the Settings with a revocation list in the client rather than only an
   * editor. What a person granted, they must be able to see and take back.
   *
   * Never a way *round* `disallowedTools`: an operator who refused a tool outranks a grant made here,
   * and the adapter checks in that order.
   */
  permissions?: {
    allow?: string[];
  };
  /**
   * Which model to use when nobody has said otherwise.
   *
   * **Absent rather than defaulted**, as `projects` and `permissions` are: a machine nobody has
   * configured has no right answer, and no Default Model is the state every installation starts in.
   *
   * Named for the Provider whose models it chooses between, and keyed by Backend Adapter, because a
   * model id only means anything through the adapter that serves it — `opus[1m]` is a Claude alias
   * and nothing else can be handed it. CONTEXT.md's Provider entry says so too.
   */
  providers?: {
    /** The Default Model per Backend Adapter: the model a new Agent Session starts on. */
    defaults?: Record<string, string>;
    /**
     * The Summary Model — the model that names an Agent Session.
     *
     * Both halves or neither. A model id without the Backend Adapter that serves it is unreachable,
     * so there is no useful half-configured state to represent.
     *
     * `automatic` is *when*, not whether: false leaves a session named by the first line of what
     * was typed, and leaves "Name this Agent Session again" working. Whether the feature exists at
     * all is said by this section being absent — which is why the switch lives in here rather than
     * beside it, where it could disagree with a model nobody configured.
     */
    summary?: { backend: string; modelId: string; automatic: boolean };
  };
};

/**
 * What a client asks to change. Partial at every level, and merged rather than replacing.
 *
 * Each section of the settings page saves on its own, so a whole-document PUT would make one
 * section's save silently revert another's — and a client that has not been taught about a field
 * would erase it.
 */
export type SettingsPatch = {
  retention?: { settled?: string };
  fonts?: { chrome?: string; monospace?: string };
  /**
   * `root` is a value and merges; `include` is a list and **replaces**. Merging a list has no
   * meaning anyone would predict — a removal would look exactly like an omission — so a client
   * sends the whole list it wants to end up with.
   */
  projects?: { root?: string; include?: string[] };
  /**
   * `allow` **replaces**, for the reason `projects.include` does: a client sends the whole list it
   * wants to end up with, because a merged list makes a revocation indistinguishable from an
   * omission — and here that failure mode is a grant nobody can take back.
   */
  permissions?: { allow?: string[] };
  /**
   * `defaults` **merges per backend**, unlike the two lists above, and `""` clears one entry the way
   * `projects.root: ""` clears the root. The reason lists replace does not apply here: a keyed map
   * can express a removal, so a removal never looks like an omission.
   *
   * `summary` is one value. Send both fields to set it, or `null` to clear it — a half-specified
   * Summary Model is refused rather than merged, because merging one would let a client change the
   * Backend Adapter while leaving behind a model id that adapter cannot serve.
   */
  providers?: {
    defaults?: Record<string, string>;
    /** `automatic` may be omitted when setting a model, and defaults to naming automatically. */
    summary?: { backend: string; modelId: string; automatic?: boolean } | null;
  };
};

const UNITS: Record<string, number> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
};

/**
 * `"90m"`, `"36h"`, `"1d"` — a duration in milliseconds, or undefined if it is not one.
 *
 * Here rather than beside the parser that uses it because both ends need it: the Session Host reads
 * the file with it, and the web client uses it to work out what a window the reader has typed would
 * reap before they commit to it. `src/daemon/config.ts` cannot be the home — it reads a file, so a
 * browser cannot import it.
 */
export function parseDuration(value: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(s|m|h|d)\s*$/.exec(value);
  const amount = match?.[1];
  const unit = match?.[2];
  if (!amount || !unit) return undefined;
  const scale = UNITS[unit];
  if (scale === undefined) return undefined;
  return Number(amount) * scale;
}

/**
 * The inverse, in the largest unit that divides evenly: 86400000 is `"1d"` and not `"24h"`.
 *
 * Retention is stored as milliseconds because that is what the reaper compares against, but a
 * duration is a thing a person typed and a person has to read it back. Reporting `86400000` on
 * /api/config would make the field in the browser un-editable without arithmetic, so this exists to
 * round-trip through `parseDuration` — and `test/settings.test.ts` holds the two to each other.
 */
export function formatDuration(ms: number): string {
  for (const unit of ["d", "h", "m", "s"] as const) {
    const scale = UNITS[unit] as number;
    if (ms >= scale && ms % scale === 0) return `${ms / scale}${unit}`;
  }
  // Under a second, or not a whole number of any unit: seconds, fractional if it must be.
  return `${ms / 1000}s`;
}
