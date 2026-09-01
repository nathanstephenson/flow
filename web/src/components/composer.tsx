import { useCallback, useRef, useState } from "react";

import { canRevive } from "@client/status.ts";
import { useCommand } from "@/agent-sessions.tsx";
import type { Chrome } from "@/store/contract.ts";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Where a message goes in.
 *
 * **Nothing here is optimistic.** No user Entry is added locally: it appears because the Session Host
 * appended it to the Presentation Transcript and it arrived over the stream (ADR 0001). No pending
 * list is kept either — the Steering Queue belongs to the host, and its depth comes from
 * `Chrome.queueDepth` and from nothing else (ADR 0002).
 *
 * The honest cost of that is a gap between Enter and the message appearing on a slow send, and it is
 * paid *on the composer* rather than by faking the transcript: the textarea clears at once, the
 * button says so, and a rejection puts the text back and says why. The UI this replaces threw a
 * failed command into an unhandled rejection, so a refused send looked exactly like a slow one.
 */
export function Composer({ sessionId, chrome }: { sessionId: string; chrome: Chrome }) {
  const run = useCommand();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);

  const ended = chrome.status === "ended";

  const send = useCallback(async (): Promise<void> => {
    const message = text.trim();
    if (message === "" || sending || ended) return;

    setText("");
    setSending(true);
    const result = await run<{ queued?: boolean }>({
      type: "send",
      sessionId,
      text: message,
      /*
       * Always `after_turn`, never `now`.
       *
       * `after_turn` already means "queue if a turn is in flight, else dispatch now", so this is
       * identical to deriving `when` from the status in every non-racy case and correct in the racy
       * one: the host sets `turnInFlight` before the backend acknowledges the turn, so a client that
       * believes it is idle can send `now` into a busy backend and jump the Steering Queue that
       * ADR 0002 exists to own. `now` is a real, tested interrupt — it is simply not what a plain
       * send means.
       */
      when: "after_turn",
    });
    setSending(false);

    // Put it back rather than lose it. useCommand has already said what went wrong.
    if (result === undefined) {
      setText(message);
      textarea.current?.focus();
    }
  }, [ended, run, sending, sessionId, text]);

  return (
    <div className="border-t border-(--color-line) bg-(--color-surface) px-3 py-2">
      <div className="flex items-end gap-2">
        <textarea
          ref={textarea}
          value={text}
          rows={1}
          disabled={ended}
          placeholder={ended ? "This Agent Session has Ended." : "Message…"}
          onChange={(event) => {
            setText(event.target.value);
            // Auto-grow, capped. A composer that can swallow the transcript is not a composer.
            const element = event.target;
            element.style.height = "auto";
            element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
          }}
          onKeyDown={(event) => {
            /*
             * Enter sends, Shift+Enter is a newline — and a composing IME owns Enter outright. Without
             * that last check, committing a CJK candidate also sends the message, which is a real bug
             * and not a theoretical one.
             */
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
          className={cn(
            "min-h-7 flex-1 resize-none rounded-sm border border-(--color-line) bg-(--color-inset) px-2 py-1",
            "font-mono text-base text-(--color-fg-strong) placeholder:text-(--color-fg-faint)",
            "focus:border-(--color-line-strong) disabled:opacity-60",
          )}
        />

        {ended ? null : (
          <Button variant="accent" size="sm" disabled={sending || text.trim() === ""} onClick={() => void send()}>
            {sending ? "sending…" : chrome.status === "running" ? "Queue" : "Send"}
          </Button>
        )}
      </div>

      <SteeringHint chrome={chrome} />
    </div>
  );
}

/**
 * What Enter is about to do, said *before* it is pressed, from authoritative data only.
 *
 * The Revive case is the one that matters: ADR 0003's one-action rule is that the next message *is*
 * the Revive, so this is a statement of consequence and not a prompt. There is no confirm step and no
 * Revive button beside it — that affordance lives in the pane's overflow menu and nowhere else,
 * because a Revive starts a Backend Session and spends money.
 */
function SteeringHint({ chrome }: { chrome: Chrome }) {
  const hint = ((): string => {
    if (chrome.status === "ended") {
      return chrome.endedReason === undefined
        ? "Ended. It will not Revive."
        : `Ended: ${chrome.endedReason}. It will not Revive.`;
    }
    if (canRevive(chrome.status)) return "Your message Revives this Agent Session.";
    if (chrome.status === "running") {
      return chrome.queueDepth > 0
        ? `Sent after the current turn, behind ${chrome.queueDepth}.`
        : "Sent after the current turn.";
    }
    return chrome.queueDepth > 0 ? `Sent after the current turn, behind ${chrome.queueDepth}.` : "Enter sends, Shift+Enter for a newline.";
  })();

  return <p className="mt-1 m-0 font-sans text-2xs text-(--color-fg-faint)">{hint}</p>;
}
