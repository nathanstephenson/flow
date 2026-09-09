import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  answerLines,
  answersOf,
  canCommit,
  cursorAfter,
  cursorAfterTyping,
  cursorClamped,
  rowsFor,
  startAnswering,
  toggled,
} from "../src/client/enquiry.ts";
import type { Question } from "../src/protocol/events.ts";

const LIBRARY: Question = {
  header: "Library",
  question: "Which library?",
  multiSelect: false,
  options: [{ label: "zod", description: "big" }, { label: "valibot", description: "small" }],
};

const FEATURES: Question = {
  header: "Features",
  question: "Which features?",
  multiSelect: true,
  options: [{ label: "Caching" }, { label: "Retries" }, { label: "Logging" }],
};

describe("the rows an Enquiry offers", () => {
  it("is the Options alone until something is typed", () => {
    assert.deepEqual(rowsFor(LIBRARY, "").map((row) => row.label), ["zod", "valibot"]);
    assert.deepEqual(rowsFor(LIBRARY, "   ").map((row) => row.label), ["zod", "valibot"]);
  });

  it("appends the typed answer as a row of its own, last", () => {
    const rows = rowsFor(LIBRARY, "  neither, actually  ");

    assert.deepEqual(rows.map((row) => row.label), ["zod", "valibot", "neither, actually"]);
    assert.equal(rows.at(-1)?.other, true);
    /*
     * Appended rather than prepended, which keeps the digits stable: `1` is the first Option whether
     * or not anyone has started typing, so a number read off the screen a moment ago still means
     * what it meant.
     */
    assert.equal(rows[0]?.label, "zod");
  });
});

describe("where the cursor goes", () => {
  it("wraps on the web and clamps in the terminal", () => {
    // Each front-end keeps its own idiom rather than the two of them growing a third.
    assert.equal(cursorAfter(0, -1, 3), 2);
    assert.equal(cursorAfter(2, 1, 3), 0);
    assert.equal(cursorClamped(0, -1, 3), 0);
    assert.equal(cursorClamped(2, 1, 3), 2);
  });

  it("survives an empty list, which is a state the picker can legitimately be in", () => {
    assert.equal(cursorAfter(0, 1, 0), 0);
    assert.equal(cursorClamped(0, 1, 0), 0);
  });

  it("follows the typing onto the Other row, and comes back off it", () => {
    /*
     * The trap this closes, stated: type an answer nobody offered, press Enter, and without this the
     * Option the cursor happened to be resting on is what gets sent. The human's own words are
     * discarded in favour of a choice they never made — silently, in a decision they were asked to
     * make.
     */
    assert.equal(cursorAfterTyping(0, false, true, 3), 2, "onto the new last row");
    assert.equal(cursorAfterTyping(2, true, false, 2), 1, "back inside the list when the text goes");
  });

  it("leaves the cursor alone once it is already there", () => {
    // Someone who types a note and *then* picks an Option meant to pick the Option.
    assert.equal(cursorAfterTyping(0, true, true, 3), 0);
  });
});

describe("choosing and committing", () => {
  it("toggles a label in and out, keeping the order they were picked in", () => {
    assert.deepEqual(toggled(["Caching"], "Retries"), ["Caching", "Retries"]);
    assert.deepEqual(toggled(["Caching", "Retries"], "Caching"), ["Retries"]);
  });

  it("refuses an empty multiSelect and allows everything else", () => {
    // An empty set would reach the model as an answer that says nothing while looking like consent.
    assert.equal(canCommit(FEATURES, []), false);
    assert.equal(canCommit(FEATURES, ["Caching"]), true);
    assert.equal(canCommit(LIBRARY, []), true, "a single-select always has the cursor on something");
  });

  it("produces one entry per Question, in order, whatever was answered", () => {
    const questions = [LIBRARY, FEATURES];
    const state = startAnswering(questions);
    state.chosen = [["zod"], ["Caching", "Logging"]];

    assert.deepEqual(answersOf(state, questions), [["zod"], ["Caching", "Logging"]]);
  });

  it("still answers every Question when one was skipped", () => {
    // The host refuses a short `answers`, so the arity has to hold here rather than at the wire.
    const questions = [LIBRARY, FEATURES];
    assert.equal(answersOf(startAnswering(questions), questions).length, 2);
  });
});

describe("what a reader sees afterwards", () => {
  it("names each decision beside what was chosen", () => {
    assert.deepEqual(answerLines([LIBRARY, FEATURES], [["zod"], ["Caching", "Retries"]]), [
      "Library — zod",
      "Features — Caching, Retries",
    ]);
  });

  it("says so when there was no answer, rather than printing a blank", () => {
    assert.deepEqual(answerLines([LIBRARY], undefined), ["Library — no answer"]);
    assert.deepEqual(answerLines([LIBRARY], [[]]), ["Library — no answer"]);
  });
});
