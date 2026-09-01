import type { SessionStatus } from "../protocol/commands.ts";

/**
 * The rules both front-ends need for turning a status into affordances. Shared because they are
 * assertions about the Session Host's behaviour, not about any one UI: getting them wrong means
 * offering an action the host will refuse.
 */

/** Nothing to Settle once it is Settled, and an Ended Agent Session cannot be. */
export function canSettle(status: SessionStatus): boolean {
  return status !== "settled" && status !== "ended";
}

/**
 * Dormant and Settled both take a Revive; Ended refuses one outright, and a running or idle Agent
 * Session already has a Backend Session attached (ADR 0003).
 */
export function canRevive(status: SessionStatus): boolean {
  return status === "dormant" || status === "settled";
}

/**
 * A palette token name rather than a colour, so the two front-ends agree on *which* meaning a
 * status carries while each keeps its own idea of what that meaning looks like.
 */
export type StatusTone = "accent" | "ok" | "warn" | "err" | "dim";

export function statusTone(status: SessionStatus): StatusTone {
  switch (status) {
    case "running":
      return "accent";
    case "idle":
      return "ok";
    case "dormant":
      return "dim";
    case "settled":
      return "warn";
    case "ended":
      return "err";
  }
}
