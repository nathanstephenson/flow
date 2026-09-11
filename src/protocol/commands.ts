/** Commands a client may send to the Session Host. */
import type { IncomingAttachment } from "./attachments.ts";
import type { Capabilities, EffortLevel, PermissionDecision } from "./events.ts";
import type { Branch } from "./git.ts";

export type SendWhen = "now" | "after_turn";

/**
 * What an Agent Session is doing, as a reader sees it.
 *
 * Three of these are Lifecycle values reported straight through; `idle`, `running` and `awaiting`
 * are derived, and exist only while the Lifecycle is `live`. Widening this union is a silent
 * behaviour change everywhere a caller compares against one member, so reach for the predicates in
 * `client/status.ts` rather than writing `=== "running"` by hand.
 */
export type SessionStatus = "idle" | "running" | "awaiting" | "dormant" | "settled" | "ended";

/**
 * What the Session Host writes down, as opposed to what it works out.
 *
 * The cut is which facts a restart preserves. Dormant, Settled and Ended survive one and mean
 * something afterwards; whether a turn was in flight does not, because ADR 0003 drops any turn the
 * restart tore. So the Lifecycle is stored and the activity is derived from it — a wrong activity
 * draws a wrong dot until the next event, while a wrong Lifecycle reaps a transcript on a timer.
 *
 * `live` is never on the wire: a live Agent Session reports its activity instead.
 */
export type SessionLifecycle = "live" | "dormant" | "settled" | "ended";

export type SessionSummary = {
  id: string;
  scope: string;
  backend: string;
  status: SessionStatus;
  title: string;
  /**
   * When this Agent Session last came to rest — the time its row prints, and what orders the rail
   * *within* a band. Which band it is in comes from `railBand`, not from here.
   *
   * Stamped when the derived activity enters `idle`, and at no other time. Deliberately not
   * `updatedAt`, which every streamed token restamps and which therefore floated whichever Agent
   * Session was busiest to the top of the rail on each poll, reordering the list under a reader
   * trying to follow it.
   *
   * Awaiting does not stamp it, though it is equally its owner's turn: the band already puts it at
   * the top, and stamping would mean a turn that hit two un-authorised tools jumped the running
   * band on its way back out.
   */
  restingAt: string;
  /**
   * How many Subagents are running or waiting, whatever the status says.
   *
   * A second signal rather than part of the status, because ADR 0016 fixed that a backgrounded
   * Subagent is not occupancy: it does not hold the Steering Queue, and the Agent Session really is
   * `idle` — the model is idle, and steering into it works. But there is still work happening, and
   * a rail with no way to say so reads as though nothing is.
   */
  activeSubagents: number;
  /**
   * How many Background Calls are running, whatever the status says (ADR 0021).
   *
   * Here for the reason `activeSubagents` is, and a second number rather than added into it because
   * the two are shown in different places: `activeSubagents` drives the Subagents surface, and a
   * backgrounded `Bash` counted there would promise a card in a pane that has none. What they share
   * is `working()`, which is the one question that does not care which of them is busy.
   */
  activeBackgroundCalls: number;
  /**
   * When this Agent Session was Settled, and so what the retention window is measured from
   * (ADR 0006). Absent unless `status` is `settled`.
   *
   * Its own field rather than `updatedAt`, which used to serve here: every command that touches a
   * Settled Agent Session restamped that, so opening one and changing its model silently granted it
   * another full window.
   */
  settledAt?: string;
  lastSeq: number;
  capabilities?: Capabilities;
  /**
   * The branch this Agent Session's Scope is on, as of the last time the Session Host looked.
   *
   * **Absent means the Scope is not a git repository**, which is how a client hides the branch
   * control rather than offering one that fails on click — the rule Capabilities already sets for
   * backends, applied to a fact about a directory rather than about an adapter. It is not on
   * Capabilities itself because that is what a *Backend Adapter* can be asked to do, and folding
   * git in would have three adapters answering a question about a directory none of them looked at.
   *
   * Read when there is reason to — at create, on Revive, after a switch, and at the end of a turn,
   * since the tools that can move a branch are pre-approved (ADR 0004) and so the model itself can
   * do it without being asked. Never polled, so this is the last branch observed rather than a live
   * one.
   */
  branch?: Branch;
  /**
   * Set when this Scope is a worktree the Session Host made, rather than a directory its owner
   * named.
   *
   * Carried so a client can name the Project: a worktree Scope is `<repo>/<branch>`, and a header
   * showing only the last segment would name the branch twice and drop the repository. A flag
   * rather than the repository's name, because the name is already in the Scope — sending it too
   * would be a second source of truth about where an Agent Session lives, able to disagree with
   * the first.
   */
  worktree?: true;
};

export type Command =
  | {
      type: "create";
      scope: string;
      /** Omitted means the Session Host's current Default Backend. */
      backend?: string;
      modelId?: string;
      effort?: EffortLevel;
      /**
       * Start this Agent Session in a fresh worktree instead of in `scope` itself.
       *
       * `scope` then names the *repository* to cut from, and the Scope the Agent Session ends up
       * bound to is the worktree — which the caller cannot predict, because the branch name is
       * derived. It is still bound for the session's whole life; a worktree is a Scope chosen at
       * birth, never a Scope switched into later.
       *
       * `from` is an existing branch the client picked. `branch` overrides the derived name and is
       * the web client's alone: the TUI has no text entry outside its prompt line, so it never
       * sends one, and nothing it cannot do is hidden behind this field.
       */
      worktree?: { from: string; branch?: string };
    }
  | {
      type: "send";
      sessionId: string;
      text: string;
      when: SendWhen;
      /**
       * Attachments to carry with this message, as base64 rather than as ids.
       *
       * The bytes ride on the command because there is no upload endpoint to have put them at an id
       * beforehand — a paste the human never sends should not leave anything behind, and one they do
       * send should reach the Session Host in the same act. The host writes each one down and mints
       * the id, which is why `user_message` carries ids and this does not.
       *
       * The web client's alone, like `create.worktree.branch` and for the same reason: a terminal
       * has no clipboard image to paste, so the TUI never sends one and nothing it cannot do is
       * hidden behind this field.
       */
      attachments?: IncomingAttachment[];
    }
  | { type: "steer_queued"; sessionId: string; messageId: string }
  | { type: "cancel_queued"; sessionId: string; messageId: string }
  | { type: "abort"; sessionId: string }
  | { type: "revive"; sessionId: string }
  | { type: "dispose"; sessionId: string }
  | { type: "settle"; sessionId: string }
  | { type: "set_model"; sessionId: string; modelId: string }
  | { type: "set_effort"; sessionId: string; effort: EffortLevel }
  /**
   * `switch_branch` rather than `set_branch`: `set_model` and `set_effort` set a property the host
   * holds and the next turn reads, whereas this moves someone's working tree on disk. Borrowing
   * git's own verb costs nothing and stops the command reading as bookkeeping.
   */
  | { type: "switch_branch"; sessionId: string; branch: string }
  /**
   * Move a **Scope's** checkout, with no Agent Session in it yet.
   *
   * The New Agent Session view's branch picker, which is a chooser rather than a reading: somebody
   * deciding where a session will run may want the checkout somewhere else before it starts, and
   * until it exists there is no `sessionId` to say so through.
   *
   * Keyed by Scope rather than folded into `switch_branch` above, because the two differ in what
   * they can promise. That one refuses while a turn is in flight and rides a note along with the
   * next message so the model knows its files moved. This one has no turn to check and no
   * conversation to tell — so where an Agent Session is *already* bound to the Scope, it moves the
   * tree under it and says so only by the branch on its rail row changing. That is a real hazard and
   * it is the caller's to weigh, which is why the view spells it out beside the control.
   */
  | { type: "switch_scope_branch"; scope: string; branch: string }
  /**
   * Name this Agent Session again, with the Summary Model, from what its transcript now holds
   * (ADR 0020). Answers the new title.
   *
   * **Occupies nothing.** It reads the Presentation Transcript rather than the Conversation Context
   * (ADR 0001), so unlike every command above it opens no turn, and unlike `compact` or `send` it
   * does not Revive a Dormant Agent Session to do its work (ADR 0003). The model call happens in a
   * throwaway Backend Session elsewhere.
   *
   * No `title` field: a hand-typed name is not offered, and a field nothing sends is one that will
   * be wrong the day something does. Adding one later is compatible.
   */
  | { type: "rename"; sessionId: string }
  /**
   * Compact the Conversation Context now, rather than waiting for the backend to do it when the
   * window fills.
   *
   * A command of its own rather than a `/compact` a human types into `send`, because the Session
   * Host does not treat message text as a string it must preserve byte for byte: `dispatch` may add
   * a branch-change note to it, and `userContent` moves it behind any Attachments. A command hidden
   * in that payload would work until the turn someone switched branch, and then silently become a
   * paid turn asking the model about the word "/compact" — recorded forever in an append-only
   * transcript, and titling the Agent Session if it were the first message.
   *
   * It still *occupies* the session the way a send does, because it spends money and holds the
   * backend for minutes. That is the host's `turnInFlight`, set here as `dispatch` sets it.
   *
   * `instructions` steer what the summary keeps. Both backends take them; neither requires them.
   */
  | { type: "compact"; sessionId: string; instructions?: string }
  /**
   * The Skills this Agent Session's Scope offers, for the composer's menu.
   *
   * A fetch and not an event, and nothing about it is ever written down. Skills are read off disk
   * and change whenever someone edits a file, so a copy carried on `Capabilities` would be embedded
   * in `session_started` — a line of an append-only transcript, stale from the first edit and stale
   * in every session at once. It is also only ever wanted after a deliberate keystroke, which is the
   * difference between this and the model list: nobody sees a Skill without asking for one.
   *
   * Keyed by `sessionId` because that is what makes it free: the Backend Session is already running,
   * so the answer is a directory listing away. The Scope with no Agent Session in it yet — the New
   * Agent Session view — is answered by `GET /api/skills` instead, which has to open a Backend
   * Session to ask and so is a different enough thing to be a route rather than a member here.
   * Neither caches, so nothing above contradicts it.
   */
  | { type: "list_skills"; sessionId: string }
  /**
   * Answer an Enquiry the model asked, whole.
   *
   * **Not a `send`.** An Enquiry is answered inside the turn that asked it and the Agent Session is
   * `running` the whole time it waits — so `after_turn` would queue the answer behind a turn that
   * cannot end until it arrives, and `now` would steer a paid message into a model blocked on a tool
   * result. One of those two deadlocks, which is why this is a command of its own for the reason
   * `compact` is: what it carries is not message text and must not be treated as any.
   *
   * `answers` is index-aligned with the Enquiry's own `questions` and must carry one entry per
   * Question, because the backend holds a single promise for the whole tool call. Answering it in
   * parts would need a fourth state — asked, but partly filled — recorded in an append-only
   * Presentation Transcript for no reader's benefit. Pacing the Questions one at a time is a
   * rendering decision and stays in the front-ends.
   *
   * The inner array is the labels chosen, or the human's own words where no option fitted. Nothing
   * distinguishes the two: the Options are in the transcript beside this, so a reader can see.
   *
   * **Refused rather than Revived** when there is no Backend Session, which is the one place this
   * parts company with `send` and `compact`. Those carry something still meaningful afterwards; a
   * Revive attaches a *fresh* Backend Session, and the promise this would resolve died with the old
   * one — so reviving here would start a process and spend money to answer nothing.
   */
  | { type: "answer_enquiry"; sessionId: string; askId: string; answers: string[][] }
  /**
   * Authorise, or refuse, one tool call held open on a Permission Prompt.
   *
   * Its own command for every reason `answer_enquiry` is one — it is not message text, the session is
   * `running` the whole time it waits, and it is **refused rather than Revived** because the promise
   * it settles died with the Backend Session that held it.
   *
   * `callId` is the tool call's own id, which is what a client read off the `permission` event. One
   * decision settles one call: there is no partial state to record, and no arity to check.
   *
   * `always` is the one member with an effect outside the turn. It authorises this call *and* grants
   * a Standing Authorisation for the tool — a Setting, and so a fact about every Agent Session on the
   * machine rather than about this one. A client offering it must say so in the label, because the
   * hazard `Settings` names is exactly this: a browser window showing one Scope inviting a decision
   * that is not scoped to it.
   */
  | { type: "answer_permission"; sessionId: string; callId: string; decision: PermissionDecision }
  | { type: "list" };
