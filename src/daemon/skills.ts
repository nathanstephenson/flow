import type { AgentBackend, BackendSession } from "../backend/types.ts";
import type { ScopeSkills } from "../protocol/events.ts";

/**
 * Which Skills a Scope offers, asked without an Agent Session.
 *
 * The sibling of ./models.ts, and for the same reason: the New Agent Session view has to offer a
 * Skill menu for a Scope nobody has created a session in yet, and `skills()` lives on
 * `BackendSession` rather than on `AgentBackend` — there is no session-free path. So this opens a
 * throwaway one, the same device the Summary Model uses (ADR 0020), tools and all off, and disposes
 * of it.
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
 * **Nothing here is cached, which is the whole point.** A Skill directory changes between one
 * keystroke and the next, which is why `BackendSession.skills` is "asked each time rather than
 * cached" and why no transcript ever carries a copy. ADR 0020 already drew this line: `/api/models`
 * is memoised for the daemon's life because entitlements change when an account does, while
 * `/api/branches` beside it is asked fresh because its answer changes outside Flow. Skills are on the
 * `/api/branches` side of that line. The nine seconds is hidden by asking early — the client probes
 * when its Scope field settles, so the spawn overlaps with somebody choosing a backend and typing a
 * first message — rather than by holding an answer that has stopped being true.
 */

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
export async function probeSkills(backend: AgentBackend, scope: string): Promise<ScopeSkills> {
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
  const started = backend.create({ scope, tools: "none", emit: () => {} });
  const session = await within(started, PROBE_TIMEOUT_MS);
  if (session === undefined) {
    void started.then(
      (late) => void late.dispose().catch(() => {}),
      () => {},
    );
    return failure(`${backend.name} did not start in time`);
  }
  if (session instanceof Error) return failure(message(session));

  try {
    /*
     * An adapter whose session has no notion of Skills is a `problem` rather than an empty list, for
     * the reason `ScopeSkills` exists: "this cannot tell you" and "there are none here" are different
     * answers, and only one of them means the reader should stop looking.
     */
    if (!session.skills) return failure(`${backend.name} has no notion of Skills`);
    return { backend: backend.name, scope, skills: await session.skills() };
  } catch (error) {
    return failure(message(error));
  } finally {
    await session.dispose().catch(() => {});
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
