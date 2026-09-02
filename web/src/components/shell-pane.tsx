import { useEffect, useRef, useState } from "react";
import { FitAddon, Ghostty, Terminal, type ITheme } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";
import { X } from "lucide-react";

import { FALLBACK_FONTS, fontsReady } from "@/fonts.ts";
import { useHost } from "@/host.tsx";
import { Button } from "@/components/ui/button.tsx";
import { attachShell, listShells, openShell, type ShellConnection } from "@/shell-connection.ts";

/**
 * A Shell, on screen: Ghostty compiled to WASM, fed by a pty in the Session Host.
 *
 * The emulator is a mutable object with its own render loop and its own canvas, so almost nothing
 * here is React state. The bytes never touch a setState — they go from the socket straight into
 * `term.write` — and the two things that *are* state are the ones a human reads rather than types
 * into: whether we are still connecting, and why the screen stopped.
 *
 * Closing this pane unmounts the component, which closes the socket and disposes the emulator. It
 * does not kill the Shell: reopening lists the Agent Session's Shells, finds the one still running,
 * and reattaches to it — which is why `npm run dev` survives a stray click on the close button.
 *
 * The typeface comes from `fonts.monospace` in config.json. It has to be configurable rather than
 * chosen here: a Powerline or Nerd Font prompt draws its separators from the Private Use Area, and
 * no stock system font carries those codepoints, so the only font that renders one correctly is
 * whichever the reader already has installed.
 */

/** One Ghostty WASM instance for the whole app; every Terminal is handed the same one. */
let ghostty: Promise<Ghostty> | undefined;
function loadGhostty(): Promise<Ghostty> {
  // `init()` would guess the WASM's location from the page URL, which is wrong the moment Vite
  // content-hashes it into /assets. The path is passed explicitly instead.
  ghostty ??= Ghostty.load(wasmUrl);
  return ghostty;
}

type Status = { state: "connecting" } | { state: "live" } | { state: "gone"; why: string };

export function ShellPane({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const mount = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>({ state: "connecting" });
  const { config } = useHost();
  const monospace = config.fonts?.monospace ?? FALLBACK_FONTS.monospace;

  useEffect(() => {
    const parent = mount.current;
    if (!parent) return;

    // StrictMode mounts, unmounts and mounts again. Everything below is async, so the teardown has
    // to be able to cancel work that has not finished starting yet.
    let cancelled = false;
    let term: Terminal | undefined;
    let connection: ShellConnection | undefined;

    void (async () => {
      // Both before the Terminal exists. Canvas2D does not load fonts on demand, and the emulator
      // measures its cell from the font's metrics on open — so opening first would size every cell
      // to the fallback and never correct itself.
      const [loaded] = await Promise.all([loadGhostty(), fontsReady(monospace)]);
      if (cancelled) return;

      term = new Terminal({
        ghostty: loaded,
        fontSize: 13,
        fontFamily: monospace,
        theme: paneTheme(parent),
        cursorBlink: true,
      });
      term.open(parent);

      // Fit before opening the Shell, so the pty is spawned at the size it will actually be drawn
      // at. Spawning at 80x24 and resizing immediately makes every shell redraw its prompt on open.
      const fit = new FitAddon();
      term.loadAddon(fit);
      fit.fit();
      fit.observeResize();

      let shellId: string;
      try {
        // Reattach in preference to opening another: this pane is one Shell's worth of screen, and
        // the Shell it wants is the one it left running. Opening a second is a feature this pane
        // does not have yet, which is why the protocol allows several and this does not.
        const existing = await listShells(sessionId);
        shellId = existing[0]?.id ?? (await openShell(sessionId, term.cols, term.rows)).id;
      } catch (error) {
        if (!cancelled) setStatus({ state: "gone", why: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (cancelled) return;

      connection = attachShell(shellId, {
        output: (bytes) => term?.write(bytes),
        ready: () => setStatus({ state: "live" }),
        exit: (code) => setStatus({ state: "gone", why: code === 0 ? "exited" : `exited (${code ?? "signal"})` }),
        closed: () => setStatus({ state: "gone", why: "disconnected" }),
      });

      term.onData((data) => connection?.send(data));
      term.onResize(({ cols, rows }) => connection?.resize(cols, rows));
      // The pty was spawned at the pre-fit size in the reattach case, and the Shell we joined may
      // have been left at another client's size. Say ours once, up front.
      connection.resize(term.cols, term.rows);
      term.focus();
    })();

    return () => {
      cancelled = true;
      connection?.close();
      term?.dispose();
    };
  }, [sessionId, monospace]);

  return (
    <section
      // Found by attribute for the same reason the Agent Session pane is: a global shortcut moves
      // focus in here without a ref threaded down from the app shell.
      data-shell-pane=""
      className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] border-t bg-background"
      aria-label="Shell"
    >
      <header className="flex h-9 items-center justify-between border-b px-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-muted-foreground">Shell</span>
          {status.state !== "live" && (
            <span className="text-xs text-muted-foreground">
              {status.state === "connecting" ? "connecting…" : status.why}
            </span>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          onClick={onClose}
          // Says what closing does, because the honest answer is "nothing to your shell" and that
          // is not what a close button usually means.
          title="Hide the Shell — it keeps running"
          aria-label="Hide the Shell"
        >
          <X className="size-3.5" />
        </Button>
      </header>

      <div ref={mount} className="min-h-0 overflow-hidden" />
    </section>
  );
}

/**
 * The app's own colours, resolved to something the emulator can use.
 *
 * Read off a probe element and through a canvas rather than parsed: the theme is authored in CSS
 * variables that are `oklch()` in this design system, and the only thing that reliably turns an
 * arbitrary CSS colour into RGB is asking the browser to paint it.
 */
function paneTheme(parent: HTMLElement): ITheme {
  const styles = getComputedStyle(parent);
  const resolve = (variable: string, fallback: string): string => {
    const raw = styles.getPropertyValue(variable).trim();
    return raw ? (toHex(raw) ?? fallback) : fallback;
  };
  return {
    background: resolve("--background", "#0a0a0a"),
    foreground: resolve("--foreground", "#fafafa"),
    cursor: resolve("--foreground", "#fafafa"),
  };
}

function toHex(color: string): string | undefined {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.fillStyle = color;
  // An unparseable colour leaves fillStyle at its default, which would silently paint the terminal
  // black on black. Bail instead and let the caller's fallback stand.
  if (context.fillStyle === "#000000" && !/^(#000000|black|rgb\(0, ?0, ?0\))$/i.test(color)) return undefined;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((channel) => (channel ?? 0).toString(16).padStart(2, "0")).join("")}`;
}
