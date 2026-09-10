import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { authorisationLabel, PERMISSION_CHOICES } from "../src/client/permission.ts";
import type { PermissionDecision } from "../src/protocol/events.ts";
import type { Authorisation } from "../src/client/reduce.ts";

/**
 * The words both front-ends use about a Permission Prompt.
 *
 * Small, and worth having anyway: two front-ends inventing their own label for "always" is exactly
 * the drift this repo exists to avoid, and one of these assertions is about a *safety* property of a
 * label rather than its wording.
 */

describe("the Permission Prompt's choices", () => {
  it("offers exactly the three decisions the protocol has", () => {
    assert.deepEqual(
      PERMISSION_CHOICES.map((choice) => choice.decision),
      ["allow", "deny", "always"] satisfies PermissionDecision[],
    );
  });

  it("puts Always last, where it cannot be taken for a stronger Allow", () => {
    // Allow first because it is the common answer; Always last because it is the one with an effect
    // outside the turn, and a list that put it second would invite a reader skimming downwards.
    assert.equal(PERMISSION_CHOICES.at(-1)?.decision, "always");
  });

  it("says on the Always label that it is machine-wide", () => {
    const always = PERMISSION_CHOICES.find((choice) => choice.decision === "always");

    /*
     * Load-bearing, not decoration. The Settings are machine-wide (src/protocol/settings.ts) and the
     * hazard that file names is precisely this one: a browser window showing one Scope, inviting a
     * decision that is not scoped to it. Someone clicking Always in a window titled with one project
     * will read it as "in this project" unless the label says otherwise.
     */
    assert.match(always?.label ?? "", /this machine/i);
    // And that it is recoverable, which is the other half of shipping a coarse grant.
    assert.match(always?.description ?? "", /revocable|settings/i);
  });

  it("gives every choice something to read", () => {
    for (const choice of PERMISSION_CHOICES) {
      assert.notEqual(choice.label.trim(), "", `${choice.decision} needs a label`);
      assert.notEqual(choice.description.trim(), "", `${choice.decision} needs a description`);
    }
  });
});

describe("what a tool row says about a decision", () => {
  it("says nothing at all where nobody was asked", () => {
    // The common case by far — pre-approved, or already carrying a Standing Authorisation. Undefined
    // rather than an empty string, so the caller's decision is *is there anything to show*: a
    // front-end that printed something here would suggest a judgement nobody made.
    assert.equal(authorisationLabel(undefined), undefined);
  });

  it("has a word for every state the reducer can produce", () => {
    const states: Authorisation[] = ["asked", "allowed", "always", "denied"];
    for (const state of states) {
      assert.notEqual(authorisationLabel(state), undefined, `${state} needs a label`);
    }
  });

  it("keeps always distinct from allowed", () => {
    // They are not the same thing to a reader scrolling back: one authorised a call, the other
    // authorised every call of that tool on this machine — and the transcript is the only place that
    // ever says which click did that.
    assert.notEqual(authorisationLabel("always"), authorisationLabel("allowed"));
    assert.match(authorisationLabel("always") ?? "", /this machine/i);
  });
});
