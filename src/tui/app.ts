import type { Connection } from "../client/connection.ts";
import { effortChoices, modelChoices } from "../client/model-choices.ts";
import { initialState, reduce, type ViewState } from "../client/reduce.ts";
import { sessionLabel } from "../client/session-label.ts";
import { canSettle } from "../client/status.ts";
import type { SessionSummary } from "../protocol/commands.ts";
import {
  answersOf,
  canCommit,
  cursorAfterTyping,
  cursorClamped,
  isFinished,
  rowsFor,
  startAnswering,
  toggled,
  type Answering,
} from "../client/enquiry.ts";
import { PERMISSION_CHOICES } from "../client/permission.ts";
import type { PermissionDecision } from "../protocol/events.ts";
import { isPrintable, KEY, splitKeys } from "./keys.ts";
import { renderFrame, type Overlay, type UiState } from "./render.ts";

/**
 * The terminal client. It speaks only to a Connection — never to a Session Host directly — which is
 * what keeps the TUI and the web UI honest about being the same kind of client.
 */

export type TuiOptions = {
  connection: Connection;
  scope: string;
  backend: string;
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
};

export async function runTui(options: TuiOptions): Promise<void> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;

  let sessions: SessionSummary[] = await options.connection.listSessions();
  let selected: string | undefined = sessions[0]?.id;
  let view: ViewState = initialState();
  let input = "";
  let overlay: Overlay = { kind: "none" };
  /**
   * Where the human is up to in the Enquiry on screen, and which Enquiry that is.
   *
   * The id is held beside the state rather than inferred, so a second Enquiry cannot inherit the
   * first's cursor and half-filled answers — `view.asking` changing identity is the only signal that
   * this is a different question, and comparing the id is how that is noticed.
   */
  let answering: Answering | undefined;
  let answeringFor: string | undefined;
  /** The cursor in the Permission Prompt picker, and which prompt it belongs to. See `answering`. */
  let deciding: number | undefined;
  let decidingFor: string | undefined;
  let notice: string | undefined;
  let unsubscribe: (() => void) | undefined;

  const draw = (): void => {
    const ui: UiState = {
      sessions,
      selected,
      view,
      input,
      overlay,
      ...(answering === undefined ? {} : { answering }),
      ...(deciding === undefined ? {} : { deciding }),
      now: Date.now(),
      ...(notice ? { notice } : {}),
    };
    const frame = renderFrame(ui, { columns: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.write(`[H[2J${frame.join("\r\n")}`);
  };

  const attach = (sessionId: string): void => {
    unsubscribe?.();
    selected = sessionId;
    view = initialState();
    unsubscribe = options.connection.subscribe({
      sessionId,
      since: 0,
      onEntry: (entry) => {
        view = reduce(view, entry);
        draw();
      },
      onError: (error) => {
        notice = error.message;
        draw();
      },
    });
    draw();
  };

  const refreshSessions = async (): Promise<void> => {
    sessions = await options.connection.listSessions();
  };

  const newSession = async (worktree?: { from: string }): Promise<void> => {
    try {
      const id = await options.connection.command<string>({
        type: "create",
        scope: options.scope,
        backend: options.backend,
        ...(worktree === undefined ? {} : { worktree }),
      });
      await refreshSessions();
      attach(id);
    } catch (error) {
      // A worktree the host would not cut leaves no Agent Session at all, so there is nothing to
      // attach to and the reason is all there is to say.
      notice = error instanceof Error ? error.message : "could not start an Agent Session";
    }
  };

  /** The Scope of an Agent Session, for asking git about it. */
  const scopeOf = (sessionId: string | undefined): string | undefined =>
    sessions.find((session) => session.id === sessionId)?.scope;

  /**
   * Open the branch list, having asked for it first.
   *
   * Asked at the moment it is opened rather than held, because it changes outside Flow — the
   * same reason `/api/branches` is a query. A Scope that is not a repository opens nothing and says
   * so, which is this client's version of hiding the control.
   */
  const openBranches = async (purpose: "switch" | "cut", scope: string | undefined): Promise<void> => {
    if (scope === undefined) return;
    let list;
    try {
      list = await options.connection.branches(scope);
    } catch (error) {
      notice = error instanceof Error ? error.message : "could not read branches";
      return;
    }
    if (!list.repository) {
      notice = `${scope} is not a git repository`;
      return;
    }

    const head = list.head?.detached ? undefined : list.head?.name;
    overlay = {
      kind: "branches",
      purpose,
      branches: list.branches,
      index: Math.max(0, head ? list.branches.indexOf(head) : 0),
      ...(head === undefined ? {} : { head }),
    };
  };

  if (selected) attach(selected);
  else await newSession();

  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  stdout.on("resize", draw);

  await new Promise<void>((resolve) => {
    const finish = (): void => {
      unsubscribe?.();
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("[H[2J");
      resolve();
    };

    // Chunks are processed one at a time. handleKey is async, so without this a chunk arriving
    // mid-walk would interleave with the previous one and keys would be applied out of order.
    let pending: Promise<void> = Promise.resolve();
    stdin.on("data", (chunk: string) => {
      pending = pending.then(async () => {
        try {
          for (const key of splitKeys(chunk)) {
            if (await handleKey(key)) {
              finish();
              return;
            }
          }
        } catch (error) {
          notice = error instanceof Error ? error.message : String(error);
          draw();
        }
      });
    });
  });

  /** Returns true when the app should exit. */
  async function handleKey(key: string): Promise<boolean> {
    if (key === KEY.ctrlC) return true;

    if (overlay.kind !== "none") {
      await handleOverlayKey(key);
      draw();
      return false;
    }

    /*
     * An open Enquiry takes the prompt line, and takes it *after* the overlay branch: an overlay
     * opened before the question arrived must still be closable. Nothing below this runs while one
     * is open, which is the lockout — no message is sent, and `^K` is refused rather than silently
     * doing nothing.
     */
    if (view.asking) {
      await handleEnquiryKey(key);
      draw();
      return false;
    }

    /*
     * A Permission Prompt takes the prompt line on the same terms and in the same place — after the
     * overlay branch, above everything else. Nothing below runs while one is open, which is the
     * lockout: the turn is blocked on a callback, so there is nothing a message could reach.
     */
    if (view.authorising) {
      await handlePermissionKey(key);
      draw();
      return false;
    }

    if (key === KEY.ctrlS) {
      await refreshSessions();
      const index = sessions.findIndex((session) => session.id === selected);
      overlay = { kind: "sessions", index: Math.max(0, index) };
    } else if (key === KEY.ctrlP) {
      overlay = { kind: "models", index: 0 };
    } else if (key === KEY.ctrlE) {
      overlay = { kind: "effort", index: Math.max(0, effortChoices(view).indexOf(view.effort ?? "off")) };
    } else if (key === KEY.ctrlG) {
      await openBranches("switch", scopeOf(selected));
    } else if (key === KEY.ctrlK) {
      await compact();
    } else if (key === KEY.escape) {
      if (selected) await options.connection.command({ type: "abort", sessionId: selected });
    } else if (key === KEY.enter || key === KEY.newline) {
      await submit();
    } else if (key === KEY.backspace || key === KEY.backspaceAlt) {
      input = input.slice(0, -1);
    } else if (isPrintable(key)) {
      input += key;
    }

    draw();
    return false;
  }

  /**
   * Drive the Enquiry picker.
   *
   * The order of these branches is the whole rule, and it is the terminal's statement of the one the
   * web client's key module states for the editor: **the moment the box has a character in it, the
   * picker borrows only the keys a prompt line never needed.** The digits and Space are ordinary
   * characters as far as anyone typing is concerned, so they are claimed only while `input` is
   * empty — and both branches sit above the `isPrintable` one that would otherwise swallow them.
   *
   * Escape still aborts, as the status line has always said. The web client gives Escape to "go back
   * a Question" because it has an Abort button to spare; here there is no button, so abort keeps the
   * key and there is no going back. That asymmetry is deliberate and is named in both files.
   */
  async function handleEnquiryKey(key: string): Promise<void> {
    const asking = view.asking;
    if (!asking) return;
    // Restarted whenever the Enquiry changes, so a second question cannot inherit the first's cursor.
    if (!answering || answeringFor !== asking.askId) {
      answering = startAnswering(asking.questions);
      answeringFor = asking.askId;
    }
    const state: Answering = answering;
    const question = asking.questions[state.index];
    if (!question) return;
    const rows = rowsFor(question, input);
    const chosen = state.chosen[state.index] ?? [];

    if (key === KEY.escape) {
      if (selected) await options.connection.command({ type: "abort", sessionId: selected });
      return;
    }
    if (key === KEY.up || key === KEY.down) {
      // Clamped, not wrapped: every list in this TUI clamps, and the web client's every list wraps.
      // Each front-end keeps its own idiom rather than the two of them growing a third.
      state.cursor = cursorClamped(state.cursor, key === KEY.up ? -1 : 1, rows.length);
      return;
    }
    if (input === "" && /^[1-9]$/.test(key)) {
      const row = rows[Number(key) - 1];
      if (!row) return;
      state.cursor = Number(key) - 1;
      if (question.multiSelect) state.chosen[state.index] = toggled(chosen, row.label);
      else await commitAnswer(asking.questions, state, [row.label]);
      return;
    }
    if (input === "" && key === " " && question.multiSelect) {
      const row = rows[state.cursor];
      if (row) state.chosen[state.index] = toggled(chosen, row.label);
      return;
    }
    if (key === KEY.enter || key === KEY.newline) {
      const row = rows[state.cursor];
      const answer = question.multiSelect ? chosen : row ? [row.label] : [];
      if (!canCommit(question, answer)) {
        notice = "choose at least one, or type your own answer";
        return;
      }
      await commitAnswer(asking.questions, state, answer);
      return;
    }

    const had = input.trim() !== "";
    if (key === KEY.backspace || key === KEY.backspaceAlt) input = input.slice(0, -1);
    else if (isPrintable(key)) input += key;
    else return;
    // The cursor follows the typing onto the Other row, so an answer someone typed is not thrown
    // away by an Enter aimed at it. See `cursorAfterTyping` for the trap this closes.
    state.cursor = cursorAfterTyping(state.cursor, had, input.trim() !== "", rowsFor(question, input).length);
  }

  /**
   * Record one Question's Answer and move on — sending the whole Enquiry once the last one is in.
   *
   * One command at the end rather than one per Question, because the backend holds a single promise
   * for the whole tool call. The pacing is this front-end's; the wire sees one answer.
   */
  async function commitAnswer(
    questions: NonNullable<typeof view.asking>["questions"],
    state: Answering,
    answer: string[],
  ): Promise<void> {
    state.chosen[state.index] = answer;
    state.index += 1;
    state.cursor = 0;
    input = "";
    if (!isFinished(state, questions)) return;

    const askId = answeringFor;
    answering = undefined;
    answeringFor = undefined;
    if (!selected || !askId) return;
    try {
      await options.connection.command({
        type: "answer_enquiry",
        sessionId: selected,
        askId,
        answers: answersOf(state, questions),
      });
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
  }

  /**
   * Drive the Permission Prompt picker.
   *
   * Simpler than its Enquiry counterpart by the whole of what made that one hard: nothing is typed
   * here, so there is no box to hold characters and no rule about which keys the picker may borrow
   * once it does. Digits and Enter are unconditionally the picker's.
   *
   * **Escape denies rather than aborting**, which is where this parts company with the Enquiry
   * branch above. Aborting a turn to refuse one tool call is a sledgehammer — a denial is the answer
   * the model can carry on from, and it is the whole reason a Deny is not an Abort. Someone wanting
   * to stop the turn can press it again once the prompt is gone.
   */
  async function handlePermissionKey(key: string): Promise<void> {
    const authorising = view.authorising;
    if (!authorising) return;
    // Restarted whenever the prompt changes, so a second call cannot inherit the first's cursor —
    // which matters more here than for an Enquiry, since a cursor left on Always would put the
    // widest decision under an unsuspecting Enter.
    if (deciding === undefined || decidingFor !== authorising.callId) {
      deciding = 0;
      decidingFor = authorising.callId;
    }

    if (key === KEY.escape) {
      await commitDecision(authorising.callId, "deny");
      return;
    }
    if (key === KEY.up || key === KEY.down) {
      // Clamped, not wrapped: every list in this TUI clamps. See `handleEnquiryKey`.
      deciding = cursorClamped(deciding, key === KEY.up ? -1 : 1, PERMISSION_CHOICES.length);
      return;
    }
    if (/^[1-9]$/.test(key)) {
      const choice = PERMISSION_CHOICES[Number(key) - 1];
      if (!choice) return;
      deciding = Number(key) - 1;
      await commitDecision(authorising.callId, choice.decision);
      return;
    }
    if (key === KEY.enter || key === KEY.newline) {
      const choice = PERMISSION_CHOICES[deciding];
      if (choice) await commitDecision(authorising.callId, choice.decision);
    }
  }

  async function commitDecision(callId: string, decision: PermissionDecision): Promise<void> {
    deciding = undefined;
    decidingFor = undefined;
    if (!selected) return;
    try {
      await options.connection.command({ type: "answer_permission", sessionId: selected, callId, decision });
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
  }

  async function handleOverlayKey(key: string): Promise<void> {
    // Snapshot the overlay: TypeScript cannot narrow a mutable closure variable across a guard.
    const current = overlay;
    if (current.kind === "none") return;

    if (key === KEY.escape) {
      overlay = { kind: "none" };
      return;
    }

    const length =
      current.kind === "sessions"
        ? sessions.length
        : current.kind === "effort"
          ? effortChoices(view).length
          : current.kind === "branches"
            ? current.branches.length
            : modelChoices(view.capabilities).length;

    if (key === KEY.up) {
      overlay = { ...current, index: Math.max(0, current.index - 1) };
      return;
    }
    if (key === KEY.down) {
      overlay = { ...current, index: Math.min(length - 1, current.index + 1) };
      return;
    }
    if (key === "n" && current.kind === "sessions") {
      overlay = { kind: "none" };
      await newSession();
      return;
    }
    if (key === "w" && current.kind === "sessions") {
      // A worktree needs a branch to be cut from, and the TUI has no text entry outside the prompt
      // line — so the base is picked from a list, and the new branch's name is derived by the host.
      await openBranches("cut", options.scope);
      return;
    }
    if (key === "s" && current.kind === "sessions") {
      const chosen = sessions[current.index];
      // A Settled Agent Session has nothing to Settle and an Ended one refuses, so offer neither.
      if (!chosen || !canSettle(chosen.status)) return;
      await options.connection.command({ type: "settle", sessionId: chosen.id });
      await refreshSessions();
      // Stay in the list rather than attaching. Settling is filing something away, not choosing
      // what to work on next, and the settled session has just sunk to the bottom anyway.
      overlay = { kind: "sessions", index: Math.min(current.index, Math.max(0, sessions.length - 1)) };
      notice = `settled ${sessionLabel(chosen)}`;
      return;
    }
    if (key !== KEY.enter && key !== KEY.newline) return;

    if (current.kind === "sessions") {
      const chosen = sessions[current.index];
      overlay = { kind: "none" };
      if (chosen) attach(chosen.id);
      return;
    }

    if (current.kind === "branches") {
      const branch = current.branches[current.index];
      const { purpose } = current;
      overlay = { kind: "none" };
      if (!branch) return;

      if (purpose === "cut") {
        await newSession({ from: branch });
        return;
      }
      if (!selected) return;
      try {
        await options.connection.command({ type: "switch_branch", sessionId: selected, branch });
        notice = `branch → ${branch}`;
      } catch (error) {
        // A refusal carries the reason — a turn in flight, or git's own words about a checkout it
        // would not make — and it is the whole of what is worth showing.
        notice = error instanceof Error ? error.message : `could not switch to ${branch}`;
      }
      return;
    }

    if (current.kind === "effort") {
      const effort = effortChoices(view)[current.index];
      overlay = { kind: "none" };
      if (effort && selected) {
        await options.connection.command({ type: "set_effort", sessionId: selected, effort });
        notice = `effort → ${effort}`;
      }
      return;
    }

    const choice = modelChoices(view.capabilities)[current.index];
    overlay = { kind: "none" };
    if (choice && selected) {
      await options.connection.command({ type: "set_model", sessionId: selected, modelId: choice.model.id });
      notice = `model → ${choice.model.label ?? choice.model.id}`;
    }
  }

  /**
   * Ask the backend to compact the Conversation Context.
   *
   * The refusals live in the Session Host, not here — Dormant, Settled and mid-turn are all 409s
   * with a sentence saying which — so this sends and reports whatever comes back rather than
   * reimplementing that judgement against a `view` that can be a frame behind. The one thing it does
   * check locally is the capability, because a backend that cannot compact at all should say so
   * without a round trip.
   */
  async function compact(): Promise<void> {
    if (!selected) return;
    if (!view.capabilities?.compaction) {
      notice = "this backend cannot compact";
      return;
    }
    try {
      await options.connection.command({ type: "compact", sessionId: selected });
      notice = "compacting…";
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    }
  }

  async function submit(): Promise<void> {
    const text = input.trim();
    if (!text || !selected) return;
    input = "";
    // Always after_turn, never derived from our own status. The Session Host marks a turn in flight
    // when it dispatches rather than when the backend reports turn_started, and only after_turn is
    // guarded by that flag — so a client that believed itself idle on the strength of turn_started
    // would prompt a busy backend and bypass the Steering Queue ADR 0002 exists to own. after_turn
    // already means "queue if busy, else dispatch now", so it is identical in every other case.
    // "now" stays in the protocol for a deliberate interrupt-and-steer, which is not this.
    await options.connection.command({ type: "send", sessionId: selected, text, when: "after_turn" });
  }
}
