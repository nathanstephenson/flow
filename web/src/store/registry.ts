import type { AgentSessionView, AgentSessionViewRegistry } from "./contract.ts";
import { createAgentSessionView, type OwnedAgentSessionView } from "./agent-session-view.ts";
import { host } from "./host.ts";

/**
 * Who owns an Agent Session's view, and for how long.
 *
 * Module-level and ref-counted, because a view owned by a component is a view StrictMode's
 * mount→unmount→mount disposes, and every disposal replays the whole Presentation Transcript from
 * seq 0. The same is true of every look at another Agent Session and back. So: `acquire` starts the
 * transport, `release` only decrements, and the teardown waits out a grace period long enough to
 * cover a remount but short enough that an Agent Session nobody is reading stops streaming.
 */

/** Long enough for a remount, or a quick look at another Agent Session and back. */
export const RELEASE_GRACE_MS = 15_000;

/** Deferred work, injected so a test drives the grace period rather than waiting out fifteen seconds. */
export type Delay = (task: () => void, ms: number) => () => void;

const realDelay: Delay = (task, ms) => {
  const timer = setTimeout(task, ms);
  return () => clearTimeout(timer);
};

export type RegistryOptions = {
  createView?: ((sessionId: string) => OwnedAgentSessionView) | undefined;
  delay?: Delay | undefined;
  graceMs?: number | undefined;
};

type Held = {
  view: OwnedAgentSessionView;
  refs: number;
  cancelTeardown: (() => void) | undefined;
};

export function createAgentSessionViewRegistry(options: RegistryOptions = {}): AgentSessionViewRegistry {
  const createView = options.createView ?? ((sessionId: string) => createAgentSessionView(sessionId, host));
  const delay = options.delay ?? realDelay;
  const graceMs = options.graceMs ?? RELEASE_GRACE_MS;
  const held = new Map<string, Held>();

  return {
    acquire(sessionId: string): AgentSessionView {
      let entry = held.get(sessionId);
      if (!entry) {
        entry = { view: createView(sessionId), refs: 0, cancelTeardown: undefined };
        held.set(sessionId, entry);
        // Here and nowhere else. subscribe() must not do this, or StrictMode starts two transports
        // and the second remount replays the transcript.
        entry.view.start();
      }
      // An acquire inside the grace period is the case this whole arrangement exists for: the view
      // is still live, still reduced, still holding its lastSeq, so the pane comes back with no
      // replay and no flicker.
      entry.cancelTeardown?.();
      entry.cancelTeardown = undefined;
      entry.refs += 1;
      return entry.view;
    },

    release(sessionId: string): void {
      const entry = held.get(sessionId);
      if (!entry) return;
      // Clamped rather than trusted: a double release would otherwise drive the count negative and
      // the view would never be torn down again.
      entry.refs = Math.max(0, entry.refs - 1);
      if (entry.refs > 0 || entry.cancelTeardown) return;
      entry.cancelTeardown = delay(() => {
        // Re-checked because a delay implementation may not be cancellable the instant acquire asks.
        if (entry.refs > 0) return;
        held.delete(sessionId);
        entry.view.stop();
      }, graceMs);
    },
  };
}

/**
 * The app's registry. One per module, not one per render tree — see the note above.
 */
export const agentSessionViews = createAgentSessionViewRegistry();
