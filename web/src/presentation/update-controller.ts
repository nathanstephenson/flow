import type { WebUpdateStatus } from "../../../src/protocol/update.ts";
import {
  OPEN_BROWSER_UPDATE_CHECK_MS,
  UPDATE_MUTATION_TIMEOUT_MS,
  UPDATE_RECOVERY_POLL_MS,
  UPDATE_RECONNECT_POLL_MS,
  reconnectView,
  type UpdateViewState,
} from "./update.ts";

export type UpdatesSnapshot = {
  status?: WebUpdateStatus;
  view: UpdateViewState;
  transportError?: string;
};

type UpdateResponse = {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
};

type TimerHandle = unknown;

export type UpdateControllerOptions = {
  getStatus(refresh: boolean): Promise<UpdateResponse>;
  beginUpdate(version: string, signal: AbortSignal): Promise<UpdateResponse>;
  now(): number;
  setTimeout(callback: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
  onSucceeded?(operationId: string): void;
};

type Listener = (snapshot: UpdatesSnapshot) => void;

/**
 * Owns the browser update lifecycle beneath UpdatesProvider. Keeping fetch and timer transitions in
 * one state machine means ambient hourly checks cannot observe a stale React render and disarm an
 * in-progress reconnect.
 */
export class UpdateController {
  private current: UpdatesSnapshot = { view: "checking" };
  private readonly listeners = new Set<Listener>();
  private reconnectingSince: number | undefined;
  private pollTimer: TimerHandle | undefined;
  private pollDelay: number | undefined;
  private hourlyTimer: TimerHandle | undefined;
  private started = false;
  private lifecycleRevision = 0;
  private statusRequestSequence = 0;
  private readonly options: UpdateControllerOptions;

  constructor(options: UpdateControllerOptions) {
    this.options = options;
  }

  get snapshot(): UpdatesSnapshot {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.check(false);
    this.hourlyTimer = this.options.setInterval(() => { void this.check(false); }, OPEN_BROWSER_UPDATE_CHECK_MS);
    this.syncPolling();
  }

  stop(): void {
    this.started = false;
    if (this.hourlyTimer !== undefined) this.options.clearInterval(this.hourlyTimer);
    this.hourlyTimer = undefined;
    this.clearPoll();
  }

  async check(refresh = false): Promise<void> {
    // An ambient check cannot prove that a POST still awaiting its response did not start. The POST
    // has a bounded deadline; after that deadline reconnect polling becomes the only source of truth.
    if (this.current.view === "starting") return;

    const lifecycleRevision = this.lifecycleRevision;
    const requestSequence = ++this.statusRequestSequence;

    // A registry refresh is discovery UI, not a lifecycle transition. Once a mutation might have
    // started, retain reconnect mode until a status response proves what happened.
    if (refresh && !this.operationMayBeRunning()) this.publish({ ...this.current, view: "checking" });

    try {
      const response = await this.options.getStatus(refresh);
      const body = await response.json() as WebUpdateStatus & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Could not check for updates (${response.status})`);
      if (!this.acceptStatusResponse(lifecycleRevision, requestSequence)) return;

      this.reconnectingSince = undefined;
      this.publish({ status: body, view: "ready" });
      if (body.operation?.state === "succeeded") this.options.onSucceeded?.(body.operation.id);
    } catch (error) {
      if (!this.acceptStatusResponse(lifecycleRevision, requestSequence)) return;

      const transportError = errorMessage(error, "Could not reach the Session Host");
      if (!this.operationMayBeRunning()) {
        this.publish({ ...this.current, view: "ready", transportError });
        return;
      }

      this.reconnectingSince ??= this.options.now();
      this.publish({
        ...this.current,
        view: reconnectView(this.reconnectingSince, this.options.now()),
        transportError,
      });
    }
  }

  async begin(confirmedVersion: string): Promise<void> {
    // Every status request already in flight describes the pre-mutation lifecycle. Invalidate those
    // requests before exposing starting so that a late completion cannot disarm reconnect polling.
    this.lifecycleRevision++;
    this.publish(withoutTransportError({ ...this.current, view: "starting" }));

    const abort = new AbortController();
    let timeout: TimerHandle | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeout = this.options.setTimeout(() => {
        reject(new Error("The update request timed out and may have started; reconnecting to verify it"));
        abort.abort();
      }, UPDATE_MUTATION_TIMEOUT_MS);
    });

    let response: UpdateResponse;
    let body: WebUpdateStatus & { error?: string };
    try {
      ({ response, body } = await Promise.race([
        this.readMutationResponse(confirmedVersion, abort.signal),
        timedOut,
      ]));
    } catch (error) {
      this.reconnectingSince = this.options.now();
      this.publish({
        ...this.current,
        view: "reconnecting",
        transportError: errorMessage(error, "The update request may have started; reconnecting to verify it"),
      });
      return;
    } finally {
      if (timeout !== undefined) this.options.clearTimeout(timeout);
    }

    if (!response.ok) {
      this.reconnectingSince = undefined;
      this.publish(withoutTransportError({ ...this.current, view: "ready" }));
      throw new Error(body.error ?? `Could not start the update (${response.status})`);
    }

    this.reconnectingSince = this.options.now();
    this.publish(withoutTransportError({ status: body, view: "reconnecting" }));
  }

  private async readMutationResponse(
    confirmedVersion: string,
    signal: AbortSignal,
  ): Promise<{ response: UpdateResponse; body: WebUpdateStatus & { error?: string } }> {
    const response = await this.options.beginUpdate(confirmedVersion, signal);
    // Losing an accepted response body is just as ambiguous as losing the response headers. Do not
    // retry the POST; reconnect and inspect the durable operation instead.
    const body = await response.json() as WebUpdateStatus & { error?: string };
    return { response, body };
  }

  private acceptStatusResponse(lifecycleRevision: number, requestSequence: number): boolean {
    return lifecycleRevision === this.lifecycleRevision && requestSequence === this.statusRequestSequence;
  }

  private publish(snapshot: UpdatesSnapshot): void {
    this.current = snapshot;
    for (const listener of this.listeners) listener(snapshot);
    this.syncPolling();
  }

  private operationMayBeRunning(): boolean {
    return this.reconnectingSince !== undefined
      || ["updating", "unverified"].includes(this.current.status?.operation?.state ?? "")
      || ["starting", "reconnecting", "recovery-needed"].includes(this.current.view);
  }

  private shouldPoll(): boolean {
    return ["updating", "unverified"].includes(this.current.status?.operation?.state ?? "")
      || this.current.view === "reconnecting"
      || this.current.view === "recovery-needed";
  }

  private syncPolling(): void {
    if (!this.started || !this.shouldPoll()) {
      this.clearPoll();
      return;
    }

    const recoveryNeeded = this.current.view === "recovery-needed" || this.current.status?.operation?.state === "unverified";
    const delay = recoveryNeeded ? UPDATE_RECOVERY_POLL_MS : UPDATE_RECONNECT_POLL_MS;
    if (this.pollTimer !== undefined && this.pollDelay === delay) return;
    this.clearPoll();
    this.pollDelay = delay;
    this.pollTimer = this.options.setTimeout(() => {
      this.pollTimer = undefined;
      this.pollDelay = undefined;
      if (!this.started || !this.shouldPoll()) return;
      void this.check(false).finally(() => this.syncPolling());
    }, delay);
  }

  private clearPoll(): void {
    if (this.pollTimer !== undefined) this.options.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollDelay = undefined;
  }
}

function withoutTransportError(snapshot: UpdatesSnapshot): UpdatesSnapshot {
  const { transportError: _ignored, ...next } = snapshot;
  return next;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
