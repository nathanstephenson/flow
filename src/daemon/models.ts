import type { AgentBackend } from "../backend/types.ts";
import type { BackendEvent, BackendModels, ModelInfo } from "../protocol/events.ts";

/**
 * Which models a Backend Adapter can actually reach, asked without an Agent Session.
 *
 * This exists because of an awkward fact the Settings run into: **model ids are only known from a
 * live Backend Session**. Claude's list comes from `supportedModels()`, a control request on a
 * running stream; pi's comes off a constructed session's registry. `Capabilities` is declared per
 * Agent Session for exactly that reason, and the New Agent Session dialog already refuses to offer
 * a model because at that moment there is no list.
 *
 * A machine-wide Default Model and Summary Model cannot wait for a session that does not exist yet.
 * So this opens a throwaway one — the same device the Summary Model uses (ADR 0020), tools and all
 * off — reads its Capabilities, and disposes of it.
 */

/**
 * A backend that has not answered in this long is not going to.
 *
 * Generous, because the probes run concurrently and the slow one makes the others slower. Claude
 * spawns its CLI and answers in about nine seconds on its own; pi faults in its whole ESM and
 * native dependency tree on first touch, and at fifteen seconds Claude lost that race on a healthy
 * machine and reported a `problem` — a picker replaced by a text field for no reason but a
 * stopwatch. Somebody who has just opened the Settings will wait half a minute once; they will not
 * forgive being told their backend is broken when it is not.
 */
const PROBE_TIMEOUT_MS = 45_000;

/** The wire shape lives in the protocol, because the Providers section renders it. */
export type { BackendModels };

/**
 * Ask one Backend Adapter what models it can reach.
 *
 * Never throws: a backend that cannot answer reports a `problem`, and its section of the Settings
 * offers a text field instead of a list. A refusal here must not make the whole page unreachable.
 */
export async function probeModels(backend: AgentBackend, scope: string): Promise<BackendModels> {
  let models: ModelInfo[] = [];
  let settle: (() => void) | undefined;
  // Claude reports a provisional Capabilities at create and the real list moments later, over
  // `capabilities_changed` — so waiting for that event rather than reading `session.capabilities`
  // once is what makes the difference between the whole list and a list of one.
  const listed = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const emit = (event: BackendEvent): void => {
    if (event.type !== "capabilities_changed") return;
    models = [...event.capabilities.models];
    settle?.();
  };

  let session;
  try {
    session = await backend.create({ scope, tools: "none", emit });
  } catch (error) {
    return { backend: backend.name, models: [], problem: message(error) };
  }

  try {
    /*
     * A backend that already knows is not waited on.
     *
     * pi and the fake build their whole list before `create` resolves and never emit
     * `capabilities_changed` again, so waiting for one costs the entire timeout and answers with
     * exactly what was on the session all along. Only Claude, which fetches over its control
     * channel after the session is up, has anything to wait for.
     */
    if (session.capabilities.models.length > 0) return { backend: backend.name, models: [...session.capabilities.models] };

    await within(listed, PROBE_TIMEOUT_MS);
    return models.length > 0
      ? { backend: backend.name, models }
      : { backend: backend.name, models: [], problem: `${backend.name} listed no models` };
  } finally {
    await session.dispose().catch(() => {});
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Whichever comes first, clearing the timer either way — see `within` in ./summariser.ts. */
function within(work: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void work.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
