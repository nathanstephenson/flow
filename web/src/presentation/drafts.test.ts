import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  pruneDrafts,
  replaceDraft,
  type Draft,
  type PendingAttachment,
} from "./drafts.ts";

/**
 * The only thing worth testing about a Draft store is which object URLs a change orphaned.
 *
 * Everything else about it is a `Record` lookup. Getting this wrong is invisible from the call site
 * and fails in two directions that both look like something else: revoke too eagerly and thumbnails
 * break after navigating away and back, revoke too late and every pasted screenshot is pinned in
 * memory for the life of the tab.
 */

function attachment(key: string, url = `blob:${key}`): PendingAttachment {
  return { key, mediaType: "image/png", data: "", url };
}

function draft(text: string, ...attachments: PendingAttachment[]): Draft {
  return { text, attachments };
}

describe("replacing a held Draft", () => {
  it("revokes an Attachment the replacement dropped", () => {
    const one = attachment("one");
    const two = attachment("two");
    const { draft: held, revoke } = replaceDraft(draft("hi", one, two), draft("hi", one));

    assert.deepEqual(revoke, ["blob:two"]);
    assert.deepEqual(held.attachments, [one]);
  });

  it("revokes nothing when the Attachments are unchanged", () => {
    const one = attachment("one");
    // The common case by far: text changes on every keystroke while the tray sits still, so a diff
    // that reported the whole list here would revoke a live thumbnail on the next character typed.
    const { revoke } = replaceDraft(draft("h", one), draft("hi", one));

    assert.deepEqual(revoke, []);
  });

  it("revokes nothing when nothing was held yet", () => {
    const { draft: held, revoke } = replaceDraft(undefined, draft("hi", attachment("one")));

    assert.deepEqual(revoke, []);
    assert.equal(held.text, "hi");
  });

  it("revokes every Attachment when the Draft is cleared by a send", () => {
    const { revoke } = replaceDraft(
      draft("hi", attachment("one"), attachment("two")),
      draft(""),
    );

    assert.deepEqual(revoke, ["blob:one", "blob:two"]);
  });

  /*
   * The reason the diff is over URLs and not over keys. This case does not arise today — an
   * Attachment is minted once and never re-URLed — but writing the diff the other way makes it a
   * silent leak the moment it does, and the correct formulation ("which URLs does nothing reference
   * any more") is the shorter one anyway.
   */
  it("revokes the old URL when a key is re-held under a new one", () => {
    const { revoke } = replaceDraft(
      draft("hi", attachment("one", "blob:old")),
      draft("hi", attachment("one", "blob:new")),
    );

    assert.deepEqual(revoke, ["blob:old"]);
  });
});

describe("pruning the Drafts of Agent Sessions that are gone", () => {
  it("forgets an unlisted Agent Session and revokes what it held", () => {
    const { drafts, revoke } = pruneDrafts(
      { live: draft("kept", attachment("a")), reaped: draft("gone", attachment("b")) },
      ["live"],
    );

    assert.deepEqual(Object.keys(drafts), ["live"]);
    assert.deepEqual(revoke, ["blob:b"]);
  });

  it("returns the record it was given when nothing changed", () => {
    // Identity, not equality: this runs on every poll of the Agent Session list, and the caller
    // skips its write when the answer is the same object.
    const held = { live: draft("kept") };
    const { drafts, revoke } = pruneDrafts(held, ["live"]);

    assert.equal(drafts, held);
    assert.deepEqual(revoke, []);
  });

  /*
   * The New Agent Session view's Draft belongs to a session that does not exist yet, so no list of
   * live ids can vouch for it. Without the reserved key a prune would delete the message someone is
   * typing on that very screen.
   */
  it("leaves a reserved key alone though no Agent Session claims it", () => {
    const { drafts, revoke } = pruneDrafts(
      { "new agent session": draft("typing", attachment("a")) },
      [],
      ["new agent session"],
    );

    assert.deepEqual(Object.keys(drafts), ["new agent session"]);
    assert.deepEqual(revoke, []);
  });

  it("forgets everything when no Agent Session is left", () => {
    const { drafts, revoke } = pruneDrafts({ gone: draft("x", attachment("a")) }, []);

    assert.deepEqual(drafts, {});
    assert.deepEqual(revoke, ["blob:a"]);
  });
});
