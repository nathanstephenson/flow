export type WireMessage =
  | { kind: "call"; id: number; method: string; args: unknown[] }
  | { kind: "reply"; id: number; value?: unknown; error?: string }
  | { kind: "cancel"; id: number }
  | { kind: "notification"; name: string; value: unknown };

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Concurrent, bidirectional RPC. Inbound dispatchers must explicitly allowlist their methods. */
export class WorkerRpc {
  private nextId = 0;
  private failure: Error | undefined;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly incoming = new Map<number, AbortController>();
  private readonly send: (message: WireMessage) => void;
  private readonly dispatch: (method: string, args: unknown[], signal: AbortSignal) => Promise<unknown>;
  private readonly notification: (name: string, value: unknown) => void;
  constructor(
    send: (message: WireMessage) => void,
    dispatch: (method: string, args: unknown[], signal: AbortSignal) => Promise<unknown>,
    notification: (name: string, value: unknown) => void,
  ) {
    this.send = send;
    this.dispatch = dispatch;
    this.notification = notification;
  }

  call<T = unknown>(method: string, args: unknown[] = [], signal?: AbortSignal): Promise<T> {
    if (this.failure) return Promise.reject(this.failure);
    if (signal?.aborted) return Promise.reject(new Error("Worker call cancelled"));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const abort = () => {
        this.pending.delete(id);
        try { this.send({ kind: "cancel", id }); } catch {}
        reject(new Error("Worker call cancelled"));
      };
      const cleanup = () => signal?.removeEventListener("abort", abort);
      this.pending.set(id, {
        resolve: (value) => { cleanup(); resolve(value as T); },
        reject: (error) => { cleanup(); reject(error); },
      });
      signal?.addEventListener("abort", abort, { once: true });
      try { this.send({ kind: "call", id, method, args }); }
      catch (error) { this.pending.delete(id); cleanup(); reject(error); }
    });
  }

  notify(name: string, value: unknown): void {
    if (!this.failure) this.send({ kind: "notification", name, value });
  }

  receive(raw: unknown): void {
    if (this.failure || !raw || typeof raw !== "object") return;
    const message = raw as WireMessage;
    switch (message.kind) {
      case "reply": {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error !== undefined) pending?.reject(new Error(message.error));
        else pending?.resolve(message.value);
        break;
      }
      case "cancel": this.incoming.get(message.id)?.abort(); break;
      case "notification": this.notification(message.name, message.value); break;
      case "call": {
        if (!Number.isSafeInteger(message.id) || typeof message.method !== "string" || !Array.isArray(message.args) || this.incoming.has(message.id)) return;
        const controller = new AbortController();
        this.incoming.set(message.id, controller);
        // Deliberately do not queue: prompt may be awaiting an answer from another RPC.
        void Promise.resolve().then(() => this.dispatch(message.method, message.args, controller.signal)).then(
          (value) => this.reply({ kind: "reply", id: message.id, value }),
          (error: unknown) => this.reply({ kind: "reply", id: message.id, error: errorText(error) }),
        ).finally(() => this.incoming.delete(message.id));
        break;
      }
    }
  }

  private reply(message: WireMessage): void {
    if (this.failure) return;
    try { this.send(message); } catch (error) { this.close(new Error(errorText(error))); }
  }

  close(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    for (const controller of this.incoming.values()) controller.abort();
    this.incoming.clear();
  }
}
