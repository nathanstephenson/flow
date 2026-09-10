import type { Command } from "../../../src/protocol/commands.ts";

/**
 * What the New Agent Session form describes, as the Command it would send.
 *
 * Its own DOM-free module for the reason `rail-width.ts` is one: the interesting part is not the
 * controls, it is the three-way rule about when a worktree is actually cut. That rule used to be an
 * expression inline in the submit handler, where nothing could reach it — and getting it wrong cuts a
 * git worktree nobody asked for.
 */

export type NewAgentSessionForm = {
  scope: string;
  backend: string;
  /** Absent until `GET /api/models` answers, which is also what disables the composer. */
  modelId: string | undefined;
  inWorktree: boolean;
  /** Whether the Scope is a repository. Asked, not assumed — the field is free text. */
  repository: boolean;
  /** The branch to cut from: the chosen one, or wherever the repository is now. `""` when unknown. */
  base: string;
};

/**
 * The `create` Command this form describes, or `undefined` where it describes nothing sendable.
 *
 * One function for both, so the Start button's disabled state and the submit path cannot disagree
 * about what is ready — the bug that shape prevents is a button that looks pressable and does
 * nothing.
 */
export function createCommandFor(
  form: NewAgentSessionForm,
): Extract<Command, { type: "create" }> | undefined {
  const scope = form.scope.trim();
  if (scope === "" || form.backend === "") return undefined;

  return {
    type: "create",
    scope,
    backend: form.backend,
    ...(form.modelId === undefined ? {} : { modelId: form.modelId }),
    /*
     * All three conditions, every time.
     *
     * `inWorktree` alone is not enough: the toggle is only rendered for a Scope that is a repository,
     * but the Scope is free text, so it can be typed over *after* the box was ticked. Sending the
     * stale toggle would ask the host to cut a worktree from a directory that is not a repository —
     * or from a branch the answer for the previous Scope named. `base` is empty on a detached HEAD
     * and before the branch list answers, and neither is a branch to cut from.
     */
    ...(form.inWorktree && form.repository && form.base !== ""
      ? { worktree: { from: form.base } }
      : {}),
  };
}
