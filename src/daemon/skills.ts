import type { AgentBackend, BackendCreateOptions, BackendSession } from "../backend/types.ts";
import type { BackendEvent, ScopeSkills } from "../protocol/events.ts";

/**
 * Which Skills a Scope offers, asked without an Agent Session.
 *
 * The sibling of ./models.ts, and for the same reason: the New Agent Session view has to offer a
 * Skill menu for a Scope nobody has created a session in yet, and `skills()` lives on
 * `BackendSession` rather than on `AgentBackend` — there is no session-free path. So this opens a
 * session, the same device the Summary Model uses (ADR 0020), tools and all off. The caller can
 * keep it warm for the next ask (ADR 0035).
 *
 * **What this costs: measured, and it is not what ./summariser.ts says.** That file's 24–44 seconds
 * times `prompt → turn_ended`, a spawn *and* a full inference round-trip, and its remark about
 * "thirty seconds before it can be asked anything" is true of the *model* path only. Reading a Skill
 * list is a control request, which the CLI answers long before it is ready to be prompted:
 * `ClaudeBackend.create` awaits nothing, and `supportedModels()` next door is documented as
 * answering before the first prompt. **A cold Claude probe against a real CLI took 5.7 seconds**,
 * comfortably under the nine that `PROBE_TIMEOUT_MS` in ./models.ts records for the model list. pi
 * spawns no process at all, its `skills()` being a directory scan, and answers in milliseconds.
 *
 * **No answer is cached.** A Skill directory changes between one keystroke and the next, which is
 * why `BackendSession.skills` is "asked each time rather than cached" and why no transcript ever
 * carries a copy. A kept session is not a kept answer: `skills()` reads the disk again on each ask.
 */

/** A probe session that the host can keep. `dead` is set by an error notice or an eviction. */
export type HeldSession = { scope: string; session: BackendSession; dead: boolean };

/** Create options for a probe session, and the `HeldSession` that its events and eviction update. */
export function probeSession(scope: string, listen: (event: BackendEvent) => void = () => {}) {
  const held = { scope, dead: false } as HeldSession;
  const options: BackendCreateOptions = {
    scope,
    tools: "none",
    emit: (event) => {
      if (event.type === "notice" && event.level === "error") held.dead = true;
      listen(event);
    },
    evict: () => {
      held.dead = true;
      void held.session?.dispose().catch(() => {});
    },
  };
  return { held, options };
}

/** Give a finished probe session to `keep`, or dispose of it when there is no keeper or it is dead. */
export async function release(held: HeldSession, keep: ((held: HeldSession) => void) | undefined): Promise<void> {
  if (keep && !held.dead) keep(held);
  else await held.session.dispose().catch(() => {});
}

/**
 * A backend that has not answered in this long is not going to.
 *
 * The same budget as ./models.ts and for the same reasons, which is why it is stated there rather
 * than argued again here.
 */
const PROBE_TIMEOUT_MS = 45_000;

/**
 * Ask one Backend Adapter which Skills a Scope offers.
 *
 * Never throws, exactly as `probeModels` never throws and `SessionHost.listSkills` never refuses: a
 * backend that cannot answer reports a `problem` and the menu says so. A refusal here must not be
 * able to take down the view that asked.
 */
export async function probeSkills(backend: AgentBackend, scope: string, keep?: (held: HeldSession) => void): Promise<ScopeSkills> {
  const failure = (problem: string): ScopeSkills => ({
    backend: backend.name,
    scope,
    skills: [],
    problem,
  });

  /*
   * `create` is raced, which is the one real departure from `probeModels`.
   *
   * That one leaves `create` unbounded because a stuck probe only makes a Settings page slow. Here
   * the host holds this promise so concurrent askers share one spawn, so a `create` that never
   * resolves would hold every later ask for that Scope behind it. The loser of the race still
   * disposes whatever eventually arrives rather than orphaning a CLI — hence the `then` below and
   * not a dropped reference.
   */
  const { held, options } = probeSession(scope);
  const started = backend.create(options);
  const session = await within(started, PROBE_TIMEOUT_MS);
  if (session === undefined) {
    void started.then(
      (late) => void late.dispose().catch(() => {}),
      () => {},
    );
    return failure(`${backend.name} did not start in time`);
  }
  if (session instanceof Error) return failure(message(session));
  held.session = session;

  let answered = false;
  try {
    /*
     * An adapter whose session has no notion of Skills is a `problem` rather than an empty list, for
     * the reason `ScopeSkills` exists: "this cannot tell you" and "there are none here" are different
     * answers, and only one of them means the reader should stop looking.
     */
    if (!session.skills) return failure(`${backend.name} has no notion of Skills`);
    const skills = await session.skills();
    answered = true;
    return { backend: backend.name, scope, skills };
  } catch (error) {
    return failure(message(error));
  } finally {
    await release(held, answered ? keep : undefined);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The session, an `Error` it rejected with, or `undefined` if it took too long.
 *
 * Three outcomes rather than two because all three are different answers to a reader: a backend that
 * refused can say why, and one that hung can only say that it hung. Clears the timer on the way out
 * either way — see `within` in ./summariser.ts.
 */
function within(
  work: Promise<BackendSession>,
  ms: number,
): Promise<BackendSession | Error | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    void work.then(
      (session) => {
        clearTimeout(timer);
        resolve(session);
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
