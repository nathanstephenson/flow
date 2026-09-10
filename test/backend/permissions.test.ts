import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PendingPermissions } from "../../src/backend/claude/permissions.ts";

/**
 * The one rule this class exists for: **every path settles the callback, and nothing rejects.**
 *
 * The failure it guards against is not cosmetic. A dropped `canUseTool` promise leaves the CLI with
 * a `tool_use` it never resolved, so the turn cannot end, the Session Host never clears
 * `turnInFlight`, and the Agent Session is pinned in `running` with no key that unpins it. Every
 * test here is a way that could happen.
 */

/** A recorder in place of the SDK's resolve, so a test can see what was settled and how often. */
function settler() {
  const settled: Array<{ behavior: string; message?: string; input?: unknown }> = [];
  return {
    settled,
    settle: (result: { behavior: "allow"; updatedInput: Record<string, unknown> } | { behavior: "deny"; message: string }) => {
      settled.push(
        result.behavior === "allow"
          ? { behavior: "allow", input: result.updatedInput }
          : { behavior: "deny", message: result.message },
      );
    },
  };
}

describe("pending Permission Prompts", () => {
  it("allows the call with its own input untouched", () => {
    const permissions = new PendingPermissions();
    const first = settler();
    const input = { command: "gt log" };

    permissions.hold("call-1", "Bash", input, first.settle);
    assert.equal(permissions.decide("call-1", "allow"), true);

    assert.deepEqual(first.settled, [{ behavior: "allow", input }]);
    // The same object, not a copy: the SDK replaces the call's arguments with what comes back, so
    // anything reshaped here would be reshaped in the call the model made.
    assert.equal(first.settled[0]?.input, input);
  });

  it("treats always as an allow, because the remembering is somebody else's job", () => {
    const permissions = new PendingPermissions();
    const first = settler();

    permissions.hold("call-1", "mcp__github__create_pull_request", {}, first.settle);
    permissions.decide("call-1", "always");

    assert.equal(first.settled[0]?.behavior, "allow");
  });

  it("denies with something the model can read, and never rejects", () => {
    const permissions = new PendingPermissions();
    const first = settler();

    permissions.hold("call-1", "WebFetch", {}, first.settle);
    permissions.decide("call-1", "deny");

    // A real `tool_result` rather than a dropped promise, which is what keeps the CLI's own
    // conversation record complete — so a later Revive resumes onto a turn with nothing dangling.
    assert.equal(first.settled[0]?.behavior, "deny");
    // Ends "Continue without it": the model is being unblocked, not corrected.
    assert.match(String(first.settled[0]?.message), /Continue without it\.$/);
  });

  it("says nothing to the model about the human", () => {
    const permissions = new PendingPermissions();
    const first = settler();

    permissions.hold("call-1", "WebFetch", {}, first.settle);
    permissions.decide("call-1", "deny");

    /*
     * The refusal is verbatim the adapter's own pre-existing one, and that is deliberate rather than
     * lazy. A model told "the human declined" learns there is somebody in the loop and spends the
     * turn negotiating with them; one told the tool is not enabled moves on. Which human decision
     * produced it belongs in the transcript, where a reader can see it.
     */
    assert.doesNotMatch(String(first.settled[0]?.message), /human|declin|refus|denie/i);
  });

  it("settles exactly once, and reports a second decision as a race", () => {
    const permissions = new PendingPermissions();
    const first = settler();

    permissions.hold("call-1", "Bash", {}, first.settle);
    assert.equal(permissions.decide("call-1", "allow"), true);
    // False rather than a throw: a second click, or a decision made against a transcript older than
    // the Backend Session serving it. The host turns it into a refusal a human can read — and it is
    // also what tells the host to persist nothing, so a stale `always` grants nothing.
    assert.equal(permissions.decide("call-1", "always"), false);
    assert.equal(first.settled.length, 1);
  });

  it("knows nothing about a call it was never holding", () => {
    const permissions = new PendingPermissions();
    assert.equal(permissions.describe("nobody"), undefined);
    assert.equal(permissions.decide("nobody", "allow"), false);
    assert.equal(permissions.abandon("nobody", "whatever"), undefined);
  });

  describe("remembering a refusal for the turn", () => {
    it("refuses the tool again, without asking", () => {
      const permissions = new PendingPermissions();
      const first = settler();

      assert.equal(permissions.isRefused("WebFetch"), false);
      permissions.hold("call-1", "WebFetch", {}, first.settle);
      permissions.decide("call-1", "deny");

      // The whole point: a model that wanted a tool wants it several times, and re-asking the moment
      // someone says no pins the composer on the same question while the model rephrases.
      assert.equal(permissions.isRefused("WebFetch"), true);
    });

    it("remembers nothing about a tool that was allowed", () => {
      const permissions = new PendingPermissions();
      const first = settler();

      permissions.hold("call-1", "WebFetch", {}, first.settle);
      permissions.decide("call-1", "allow");

      assert.equal(permissions.isRefused("WebFetch"), false);
    });

    it("forgets it when the turn ends", () => {
      const permissions = new PendingPermissions();
      const first = settler();

      permissions.hold("call-1", "WebFetch", {}, first.settle);
      permissions.decide("call-1", "deny");
      permissions.clear();

      // A no was about what was being attempted, not about the tool forever. The next turn is a
      // different attempt, and gets asked about again.
      assert.equal(permissions.isRefused("WebFetch"), false);
    });
  });

  describe("abandoning", () => {
    it("denies rather than dropping, and says what it was about", () => {
      const permissions = new PendingPermissions();
      const first = settler();

      permissions.hold("call-1", "Bash", {}, first.settle);
      assert.equal(permissions.abandon("call-1", "the turn was aborted"), "Bash");

      assert.equal(first.settled[0]?.behavior, "deny");
      // Names why, so the model is not left inferring it from a bare refusal.
      assert.match(String(first.settled[0]?.message), /the turn was aborted/);
    });

    it("settles everything open and names each one", () => {
      const permissions = new PendingPermissions();
      const first = settler();
      const second = settler();

      permissions.hold("call-1", "Bash", {}, first.settle);
      permissions.hold("call-2", "WebFetch", {}, second.settle);

      // Named rather than counted, because each one needs its own terminal snapshot in the
      // transcript — otherwise a prompt stays `asked` forever in a replayed transcript and locks
      // the composer on buttons whose promise died with the process.
      assert.deepEqual(permissions.abandonAll("the session stopped"), [
        { callId: "call-1", tool: "Bash" },
        { callId: "call-2", tool: "WebFetch" },
      ]);
      assert.equal(first.settled[0]?.behavior, "deny");
      assert.equal(second.settled[0]?.behavior, "deny");
    });

    it("is safe to call twice, settling nothing the second time", () => {
      const permissions = new PendingPermissions();
      const first = settler();

      permissions.hold("call-1", "Bash", {}, first.settle);
      permissions.abandonAll("the turn was aborted");
      // `endTurn` abandons defensively after the path that got there already has. Costing a second
      // settle would be worse than the belt-and-braces it is there to be.
      assert.deepEqual(permissions.abandonAll("the turn ended"), []);
      assert.equal(first.settled.length, 1);
    });

    it("does not remember an abandonment as a refusal", () => {
      const permissions = new PendingPermissions();
      const first = settler();

      permissions.hold("call-1", "WebFetch", {}, first.settle);
      permissions.abandon("call-1", "the turn was aborted");

      // Nobody refused anything: the turn stopped. Remembering it would silently refuse the tool for
      // the rest of a turn that is already over — and, worse, read as a decision in the transcript.
      assert.equal(permissions.isRefused("WebFetch"), false);
    });
  });

  it("forgets without settling, which is only ever safe once the process is gone", () => {
    const permissions = new PendingPermissions();
    const first = settler();

    permissions.hold("call-1", "Bash", {}, first.settle);
    permissions.clear();

    // Nothing settled, and nothing left to settle. This is the one method that can strand a
    // callback, which is why the adapter always abandons before it clears — the assertion below is
    // the reason that ordering is not optional.
    assert.deepEqual(first.settled, []);
    assert.deepEqual(permissions.abandonAll("too late"), []);
  });
});
