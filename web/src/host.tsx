import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";

import type { Connection } from "@client/connection.ts";
import type { Project } from "../../src/protocol/projects.ts";
import type { Settings, SettingsPatch } from "../../src/protocol/settings.ts";
import { applyFonts, type Fonts } from "@/fonts.ts";
import { host } from "@/store/host.ts";

/**
 * The Session Host, as this app sees it: the shared transport, and the two facts `/api/config`
 * reports.
 *
 * The Connection is imported rather than created here. Two call sites deciding a URL and a
 * credentials mode independently is precisely the drift this migration exists to remove, and
 * `@/store/host.ts` is where that decision lives.
 */
const connection: Connection = host;

/** What the host offers a new Agent Session: a default Scope, and every backend it has registered. */
export type HostConfig = {
  scope: string;
  backends: string[];
  /**
   * Whether this host can open a Shell. False where the pty addon could not load — notably the
   * single-executable build, which cannot contain a native addon. The control is hidden rather than
   * offered and broken, which is the rule Capabilities already sets for backends.
   */
  shell?: boolean;
  /**
   * Whether this host can run git. False where git is not on the machine — it is a documented
   * prerequisite rather than a dependency, so a single-executable build or a bare container has
   * none. Same rule as `shell` above: hide the control rather than offer one that fails.
   */
  git?: boolean;
  /** The typefaces from config.json. Absent means this host reported none, so the defaults stand. */
  fonts?: Fonts;
  /**
   * How long a Settled Agent Session survives, as a duration like `"1d"` or `"never"`. Absent where
   * this Session Host serves no Settings, which is what the Settings page checks before offering to
   * edit anything.
   */
  retention?: Settings["retention"];
  /**
   * The Project Root, as typed. Absent where none is configured — which is not a defaulted value
   * but a real state, and the one the Projects settings section checks for.
   */
  projects?: Settings["projects"];
  /**
   * The Standing Authorisations. Absent where none has been granted, which is a real state and the
   * one the Permissions settings section checks for — the same shape `projects` has, for the same
   * reason.
   */
  permissions?: Settings["permissions"];
  /**
   * The Default Models and the Summary Model. Absent where neither has been chosen — the same shape
   * `projects` and `permissions` have, for the same reason.
   */
  providers?: Settings["providers"];
  /**
   * The opted-in Projects — `projects.include`, resolved. This is what a client offers.
   *
   * **Derived, not a Setting.** The Setting is the list of paths; this is what they point at, which
   * is why the host resolves it fresh on each request and reports it beside the Settings rather than
   * inside them. Empty until something is opted into, and the dialog treats empty and absent alike.
   */
  projectList?: Project[];
  /**
   * Repositories found beneath the Project Root that are *not* opted in yet.
   *
   * Disjoint from `projectList` by construction, so the Settings page can offer these to add
   * without filtering and the dialog can never accidentally show one. This is all discovery is for
   * now: suggesting things to opt into (ADR 0011).
   */
  projectCandidates?: Project[];
};

export type HostValue = {
  connection: Connection;
  config: HostConfig;
  /**
   * Save part of the Settings, and fold the result back into `config` so the app is looking at what
   * the Session Host now holds rather than at what was typed.
   *
   * Rejects with the daemon's own message on a refused value, because that message names the field.
   * Settings are machine-wide, so this is deliberately not scoped to an Agent Session.
   */
  saveSettings: (patch: SettingsPatch) => Promise<Settings>;
  /**
   * Ask the Session Host for its config again.
   *
   * The Projects are derived rather than saved, so a `PUT` cannot report them back: saving a new
   * Project Root tells you the root took, not what is beneath it. This is also what makes a
   * repository cloned five minutes ago appear in the New Agent Session view without a reload —
   * the payoff for the host walking uncached.
   */
  refresh: () => Promise<void>;
};

const HostContext = createContext<HostValue | undefined>(undefined);

export function useHost(): HostValue {
  const value = useContext(HostContext);
  if (!value) throw new Error("useHost outside HostProvider");
  return value;
}

type Gate = { state: "loading" } | { state: "unauthorized" } | { state: "ready"; config: HostConfig };

export function HostProvider({ children }: { children: ReactNode }) {
  const [gate, setGate] = useState<Gate>({ state: "loading" });

  useEffect(() => {
    const abort = new AbortController();
    void (async () => {
      try {
        const response = await fetch("/api/config", { credentials: "same-origin", signal: abort.signal });
        // 401 is the one failure with a specific answer, and the answer is never a form (ADR 0004
        // and 0005): this app has no token field and never will.
        if (response.status === 401 || response.status === 403) {
          setGate({ state: "unauthorized" });
          return;
        }
        const config = (await response.json()) as HostConfig;
        // Before the tree mounts, so nothing renders in one typeface and reflows into another.
        applyFonts(config.fonts);
        setGate({ state: "ready", config });
      } catch {
        if (!abort.signal.aborted) setGate({ state: "loading" });
      }
    })();
    return () => abort.abort();
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const response = await fetch("/api/config", { credentials: "same-origin" });
    if (!response.ok) return;
    const config = (await response.json()) as HostConfig;
    applyFonts(config.fonts);
    // Replaced wholesale rather than merged: this *is* the host's answer, and keeping any part of
    // the previous one would be preferring a stale value to a fresh one.
    setGate((current) => (current.state === "ready" ? { state: "ready", config } : current));
  }, []);

  const saveSettings = useCallback(async (patch: SettingsPatch): Promise<Settings> => {
    const response = await fetch("/api/config", {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const body = (await response.json()) as Settings & { error?: string };
    // The daemon refuses a bad value rather than warning and keeping the old one, and its message
    // names the offending field — so it is the message worth showing.
    if (!response.ok) throw new Error(body.error ?? `Could not save the Settings (${response.status})`);

    // Applied here rather than by the page that saved it: a typeface is the whole document's, and a
    // page that painted only itself in the new font would be the one place it looked right.
    applyFonts(body.fonts);
    setGate((current) =>
      current.state === "ready"
        ? {
            state: "ready",
            config: {
              ...current.config,
              fonts: body.fonts,
              retention: body.retention,
              // Spread-with-undefined would leave a stale value behind once a section is cleared.
              // Both optional sections need it, and for `permissions` it is not tidiness: a stale
              // list would leave a revoked row on screen, and revoking a second grant would send the
              // old list back and re-grant the first.
              ...(body.projects === undefined ? { projects: undefined } : { projects: body.projects }),
              ...(body.permissions === undefined
                ? { permissions: undefined }
                : { permissions: body.permissions }),
              ...(body.providers === undefined ? { providers: undefined } : { providers: body.providers }),
            },
          }
        : current,
    );
    return body;
  }, []);

  if (gate.state === "unauthorized") return <Unauthorized />;
  if (gate.state === "loading") return <Waiting />;

  return (
    <HostContext.Provider value={{ connection, config: gate.config, saveSettings, refresh }}>
      {children}
    </HostContext.Provider>
  );
}

/**
 * The only correct UI for a 401.
 *
 * There is no login here and there are no credentials to collect: the Session Host prints a one-time
 * handoff URL when it starts, and opening it is the whole ceremony. A token field on this page would
 * be a credential input in an app whose security model is that there is nowhere to type one.
 */
function Unauthorized() {
  return (
    <main className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-lg font-semibold">This browser is not authorised</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        The Session Host prints a handoff URL when it starts. Open it once in this browser and it sets
        the cookie every request after that carries.
      </p>
      <code className="rounded-md border bg-muted px-2 py-1 font-mono text-sm text-foreground">
        /auth?token=…
      </code>
      <p className="max-w-md text-xs text-muted-foreground">
        Use the URL as printed. Under the dev server, use the one the dev handoff printed instead —
        127.0.0.1 and localhost are different cookie hosts.
      </p>
    </main>
  );
}

function Waiting() {
  return (
    <main className="flex h-full items-center justify-center">
      <p className="text-sm text-muted-foreground">Reaching the Session Host…</p>
    </main>
  );
}
