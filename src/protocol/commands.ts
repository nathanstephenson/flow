/** Commands a client may send to the Session Host. */
import type { IncomingAttachment } from "./attachments.ts";
import type { Capabilities, EffortLevel } from "./events.ts";
import type { Branch } from "./git.ts";

export type SendWhen = "now" | "after_turn";

export type SessionStatus = "idle" | "running" | "dormant" | "settled" | "ended";

export type SessionSummary = {
  id: string;
  scope: string;
  backend: string;
  status: SessionStatus;
  title: string;
  updatedAt: string;
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
   * since tools are pre-approved (ADR 0004) and so the model itself can move the branch. Never
   * polled, so this is the last branch observed rather than a live one.
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
      backend: string;
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
   */
  | { type: "list_skills"; sessionId: string }
  | { type: "list" };
