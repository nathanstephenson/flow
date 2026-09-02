/**
 * The Shell protocol: what a client can ask about a Shell, and the frames that cross its socket.
 *
 * A Shell is addressed by its own id, never by the Agent Session's. It is associated with one for
 * discovery and for lifecycle — Settle, End or Reap the Agent Session and its Shells exit — but it
 * is not identified by one, because an Agent Session may own several.
 */

export type ShellSummary = {
  id: string;
  /** The Agent Session this Shell was opened beside. */
  sessionId: string;
  /** Where the Shell was started. Seeded from the Agent Session's Scope and never updated: the
   *  reader is free to `cd`, and a Shell that silently followed the Scope would undo that. */
  cwd: string;
  createdAt: string;
};

/** Client to Session Host. Keystrokes travel as binary frames; these are the out-of-band ones. */
export type ShellClientFrame = { type: "resize"; cols: number; rows: number };

/**
 * Session Host to client. Shell output travels as binary frames; these are the out-of-band ones.
 *
 * `exit` is the Shell's own death — the process ended, or the Agent Session was Settled — and is
 * distinct from the socket merely closing, which means only that this client stopped watching.
 */
export type ShellServerFrame =
  | { type: "ready"; shell: ShellSummary }
  | { type: "exit"; code: number | undefined; signal: number | undefined };
