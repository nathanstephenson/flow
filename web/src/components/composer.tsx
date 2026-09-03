import { ArrowUp, Loader2, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { EffortLevel } from "../../../src/protocol/events.ts";
import { composerPlaceholder, sendLabel } from "@/presentation/composer-hint.ts";
import { useCommand } from "@/agent-sessions.tsx";
import type { Chrome } from "@/store/contract.ts";
import { ContextUsageMeter } from "@/components/context-usage-meter.tsx";
import { EffortPicker, ModelPicker } from "@/components/model-picker.tsx";
import { Button } from "@/components/ui/button.tsx";
import { toast } from "@/components/ui/toaster.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Where a message goes in, and what the next turn will cost to run.
 *
 * The pane's header says what this Agent Session *is*; this says what the next turn will *do*. That
 * is why the model, the Effort level and the Conversation Context meter live here and not up there —
 * all three are properties of the message about to be sent, not of the Agent Session.
 *
 * **Nothing here is optimistic.** No user Entry is added locally: it appears because the Session Host
 * appended it to the Presentation Transcript and it arrived over the stream (ADR 0001). No pending
 * list is kept either — the Steering Queue belongs to the host, and its depth comes from
 * `Chrome.queueDepth` and from nothing else (ADR 0002).
 *
 * The honest cost of that is a gap between Enter and the message appearing on a slow send, and it is
 * paid *on the composer* rather than by faking the transcript: the textarea clears at once, the
 * button spins, and a rejection puts the text back and says why.
 */
export function Composer({ sessionId, chrome }: { sessionId: string; chrome: Chrome }) {
  const run = useCommand();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);

  const ended = chrome.status === "ended";
  const running = chrome.status === "running";

  /*
   * The panel floats over the transcript, so the transcript has to know how tall it is or the last
   * line of every message ends up behind it. Written straight onto the DOM as a custom property
   * rather than held in React state — the same `style.setProperty` idiom web/src/fonts.ts uses —
   * because a textarea growing by one row must not re-render the transcript to say so.
   */
  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const pane = element.closest<HTMLElement>("[data-pane]");
    if (!pane) return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) pane.style.setProperty("--composer-inset", `${entry.contentRect.height}px`);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      pane.style.removeProperty("--composer-inset");
    };
  }, []);

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

  const abort = useCallback((): void => {
    const dropped = chrome.queueDepth;
    void run({ type: "abort", sessionId }).then(() => {
      // Aborting means stop, not stop-then-continue, so the queue goes with it. Saying exactly what
      // was discarded is the difference between a stop and a surprise.
      toast.info(
        dropped > 0 ? `aborted · ${dropped} queued message${dropped === 1 ? "" : "s"} discarded` : "aborted",
      );
    });
  }, [chrome.queueDepth, run, sessionId]);

  return (
    /*
     * The gradient is what makes floating legible: transcript text scrolling up fades into the
     * background instead of colliding with the panel's edge. `pointer-events-none` on the wrapper so
     * the faded strip is not a dead zone over a scrollable document — the panel turns them back on.
     */
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-0 px-3 pt-8 pb-3",
        "bg-gradient-to-t from-background via-background to-transparent",
      )}
    >
      <div
        ref={panel}
        className={cn(
          "pane-measure pointer-events-auto",
          "rounded-xl border bg-card/85 shadow-lg backdrop-blur-sm",
        )}
      >
        <textarea
          ref={textarea}
          value={text}
          // Three rows rather than one, so the box looks like somewhere a paragraph goes. It is also
          // the auto-grow floor: `height: auto` resolves to the rows-based height, and scrollHeight
          // never reports less than that, so clearing the text returns here rather than to one line.
          rows={3}
          disabled={ended}
          placeholder={composerPlaceholder(chrome)}
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
             *
             * While a turn runs this is the *only* way to reach the Steering Queue, because the
             * button beside it is Abort. That is why the placeholder says so.
             */
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            void send();
          }}
          className={cn(
            // Sans, matching what the message becomes: a user Entry renders as markdown in the chrome
            // font, and composing against a monospace grid only to watch it reflow on send is a small
            // lie about what you wrote.
            "w-full resize-none bg-transparent px-3 pt-3 pb-1 text-sm outline-none",
            "placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          )}
        />

        <div className="flex items-center gap-1.5 px-2 pb-2">
          <ModelPicker
            capabilities={chrome.capabilities}
            model={chrome.model}
            disabled={ended}
            onSelect={(modelId) => void run({ type: "set_model", sessionId, modelId })}
          />
          <EffortPicker
            capabilities={chrome.capabilities}
            model={chrome.model}
            effort={chrome.effort}
            disabled={ended}
            onSelect={(effort: EffortLevel) => void run({ type: "set_effort", sessionId, effort })}
          />

          <div className="ml-auto flex items-center gap-1.5">
            <ContextUsageMeter usage={chrome.contextUsage} />
            {ended ? null : running ? (
              <AbortButton onAbort={abort} />
            ) : (
              <SendButton chrome={chrome} sending={sending} disabled={text.trim() === ""} onSend={send} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Abort takes the send button's place while a turn runs rather than sitting beside it, so there is
 * one control in one position and no guessing which of two adjacent buttons is about to fire.
 *
 * Steering is not lost with it: `send` is still bound to Enter, and the placeholder says so for as
 * long as the turn lasts. `--destructive` is one of the three things this palette spends colour on,
 * and discarding a queue someone typed is worth it.
 */
function AbortButton({ onAbort }: { onAbort: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label="Abort the current turn"
            className="text-destructive hover:text-destructive"
            onClick={onAbort}
          />
        }
      >
        <Square aria-hidden />
      </TooltipTrigger>
      <TooltipContent>Abort the current turn — this also discards the Steering Queue</TooltipContent>
    </Tooltip>
  );
}

/**
 * An arrow, not a word — but the word it replaced carried state ("Send" against "Queue"), so that
 * meaning moves into the accessible name and the tooltip, where it survives the placeholder being
 * typed over. The spinner is the promise in this file's header kept: the gap before a message appears
 * is shown here rather than papered over in the transcript.
 */
function SendButton({
  chrome,
  sending,
  disabled,
  onSend,
}: {
  chrome: Chrome;
  sending: boolean;
  disabled: boolean;
  onSend: () => Promise<void>;
}) {
  const label = sendLabel(chrome);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon"
            aria-label={label}
            disabled={sending || disabled}
            onClick={() => void onSend()}
          />
        }
      >
        {sending ? <Loader2 className="animate-spin" aria-hidden /> : <ArrowUp aria-hidden />}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
