import { useEffect, useRef, useState } from "react";
import { FitAddon, Ghostty, Terminal, type ITheme } from "ghostty-web";
import wasmUrl from "ghostty-web/ghostty-vt.wasm?url";

import { FALLBACK_FONTS, fontsReady } from "@/fonts.ts";
import { useHost } from "@/host.tsx";
import { attachShell, killShell, openShell, type ShellConnection } from "@/shell-connection.ts";

/**
 * A Shell, on screen: Ghostty compiled to WASM, fed by a pty in the Session Host.
 *
 * The emulator is a mutable object with its own render loop and its own canvas, so almost nothing
 * here is React state. The bytes never touch a setState — they go from the socket straight into
 * `term.write` — and the one thing that *is* state is the one a human reads rather than types into:
 * why the screen stopped. That is reported upwards too, because the tabs row says it.
 *
 * This is the body of one Dock Tab, and the tab decides what it is for. Unmounting — switching tabs,
 * or minimising the Dock — closes the socket and disposes the emulator without killing the Shell;
 * remounting reattaches and the Session Host replays the Scrollback. Ending a Shell is `killShell`,
 * and only closing the tab does that (ADR 0008).
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

export type ShellStatus = { state: "connecting" } | { state: "live" } | { state: "gone"; why: string };

export type ShellPaneProps = {
  sessionId: string;
  /** Absent means "open one": a tab whose Shell has not been spawned yet. */
  shellId: string | undefined;
  /** The Shell now has an id, so the tab can remember which one is its own. */
  onOpened: (shellId: string) => void;
  onStatus: (status: ShellStatus) => void;
};

export function ShellPane({ sessionId, shellId, onOpened, onStatus }: ShellPaneProps) {
  const mount = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<ShellStatus>({ state: "connecting" });
  const { config } = useHost();
  const monospace = config.fonts?.monospace ?? FALLBACK_FONTS.monospace;

  /*
   * Everything the effect needs but must not restart for.
   *
   * `shellId` in particular: this component reports the Shell it opened, which changes the prop it
   * was given, and re-running on that would dispose the terminal it had just built. A tab's Shell
   * does not change under it otherwise — the tab is keyed by its own id, so a different Shell is a
   * different component.
   */
  const opening = useRef({ shellId, onOpened, onStatus });
  opening.current = { shellId, onOpened, onStatus };

  useEffect(() => {
    const parent = mount.current;
    if (!parent) return;

    // Both the reader and the tabs row are told: the note beside a tab's label is this same status,
    // and the tabs row is where "exited" belongs now that this body has no header of its own.
    const report = (next: ShellStatus): void => {
      setStatus(next);
      opening.current.onStatus(next);
    };

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

      let id = opening.current.shellId;
      if (id === undefined) {
        try {
          // Opened here rather than by the tab because the pty is spawned at the size it will be
          // drawn at, and only this component has measured that.
          const shell = await openShell(sessionId, term.cols, term.rows);
          id = shell.id;
        } catch (error) {
          if (!cancelled) report({ state: "gone", why: error instanceof Error ? error.message : String(error) });
          return;
        }
        if (cancelled) {
          // Unmounted while the pty was being spawned — a StrictMode remount, or a very quick
          // minimise. Nothing knows this Shell's id, so nothing could ever close its tab: end it
          // here rather than leave a pty running with no handle on it.
          void killShell(id);
          return;
        }
        opening.current.onOpened(id);
      }

      connection = attachShell(id, {
        output: (bytes) => term?.write(bytes),
        ready: () => report({ state: "live" }),
        exit: (code) => report({ state: "gone", why: code === 0 ? "exited" : `exited (${code ?? "signal"})` }),
        closed: () => report({ state: "gone", why: "disconnected" }),
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
    // Found by attribute: `keyboard-layer.tsx` asks whether focus is inside one of these, because a
    // keystroke typed at a Shell is text and must not also be a global shortcut.
    <div data-shell-pane="" className="relative min-h-0 overflow-hidden bg-background" aria-label="Shell">
      <div ref={mount} className="size-full" />
      {/* The tabs row carries this too, and deliberately: a reader looking at a stopped screen
          should not have to look away from it to find out why it stopped. */}
      {status.state === "live" ? null : (
        <span className="pointer-events-none absolute top-1 right-2 text-xs text-muted-foreground">
          {status.state === "connecting" ? "connecting…" : status.why}
        </span>
      )}
    </div>
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
