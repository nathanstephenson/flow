import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createCommandFor, type NewAgentSessionForm } from "./new-agent-session.ts";

/**
 * What the New Agent Session form sends, and — mostly — what it refuses to.
 *
 * The worktree clause is the reason this is a function rather than an expression in a submit
 * handler. Getting it wrong cuts a git worktree nobody asked for, off a branch named by an answer
 * about a directory the reader has since typed over.
 */

const form: NewAgentSessionForm = {
  scope: "/work/api",
  backend: "claude",
  modelId: "claude-x",
  effort: undefined,
  inWorktree: false,
  repository: true,
  base: "main",
};

describe("the create Command a New Agent Session form describes", () => {
  it("sends the trimmed Scope, the backend and the chosen model", () => {
    assert.deepEqual(createCommandFor({ ...form, scope: "  /work/api  " }), {
      type: "create",
      scope: "/work/api",
      backend: "claude",
      modelId: "claude-x",
    });
  });

  // The same predicate the Start button is disabled by, which is why there is only one of them.
  it("describes nothing without a Scope", () => {
    assert.equal(createCommandFor({ ...form, scope: "" }), undefined);
    assert.equal(createCommandFor({ ...form, scope: "   " }), undefined);
  });

  it("describes nothing without a Backend Adapter", () => {
    assert.equal(createCommandFor({ ...form, backend: "" }), undefined);
  });

  /*
   * Omitted rather than sent as null. `create.modelId` absent means the host resolves the
   * machine-wide Default Model itself (ADR 0020), which is the right behaviour for the window before
   * `/api/models` has answered — and the composer is inert then anyway.
   */
  it("omits the model where none has resolved yet", () => {
    const command = createCommandFor({ ...form, modelId: undefined });
    assert.equal(command?.modelId, undefined);
    assert.ok(command && !("modelId" in command));
  });

  /*
   * Absent rather than sent as null, for the reason the model is: the backend runs at whatever level
   * it chose for itself, and Claude only reports which in the init message of the first turn.
   */
  it("carries Effort only once somebody has chosen one", () => {
    assert.ok(!("effort" in (createCommandFor(form) ?? {})));
    assert.equal(createCommandFor({ ...form, effort: "high" })?.effort, "high");
  });

  describe("the worktree clause", () => {
    it("cuts from the base branch when the toggle is on and the Scope is a repository", () => {
      assert.deepEqual(createCommandFor({ ...form, inWorktree: true })?.worktree, {
        from: "main",
      });
    });

    it("omits it when the toggle is off", () => {
      assert.equal(createCommandFor(form)?.worktree, undefined);
    });

    /*
     * The case this function exists for. The toggle is only rendered for a repository, but the Scope
     * is free text — so it can be ticked and then typed over, leaving a stale `true` describing a
     * directory that is not a repository at all.
     */
    it("omits it when the toggle is stale because the Scope is no longer a repository", () => {
      assert.equal(
        createCommandFor({ ...form, inWorktree: true, repository: false })?.worktree,
        undefined,
      );
    });

    // Detached HEAD, or the branch list has not answered. Neither is a branch to cut from.
    it("omits it when there is no base branch to cut from", () => {
      assert.equal(
        createCommandFor({ ...form, inWorktree: true, base: "" })?.worktree,
        undefined,
      );
    });
  });
});
