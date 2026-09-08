import { canRevive } from "../../../src/client/status.ts";
import type { Chrome } from "../store/contract.ts";

/**
 * What the composer says about the message you are about to send.
 *
 * Copy, but not decoration. Two of these sentences are ADR 0003 and ADR 0006 doing their work in the
 * UI — the next message *is* the Revive, and a Revive starts a Backend Session and spends money — so
 * they are derived here from authoritative `Chrome` fields and unit-tested, rather than assembled
 * inline in a component where nothing would notice them going wrong.
 *
 * The hint used to be a permanent line beneath the composer. It is the placeholder now, which costs
 * no height in a floating panel but disappears the moment you type — so `sendAction` carries the same
 * consequence into the button's tooltip and accessible name, where it survives typing. Queue depth is
 * independently visible as the header's own badge.
 */

/**
 * While a turn is running the button is Abort, so Enter is the only way to add to the Steering Queue.
 * That is a real capability (ADR 0002) reachable by a key nobody would guess at, which makes saying
 * so the placeholder's job rather than a nicety.
 */
export function composerPlaceholder(chrome: Chrome): string {
  if (chrome.status === "ended") {
    return chrome.endedReason === undefined
      ? "This Agent Session has Ended. It will not Revive."
      : `Ended: ${chrome.endedReason}. It will not Revive.`;
  }
  /*
   * Before the status cases, and named rather than left as a generic "running".
   *
   * A compaction takes minutes and produces nothing to read while it works, so a composer that says
   * only "Enter queues it after the current turn" leaves someone who just asked for one wondering
   * which turn that is. This is the report that a compaction had no visible indicator: it had one,
   * a pulsing bar, and a pulsing bar does not answer "did my keystroke do anything".
   */
  if (chrome.compacting) {
    return chrome.queueDepth > 0
      ? `Compacting the Conversation Context… — Enter queues it behind ${chrome.queueDepth}`
      : "Compacting the Conversation Context… — Enter queues your message until it is done";
  }
  if (canRevive(chrome.status)) return "Message… — this Revives the Agent Session";
  if (chrome.status === "running") {
    return chrome.queueDepth > 0
      ? `Message… — Enter queues it behind ${chrome.queueDepth}`
      : "Message… — Enter queues it after the current turn";
  }
  return chrome.queueDepth > 0 ? `Message… — sent behind ${chrome.queueDepth}` : "Message…";
}

/** The accessible name and tooltip for the send button, which is the one place the hint survives typing. */
export function sendLabel(chrome: Chrome): string {
  if (canRevive(chrome.status)) return "Revive this Agent Session and send";
  if (chrome.queueDepth > 0) return `Queue this message behind ${chrome.queueDepth}`;
  return "Send this message";
}

/**
 * What the Composer's strip says while Subagents are working, or undefined when none are.
 *
 * Undefined rather than an empty string, so the caller's decision is "is there a strip" rather than
 * "is the strip's text empty" — the same shape `contextUsageDetail` uses for "nothing honest to
 * say". Waiting counts as working: a Subagent blocked on the provider, a child or a permission
 * prompt has not finished, and a count that excluded it would fall and rise for no visible reason.
 */
export function subagentStripLabel(chrome: Chrome): string | undefined {
  if (chrome.activeSubagents <= 0) return undefined;
  return `${chrome.activeSubagents} agent${chrome.activeSubagents === 1 ? "" : "s"} running`;
}
