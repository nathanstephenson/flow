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

export type SubscribeOptions = {
  sessionId: string;
  since: number;
  onEntry: (entry: LoggedEvent) => void;
  onError?: (error: Error) => void;
};

export function connect(options: { url: string; token: string }): Connection {
  const headers = { authorization: `Bearer ${options.token}` };

  return {
    async command<T>(command: Command): Promise<T> {
      const response = await fetch(`${options.url}/api/command`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) throw new Error(await describe(response));
      return ((await response.json()) as { result: T }).result;
    },

    async listSessions(): Promise<SessionSummary[]> {
      const response = await fetch(`${options.url}/api/sessions`, { headers });
      if (!response.ok) throw new Error(await describe(response));
      return (await response.json()) as SessionSummary[];
    },

    subscribe({ sessionId, since, onEntry, onError }: SubscribeOptions): () => void {
      const controller = new AbortController();
      void (async () => {
        try {
          const response = await fetch(
            `${options.url}/api/sessions/${encodeURIComponent(sessionId)}/events?since=${since}`,
            { headers, signal: controller.signal },
          );
          if (!response.ok || !response.body) throw new Error(await describe(response));
          for await (const entry of readEventStream(response.body)) onEntry(entry);
        } catch (error) {
          if (controller.signal.aborted) return;
          onError?.(error instanceof Error ? error : new Error(String(error)));
        }
      })();
      return () => controller.abort();
    },
  };
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
