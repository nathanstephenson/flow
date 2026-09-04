/** Commands a client may send to the Session Host. */
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
  | { type: "send"; sessionId: string; text: string; when: SendWhen }
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
  | { type: "list" };
