import type { ShellClientFrame, ShellServerFrame, ShellSummary } from "../../src/protocol/shells.ts";

/**
 * The browser's end of one Shell socket.
 *
 * Deliberately not a hook and not React-aware: a terminal is a mutable object that owns a canvas and
 * a render loop, and pretending its byte stream is state would put every frame of `npm run dev`
 * through a re-render. The component owns one of these and feeds the emulator directly.
 *
 * Binary frames are bytes in both directions; text frames are the out-of-band messages
 * (`src/protocol/shells.ts`). No reconnect logic: the socket closing means this client stopped
 * watching, and the caller decides whether to attach again.
 */

export type ShellHandlers = {
  output(bytes: Uint8Array): void;
  ready(shell: ShellSummary): void;
  /** The Shell itself died — the process exited, or its Agent Session was Settled. */
  exit(code: number | undefined, signal: number | undefined): void;
  /** The socket went away without the Shell saying it had. */
  closed(): void;
};

export type ShellConnection = {
  send(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
};

/** `POST /api/shells` — open a new Shell beside an Agent Session, started in its Scope. */
export async function openShell(sessionId: string, cols: number, rows: number): Promise<ShellSummary> {
  const response = await fetch("/api/shells", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionId, cols, rows }),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Could not open a Shell (${response.status})`);
  }
  return (await response.json()) as ShellSummary;
}

/** `GET /api/shells?sessionId=` — the Shells already open beside an Agent Session. */
export async function listShells(sessionId: string): Promise<ShellSummary[]> {
  const response = await fetch(`/api/shells?sessionId=${encodeURIComponent(sessionId)}`, {
    credentials: "same-origin",
  });
  if (!response.ok) return [];
  return (await response.json()) as ShellSummary[];
}

export function attachShell(shellId: string, handlers: ShellHandlers): ShellConnection {
  // Same origin as everything else, so the HttpOnly cookie rides along on the upgrade request and
  // the strict Origin check passes — an upgrade is an ordinary HTTP request until it is not.
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${scheme}//${window.location.host}/api/shells/${shellId}/stream`);
  socket.binaryType = "arraybuffer";

  let shellDied = false;

  socket.addEventListener("message", (event: MessageEvent<ArrayBuffer | string>) => {
    if (typeof event.data !== "string") {
      handlers.output(new Uint8Array(event.data));
      return;
    }
    const frame = JSON.parse(event.data) as ShellServerFrame;
    if (frame.type === "ready") handlers.ready(frame.shell);
    if (frame.type === "exit") {
      shellDied = true;
      handlers.exit(frame.code, frame.signal);
    }
  });

  // `closed` fires only when the Shell did not tell us it was dying, so the caller can tell "you
  // navigated away" from "your shell exited" — they look identical at the socket.
  socket.addEventListener("close", () => {
    if (!shellDied) handlers.closed();
  });

  const tell = (frame: ShellClientFrame): void => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  };

  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(new TextEncoder().encode(data));
    },
    resize: (cols, rows) => tell({ type: "resize", cols, rows }),
    close: () => socket.close(),
  };
}
