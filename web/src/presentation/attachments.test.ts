import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { MAX_ATTACHMENTS_PER_MESSAGE } from "../../../src/protocol/attachments.ts";
import {
  MAX_ATTACHMENT_BYTES,
  refusalMessage,
  refusalsIn,
  sortPastedItems,
  type PastedItem,
} from "./attachments.ts";

const png = (size = 1000): PastedItem => ({ type: "image/png", size });

describe("sorting a paste", () => {
  it("accepts every media type the protocol allows", () => {
    const items = [
      { type: "image/png", size: 1 },
      { type: "image/jpeg", size: 1 },
      { type: "image/gif", size: 1 },
      { type: "image/webp", size: 1 },
    ];
    const verdicts = sortPastedItems(items);
    assert.deepEqual(
      verdicts.map((verdict) => verdict.accepted),
      [true, true, true, true],
    );
  });

  it("refuses anything that is not one of them", () => {
    const [verdict] = sortPastedItems([{ type: "application/pdf", size: 1 }]);
    assert.equal(verdict?.accepted, false);
    assert.equal(verdict?.accepted === false && verdict.refusal, "not-an-image");
  });

  it("refuses an image over the size cap and keeps one at it", () => {
    const [over] = sortPastedItems([png(MAX_ATTACHMENT_BYTES + 1)]);
    assert.equal(over?.accepted === false && over.refusal, "too-large");

    const [at] = sortPastedItems([png(MAX_ATTACHMENT_BYTES)]);
    assert.equal(at?.accepted, true);
  });

  it("refuses past the per-message cap", () => {
    const verdicts = sortPastedItems(Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE + 2 }, () => png()));
    const accepted = verdicts.filter((verdict) => verdict.accepted);
    assert.equal(accepted.length, MAX_ATTACHMENTS_PER_MESSAGE);
    assert.deepEqual(refusalsIn(verdicts), ["too-many"]);
  });

  /*
   * The cap is on the message, not the gesture: two pastes of six are eleven images too, and a
   * composer that counted each paste separately would let twelve through and be refused by the host.
   */
  it("counts what is already pending against the cap", () => {
    const verdicts = sortPastedItems([png(), png()], MAX_ATTACHMENTS_PER_MESSAGE - 1);
    assert.equal(verdicts[0]?.accepted, true);
    assert.equal(verdicts[1]?.accepted === false && verdicts[1].refusal, "too-many");
  });

  /*
   * Regression: the room check used to run before the media-type one, so pasting a screenshot after
   * ten PDFs reported "too many images" — about a paste that contained one image.
   */
  it("does not spend room on items it was never going to accept", () => {
    const items = [
      ...Array.from({ length: MAX_ATTACHMENTS_PER_MESSAGE }, () => ({ type: "text/plain", size: 1 })),
      png(),
    ];
    const verdicts = sortPastedItems(items);
    assert.equal(verdicts.at(-1)?.accepted, true);
    assert.deepEqual(refusalsIn(verdicts), ["not-an-image"]);
  });
});

describe("what a refusal says", () => {
  it("says something different for each cause", () => {
    const messages = (["not-an-image", "too-large", "too-many"] as const).map(refusalMessage);
    assert.equal(new Set(messages).size, 3);
    for (const message of messages) assert.ok(message.length > 0);
  });

  it("collapses a run of one cause to a single reason, and keeps two distinct ones", () => {
    const verdicts = sortPastedItems([
      { type: "text/plain", size: 1 },
      { type: "text/html", size: 1 },
      png(MAX_ATTACHMENT_BYTES + 1),
    ]);
    assert.deepEqual(refusalsIn(verdicts), ["not-an-image", "too-large"]);
  });
});
