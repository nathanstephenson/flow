import { ArrowUp, ChevronRight, Loader2, Square, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { IncomingAttachment } from "../../../src/protocol/attachments.ts";
import { refusalMessage, refusalsIn, sortPastedItems } from "@/presentation/attachments.ts";
import { composerPlaceholder, sendLabel, subagentStripLabel } from "@/presentation/composer-hint.ts";
import { useCommand } from "@/agent-sessions.tsx";
import type { Chrome } from "@/store/contract.ts";
import { ComposerInput, type ComposerInputHandle } from "@/components/composer-input.tsx";
import { ComposerMenu } from "@/components/composer-menu.tsx";
import { completed, matching, menuQuery, triggerables, triggeredBy } from "@/presentation/composer-menu.ts";
import type { Skill } from "../../../src/protocol/events.ts";
import { TurnStrip } from "@/components/turn-strip.tsx";
import { Button } from "@/components/ui/button.tsx";
import { toast } from "@/components/ui/toaster.tsx";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * Where a message goes in, and what the next turn will cost to run.
 *
 * The pane's header says what this Agent Session *is*; this says what the next turn will *do*. That
 * is why the model, the Effort level, the Conversation Context meter and the branch live here and
 * not up there — every one of them is a property of the message about to be sent rather than of the
 * Agent Session.
 *
 * Two bands, and the split between them is *doing* versus *describing*. The input carries the one
 * control that acts, so the send button sits beside the text rather than below it. Everything that
 * merely describes the next turn — which model, how hard, how much room is left, which branch — is
 * one quiet row underneath (`TurnStrip`), styled as readings rather than as controls.
 *
 * The branch took the most getting to. It reads like identity and was in the header first, but what
 * the control is *for* is the edits this message will cause, which land in that Scope on that
 * branch — so it belongs with the model, not with the Project name.
 *
 * **Nothing here is optimistic.** No user Entry is added locally: it appears because the Session Host
 * appended it to the Presentation Transcript and it arrived over the stream (ADR 0001). No pending
 * list is kept either — the Steering Queue belongs to the host, and its depth comes from
 * `Chrome.queueDepth` and from nothing else (ADR 0002).
 *
 * The honest cost of that is a gap between Enter and the message appearing on a slow send, and it is
 * paid *on the composer* rather than by faking the transcript: the input clears at once, the button
 * spins, and a rejection puts the text back and says why.
 */
export function Composer({
  sessionId,
  chrome,
  onShowSubagents,
}: {
  sessionId: string;
  chrome: Chrome;
  /** Open the Subagents, from the strip. A callback rather than the Docks handle, so the Composer
   * stays ignorant that Docks exist — it knows there is somewhere to go, not where. */
  onShowSubagents: () => void;
}) {
  const run = useCommand();
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [sending, setSending] = useState(false);
  const input = useRef<ComposerInputHandle | null>(null);
  const panel = useRef<HTMLDivElement | null>(null);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [query, setQuery] = useState<string | undefined>(undefined);
  const [highlighted, setHighlighted] = useState(0);

  const ended = chrome.status === "ended";
  const running = chrome.status === "running";
  /*
   * An unknown model counts as one that cannot, which is the safe direction: this is the *positive*
   * check the Session Host cannot make — it has no way to name the model in force when nobody
   * overrode the default — so a paste allowed here on a guess is one nothing downstream will catch.
   * The window is the moment between opening a session and its first `model_changed`, and a replayed
   * transcript closes it before anyone can paste into it.
   */
  const acceptsImages = chrome.model?.acceptsImages === true;

  /*
   * The panel floats over the transcript, so the transcript has to know how tall it is or the last
   * line of every message ends up behind it. Written straight onto the DOM as a custom property
   * rather than held in React state — the same `style.setProperty` idiom web/src/fonts.ts uses —
   * because the input growing by one row must not re-render the transcript to say so.
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

  /*
   * Object URLs are the only thing here React cannot clean up for us, so they are released the
   * moment an attachment leaves the list and on unmount. A leaked one pins the whole image in memory
   * for the life of the tab, which for a run of pasted screenshots is not a rounding error.
   */
  const forget = useCallback((pending: PendingAttachment[]): void => {
    for (const attachment of pending) URL.revokeObjectURL(attachment.url);
  }, []);

  /*
   * The unmount sweep reads a ref rather than closing over the state, and the effect's dependency
   * list is empty on purpose. An effect depending on `attachments` runs its *previous* cleanup every
   * time the list changes, so pasting a second image would revoke the first one's URL and leave a
   * broken thumbnail above the box — which is why this is two effects and not one.
   */
  const live = useRef<PendingAttachment[]>([]);
  useEffect(() => {
    live.current = attachments;
  }, [attachments]);
  useEffect(() => () => forget(live.current), [forget]);

  /*
   * Returns synchronously whether the paste was ours, because that is what decides whether the
   * editor inserts anything — a promise resolves long after the event has been let through. The
   * files themselves are read and attached afterwards. Filtering the clipboard for files is the
   * editor's job now, so this is handed the ones it found.
   */
  const paste = useCallback(
    (files: File[]): boolean => {
      if (!acceptsImages) {
        toast.info("This model cannot be shown an image", chrome.model?.label ?? chrome.model?.id);
        return true;
      }

      const verdicts = sortPastedItems(
        files.map((file) => ({ type: file.type, size: file.size, file })),
        attachments.length,
      );
      for (const refusal of refusalsIn(verdicts)) toast.error(refusalMessage(refusal));

      void Promise.all(
        verdicts
          .filter((verdict) => verdict.accepted)
          .map(async (verdict) => ({
            key: crypto.randomUUID(),
            mediaType: verdict.mediaType,
            data: await base64Of(verdict.item.file),
            url: URL.createObjectURL(verdict.item.file),
          })),
      ).then((accepted) => {
        if (accepted.length > 0) setAttachments((current) => [...current, ...accepted]);
      });
      return true;
    },
    [acceptsImages, attachments.length, chrome.model],
  );

  const catalogue = useMemo(
    () => triggerables(chrome.capabilities?.compaction, skills),
    [chrome.capabilities?.compaction, skills],
  );
  const items = useMemo(
    () => (query === undefined ? [] : matching(catalogue, query)),
    [catalogue, query],
  );

  /*
   * Fetched when the menu first opens, not on mount and not on every keystroke.
   *
   * Reading a Skill directory is a disk listing behind an HTTP round trip, and most sessions never
   * press `/` at all — so paying for it on mount would be paying for it in every pane, forever, to
   * answer a question nobody asked. Re-fetched whenever the menu opens from closed, because the
   * whole point of asking the backend rather than caching is that someone may have just written one.
   */
  useEffect(() => {
    if (query === undefined) return;
    let live = true;
    void run<Skill[]>({ type: "list_skills", sessionId }).then((found) => {
      if (live && found) setSkills(found);
    });
    return () => {
      live = false;
    };
    // Deliberately not `query`: this fires when the menu opens, not as it filters.
  }, [query === undefined, run, sessionId]);

  const remove = useCallback(
    (key: string): void => {
      setAttachments((current) => {
        forget(current.filter((attachment) => attachment.key === key));
        return current.filter((attachment) => attachment.key !== key);
      });
    },
    [forget],
  );

  /*
   * `override` is what lets Enter complete a name and send it in one keystroke: `setText` has not
   * settled by the time this runs, so the completed message is handed in rather than read back out
   * of state that is still a render behind.
   */
  const send = useCallback(async (override?: string): Promise<void> => {
    const message = (override ?? text).trim();
    // An image with no words is a message — "look at this" is what the paste already said.
    if ((message === "" && attachments.length === 0) || sending || ended) return;

    /*
     * A Command is not a message, so it does not become one.
     *
     * This is the whole of the difference the blue pill stands for: nothing is appended to the
     * Presentation Transcript, no turn is started, no model is asked anything. Whatever follows the
     * name is the instruction — `/compact keep the API decisions` — and Attachments are left where
     * they are, since a Command has nowhere to carry them and losing a screenshot to one would be
     * the same theft a refused send is careful to avoid.
     */
    const command = triggeredBy(message, catalogue);
    if (command?.kind === "command") {
      const instructions = message.slice(command.name.length + 1).trim();
      setText("");
      await run({ type: "compact", sessionId, ...(instructions ? { instructions } : {}) });
      return;
    }

    const sent = attachments;
    setText("");
    setAttachments([]);
    setSending(true);
    const result = await run<{ queued?: boolean }>({
      type: "send",
      sessionId,
      text: message,
      ...(sent.length > 0 ? { attachments: sent.map(outgoing) } : {}),
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

    // Put it back rather than lose it. useCommand has already said what went wrong. The attachments
    // go back too, still holding their object URLs — a refused send must not cost someone a
    // screenshot they can no longer reach, since a clipboard has already moved on.
    if (result === undefined) {
      setText(message);
      setAttachments((current) => [...sent, ...current]);
      input.current?.focus();
    } else {
      forget(sent);
    }
  }, [attachments, catalogue, ended, forget, run, sending, sessionId, text]);

  /**
   * Put the highlighted name in the box.
   *
   * `andSend` is the difference between the two keys that pick from this menu, and it is the whole
   * reason there are two. Tab completes and leaves the caret after the name, which is what someone
   * reaching for `/code-review [<pr#>]` wants — its arguments are the point. Enter takes the name
   * as the whole message and goes, which is what someone reaching for `/tdd` wants, and having to
   * press Enter twice for that would be a keystroke spent on nothing.
   */
  const choose = useCallback(
    (item: (typeof catalogue)[number], andSend = false): void => {
      const filled = completed(text, item.name);
      setQuery(undefined);
      if (andSend) {
        void send(filled.text);
        return;
      }
      setText(filled.text);
      input.current?.replace(filled.text, filled.caret);
      input.current?.focus();
    },
    [send, text],
  );

  /*
   * The caret decides whether the menu is open, so it arrives with the text. Reset to the first item
   * on every change: after filtering, the third of five is a different thing than it was, and
   * keeping the index would leave the highlight on whatever happened to land there.
   */
  const onChange = useCallback((next: string, caret: number): void => {
    setText(next);
    setQuery(menuQuery(next, caret));
    setHighlighted(0);
  }, []);

  /*
   * `active` is the *rendered* list rather than the query, which is what makes an unrecognised name
   * fall back to being text. Type `/zzz` and nothing matches, so the menu is not open, so Enter is
   * an ordinary send — no special case for it anywhere, and none needed.
   */
  const menuKeys = useMemo(() => {
    const pick = (andSend: boolean) => (): boolean => {
      const picked = items[highlighted];
      if (!picked) return false;
      choose(picked, andSend);
      return true;
    };
    return {
      active: items.length > 0,
      move: (delta: number) =>
        setHighlighted((current) => (current + delta + items.length) % items.length),
      complete: pick(false),
      submit: pick(true),
      dismiss: () => setQuery(undefined),
    };
  }, [choose, highlighted, items]);

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
        {/*
          * The input and its one action, side by side.
          *
          * The button gets its own box centred against the input rather than sitting in the row of
          * settings below, because it is the only thing here that *does* something — everything in
          * the strip underneath describes what it will do when pressed. Centred rather than pinned
          * to a corner, so it stays beside the text as the box grows.
          */}
        {/*
          * Above the Attachments, so it owns the panel's top edge — the panel has no
          * `overflow-hidden`, so a child has to round its own corners to sit in them.
          *
          * Inside the measured element, not the gradient wrapper around it: the ResizeObserver
          * reports this div's height as `--composer-inset`, so a strip in here pads the transcript
          * clear of itself as it appears and goes away. Outside it, the last line of the transcript
          * would sit behind it.
          */}
        <SubagentStrip chrome={chrome} onShow={onShowSubagents} />

        {/*
          * Above the Attachments and the input both, so the panel grows upward into the transcript
          * rather than pushing the box someone is typing in down the screen. It is inside the
          * measured element, so `--composer-inset` accounts for it as it opens and closes.
          */}
        <ComposerMenu
          items={items}
          highlighted={highlighted}
          onChoose={choose}
          onHighlight={setHighlighted}
        />

        {attachments.length === 0 ? null : (
          <AttachmentTray attachments={attachments} onRemove={remove} />
        )}

        <div className="flex items-center gap-1">
          {/*
            * Enter sends and Shift+Enter is a newline, which is the editor's business now rather
            * than this component's. While a turn runs Enter is the *only* way to reach the Steering
            * Queue, because the button beside it is Abort — which is why the placeholder says so.
            */}
          <ComposerInput
            value={text}
            placeholder={composerPlaceholder(chrome)}
            disabled={ended}
            catalogue={catalogue}
            menu={menuKeys}
            handle={input}
            onChange={onChange}
            onSubmit={() => void send()}
            onPasteFiles={paste}
          />

          <div className="flex shrink-0 items-center pr-2">
            {ended ? null : running ? (
              <AbortButton onAbort={abort} />
            ) : (
              <SendButton
                chrome={chrome}
                sending={sending}
                disabled={text.trim() === "" && attachments.length === 0}
                onSend={send}
              />
            )}
          </div>
        </div>

        <TurnStrip sessionId={sessionId} chrome={chrome} />
      </div>
    </div>
  );
}

/**
 * An Attachment waiting to be sent.
 *
 * Holds both the base64 the command needs and an object URL for the thumbnail, rather than deriving
 * one from the other. A data URL would serve both, but it is the base64 again with a prefix, so
 * every thumbnail would cost a second copy of the whole image in the DOM.
 */
type PendingAttachment = {
  /** React's key. Not the id the Session Host will mint — that does not exist until this is sent. */
  key: string;
  mediaType: IncomingAttachment["mediaType"];
  data: string;
  url: string;
};

function outgoing(attachment: PendingAttachment): IncomingAttachment {
  return { mediaType: attachment.mediaType, data: attachment.data };
}

/**
 * A `File` as base64, without the data-URL prefix.
 *
 * Through FileReader rather than `btoa` over the bytes: the `String.fromCharCode(...bytes)` spread
 * that makes `btoa` usable on an ArrayBuffer overflows the call stack somewhere in the low hundreds
 * of kilobytes, which every screenshot clears.
 */
function base64Of(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`Could not read ${file.type}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * What the session's Subagents are doing, when any of them are doing anything.
 *
 * Above the input because everything *below* it describes the next turn — which model, how hard,
 * how much room is left — while this is a fact about the turn already running. Same reason the
 * Attachments sit up here.
 *
 * Absent entirely when nothing is working, rather than present and empty: this is the only thing in
 * the panel that comes and goes, and a reserved empty row would make the Composer taller for no
 * reason for the whole of a session that never delegates.
 */
function SubagentStrip({ chrome, onShow }: { chrome: Chrome; onShow: () => void }) {
  const label = subagentStripLabel(chrome);
  if (label === undefined) return null;

  return (
    <button
      type="button"
      onClick={onShow}
      className={cn(
        "flex w-full items-center gap-2 rounded-t-xl border-b border-border/40 px-3 py-1.5",
        "text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
    >
      <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-primary" aria-hidden />
      {label}
      <ChevronRight aria-hidden className="ml-auto size-3.5 shrink-0" />
    </button>
  );
}

/**
 * The Attachments this message will carry, above the box rather than below it.
 *
 * Above, because everything below the input describes the *next turn* — which model, how hard, how
 * much room is left — while these are the message itself. Putting them in the `TurnStrip` would file
 * content among readings.
 *
 * Deliberately small. A thumbnail here answers "did the right thing land?" and nothing else; the
 * transcript is where the image is shown at a size worth looking at.
 */
function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 px-3 pt-3">
      {attachments.map((attachment) => (
        <div key={attachment.key} className="group relative">
          <img
            src={attachment.url}
            alt=""
            className="size-14 rounded-md border border-border object-cover"
          />
          <Button
            variant="secondary"
            size="icon"
            aria-label="Remove this attachment"
            onClick={() => onRemove(attachment.key)}
            className={cn(
              "absolute -top-1.5 -right-1.5 size-5 rounded-full shadow",
              // Shown on hover and on focus — keyboard-only removal must not depend on a pointer
              // ever being over the thumbnail.
              "opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
            )}
          >
            <X className="size-3" aria-hidden />
          </Button>
        </div>
      ))}
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
