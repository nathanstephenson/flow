import type { Command, SessionSummary } from "../protocol/commands.ts";
import type { LoggedEvent } from "../protocol/events.ts";

/**
 * A client's view of the Session Host. The TUI and the web UI both reach the daemon through this
 * shape, so neither can quietly grow a shortcut into a session object.
 */
export type Connection = {
  command<T = unknown>(command: Command): Promise<T>;
  listSessions(): Promise<SessionSummary[]>;
  /** Replay from `since`, then follow. Returns an unsubscribe. */
  subscribe(options: SubscribeOptions): () => void;
};

/**
 * How the event stream is doing, for a caller that wants to say so. Only "gone" is terminal: the
 * others are stages of a loop that keeps trying, so a UI can distinguish "quiet" from "broken".
 */
export type LinkState = "connecting" | "live" | "retrying" | "gone";

export type SubscribeOptions = {
  sessionId: string;
  since: number;
  onEntry: (entry: LoggedEvent) => void;
  onError?: (error: Error) => void;
  /** Link transitions. Optional, so a caller that does not care needs no change. */
  onLink?: (link: LinkState) => void;
  /**
   * Silence watchdog, defaulting to SILENCE_MS. Overridable so the reconnect path can be tested in
   * milliseconds rather than in three quarters of a minute.
   */
  silenceMs?: number;
};

/** Reconnect backoff floor and ceiling, jittered so several clients do not retry in lockstep. */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 8_000;

/**
 * The Session Host sends no heartbeat, so at this layer a stream that has gone quiet is
 * indistinguishable from an Agent Session with nothing to say. README documents `--address 0.0.0.0`
 * for containers, where a proxy's idle timeout drops a quiet stream without telling either end.
 * Treating silence as death costs one resumed reconnect when the stream was merely idle, and is the
 * only thing that recovers the case where it was real.
 */
const SILENCE_MS = 45_000;

/**
 * Statuses no amount of retrying fixes: the Agent Session does not exist or has been reaped (404),
 * or this client may not read it (401/403 — in the browser, the /auth handoff was never completed
 * or its cookie has gone). Retrying these is a hot loop against a wall, so the link goes "gone".
 */
const FATAL_STATUS = new Set([401, 403, 404]);

export function connect(options: { url: string; token?: string | undefined }): Connection {
  // In the browser there is no token to put in a header: it is the HttpOnly cookie the /auth handoff
  // set, which is the whole reason that handoff exists (ADR 0004). Both of these are spread
  // conditionally rather than assigned `undefined`, because exactOptionalPropertyTypes is on.
  const headers: Record<string, string> = options.token
    ? { authorization: `Bearer ${options.token}` }
    : {};
  const credentials = options.token ? {} : { credentials: "same-origin" as const };

  return {
    async command<T>(command: Command): Promise<T> {
      const response = await fetch(`${options.url}/api/command`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        ...credentials,
        body: JSON.stringify(command),
      });
      if (!response.ok) throw new Error(await describe(response));
      return ((await response.json()) as { result: T }).result;
    },

    async listSessions(): Promise<SessionSummary[]> {
      const response = await fetch(`${options.url}/api/sessions`, { headers, ...credentials });
      if (!response.ok) throw new Error(await describe(response));
      return (await response.json()) as SessionSummary[];
    },

    subscribe({ sessionId, since, onEntry, onError, onLink, silenceMs }: SubscribeOptions): () => void {
      const events = `${options.url}/api/sessions/${encodeURIComponent(sessionId)}/events`;
      const silence = silenceMs ?? SILENCE_MS;
      let lastSeq = since;
      let attempt = 0;
      let stopped = false;
      let stream: AbortController | undefined;
      let wake: (() => void) | undefined;

      const stop = (): void => {
        stopped = true;
        stream?.abort();
        wake?.();
      };

      void (async () => {
        while (!stopped) {
          onLink?.("connecting");
          // One controller per attempt: both the watchdog and stop() abort the *current* stream.
          const controller = new AbortController();
          stream = controller;
          // Whether the abort below was the watchdog's rather than a real fault.
          let silent = false;
          const arm = (): ReturnType<typeof setTimeout> =>
            setTimeout(() => {
              silent = true;
              controller.abort();
            }, silence);
          let watchdog = arm();
          const openedAt = Date.now();
          try {
            // Resume, never replay. `since` is exclusive — SessionLog.since(seq) is slice(seq) —
            // and reduce stamps lastSeq from the entry's own seq, so this is exactly where we left
            // off with no off-by-one. Asking for 0 again would re-append every notice and every
            // Dormant/Settled marker, because their Entry ids are derived from the transcript's
            // length at the time (reduce.ts) and so differ on a second pass over a state that
            // already holds them.
            const response = await fetch(`${events}?since=${lastSeq}`, {
              headers,
              ...credentials,
              signal: controller.signal,
            });
            if (!response.ok || !response.body) {
              const error = new Error(await describe(response));
              if (FATAL_STATUS.has(response.status)) {
                onLink?.("gone");
                onError?.(error);
                return;
              }
              throw error;
            }
            onLink?.("live");
            for await (const entry of readEventStream(response.body)) {
              clearTimeout(watchdog);
              watchdog = arm();
              if (entry.seq > lastSeq) lastSeq = entry.seq;
              onEntry(entry);
            }
            // Falling out of that loop is a lost link too, not an ending: the host closes a stream
            // only when it shuts down or the Agent Session is reaped.
          } catch (error) {
            if (stopped) return;
            // A watchdog abort is this code's own doing, and the reconnect is the whole response to
            // it — reporting it would put "operation aborted" in front of the user every SILENCE_MS
            // that an Agent Session had nothing to say.
            if (!silent) onError?.(error instanceof Error ? error : new Error(String(error)));
          } finally {
            clearTimeout(watchdog);
          }
          if (stopped) return;
          // A link that lasted counts as healthy, so the next drop backs off from the floor again;
          // one that dies on arrival keeps escalating.
          attempt = Date.now() - openedAt >= BACKOFF_MIN_MS ? 1 : attempt + 1;
          onLink?.("retrying");
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, backoffMs(attempt));
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = undefined;
        }
      })();

      return stop;
    },
  };
}

function backoffMs(attempt: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (attempt - 1));
  // Jitter over the upper half of the window: still monotonic in `attempt`, but two clients that
  // dropped together do not come back together.
  return Math.round(ceiling * (0.5 + Math.random() / 2));
}

/** Minimal SSE reader: enough for `id:`/`data:` frames, which is all the host emits. */
async function* readEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<LoggedEvent> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let split = buffer.indexOf("\n\n");
    while (split !== -1) {
      const frame = buffer.slice(0, split);
      buffer = buffer.slice(split + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim())
        .join("");
      if (data) yield JSON.parse(data) as LoggedEvent;
      split = buffer.indexOf("\n\n");
    }
  }
}

async function describe(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return `${response.status} ${response.statusText}${body ? `: ${body}` : ""}`;
}
