import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import type { Connection } from "@client/connection.ts";
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
  /** The typefaces from config.json. Absent means this host reported none, so the defaults stand. */
  fonts?: Fonts;
};

type HostValue = { connection: Connection; config: HostConfig };

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

  if (gate.state === "unauthorized") return <Unauthorized />;
  if (gate.state === "loading") return <Waiting />;

  return <HostContext.Provider value={{ connection, config: gate.config }}>{children}</HostContext.Provider>;
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
