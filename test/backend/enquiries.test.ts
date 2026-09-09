import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  answersFor,
  PendingEnquiries,
  questionsOf,
  type Settle,
} from "../../src/backend/claude/enquiries.ts";
import type { Question } from "../../src/protocol/events.ts";

/**
 * `PendingEnquiries` and its two mappers, without a Claude process.
 *
 * Which is the whole reason it is a module rather than three fields on `ClaudeSession`: that session
 * cannot be constructed without spawning the CLI, so none of this would be reachable from a test
 * there. Same argument as `Subagents`, and the same shape of test.
 */

const INPUT = {
  questions: [
    {
      question: "Which library?",
      header: "Library",
      multiSelect: false,
      options: [{ label: "zod", description: "big" }, { label: "valibot", description: "small" }],
    },
    {
      question: "Which features?",
      header: "Features",
      multiSelect: true,
      options: [{ label: "Caching" }, { label: "Retries" }, { label: "Logging" }],
    },
  ],
};

/** Records what the callback was settled with, so a test can assert it was settled exactly once. */
function recorder(): { settle: Settle; results: Parameters<Settle>[0][] } {
  const results: Parameters<Settle>[0][] = [];
  return { settle: (result) => results.push(result), results };
}

describe("the Enquiries a turn is holding open", () => {
  it("settles an answered one exactly once, and refuses a second answer", () => {
    const pending = new PendingEnquiries();
    const { settle, results } = recorder();
    pending.hold("ask-1", questionsOf(INPUT), INPUT, settle);

    assert.equal(pending.answer("ask-1", [["zod"], ["Caching", "Retries"]]), true);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.behavior, "allow");

    // The ordinary race: a second click, or an answer typed against a stale transcript. Not a fault,
    // and — the part that matters — it must not settle the callback a second time.
    assert.equal(pending.answer("ask-1", [["valibot"], []]), false);
    assert.equal(results.length, 1);
  });

  it("abandons by denying, never by rejecting", () => {
    const pending = new PendingEnquiries();
    const { settle, results } = recorder();
    pending.hold("ask-1", questionsOf(INPUT), INPUT, settle);

    const abandoned = pending.abandon("ask-1", "the turn was aborted");

    assert.deepEqual(abandoned?.map((question) => question.header), ["Library", "Features"]);
    /*
     * A denial and not a rejection, and this is the assertion the whole feature rests on. A rejected
     * callback leaves the CLI with a `tool_use` it never resolved: the turn cannot end, the host
     * never clears `turnInFlight`, and the Agent Session is pinned in `running` for good. A denial
     * is a real tool_result, so the conversation stays complete and a later Revive resumes cleanly.
     */
    assert.equal(results[0]?.behavior, "deny");
    assert.match(
      results[0]?.behavior === "deny" ? results[0].message : "",
      /Continue without it/,
      "the model is being unblocked, not corrected",
    );
  });

  it("abandons every open Enquiry and says which, so each gets its terminal snapshot", () => {
    const pending = new PendingEnquiries();
    const first = recorder();
    const second = recorder();
    pending.hold("ask-1", questionsOf(INPUT), INPUT, first.settle);
    pending.hold("ask-2", questionsOf(INPUT), INPUT, second.settle);

    const abandoned = pending.abandonAll("the session stopped");

    assert.deepEqual(abandoned.map((entry) => entry.askId), ["ask-1", "ask-2"]);
    assert.equal(first.results.length, 1);
    assert.equal(second.results.length, 1);
    // Emptied, so a second teardown pass appends nothing and the transcript says it ended once.
    assert.deepEqual(pending.abandonAll("again"), []);
  });

  it("leaves nothing that can settle into the next turn", () => {
    const pending = new PendingEnquiries();
    const { settle, results } = recorder();
    pending.hold("ask-1", questionsOf(INPUT), INPUT, settle);

    pending.clear();

    assert.equal(pending.answer("ask-1", [["zod"], []]), false);
    assert.equal(pending.describe("ask-1"), undefined);
    // `clear` deliberately does not settle: it is for when the process behind the callback is gone.
    // Anything still reachable must be abandoned first, which is what every teardown path does.
    assert.equal(results.length, 0);
  });
});

describe("reading what a tool call asked", () => {
  it("carries whatever arrived rather than enforcing the schema", () => {
    // Five options and one question, both outside the documented 1–4 / 2–4. Refusing a shape the CLI
    // itself produced would stall a turn over a disagreement about a document.
    const questions = questionsOf({
      questions: [
        {
          question: "Which?",
          header: "Pick",
          options: ["a", "b", "c", "d", "e"].map((label) => ({ label })),
        },
      ],
    });

    assert.equal(questions.length, 1);
    assert.equal(questions[0]?.options.length, 5);
    // Absent `multiSelect` is a single-select, never a guess in the other direction: acting on
    // several answers nobody offered is worse than acting on one.
    assert.equal(questions[0]?.multiSelect, false);
  });

  it("drops what cannot be rendered, and falls back to the question for a missing header", () => {
    const questions = questionsOf({
      questions: [
        { question: "", options: [{ label: "x" }] },
        { question: "Real?", options: [{ label: "" }, { label: "kept" }, { nope: 1 }] },
        "not an object",
      ],
    });

    assert.equal(questions.length, 1, "a question with no text is one nobody could answer");
    assert.equal(questions[0]?.header, "Real?", "a missing header still leaves a printable label");
    assert.deepEqual(questions[0]?.options.map((option) => option.label), ["kept"]);
  });

  it("answers nothing for input that is not an Enquiry at all", () => {
    assert.deepEqual(questionsOf(undefined), []);
    assert.deepEqual(questionsOf({ questions: "no" }), []);
    assert.deepEqual(questionsOf("no"), []);
  });
});

describe("handing answers back to the model", () => {
  const questions: Question[] = questionsOf(INPUT);

  it("keys by question text, and sends a string for one answer and an array for several", () => {
    // Both shapes confirmed against the real CLI in spikes/ask-user-question.ts. A single-select
    // sends a bare string rather than a one-element array, so what the model reads is what a human
    // would have written.
    const updated = answersFor(INPUT, [["zod"], ["Caching", "Retries"]]);

    assert.deepEqual(updated.answers, {
      "Which library?": "zod",
      "Which features?": ["Caching", "Retries"],
    });
  });

  it("carries free text in the same slot, with nothing marking it out", () => {
    const updated = answersFor(INPUT, [["Neither — something I typed"], ["Logging"]]);

    assert.deepEqual(
      (updated.answers as Record<string, unknown>)["Which library?"],
      "Neither — something I typed",
    );
  });

  it("keeps the rest of the input, because the SDK replaces the call's arguments with this", () => {
    const updated = answersFor({ ...INPUT, somethingElse: 7 }, [["zod"], ["Caching"]]);

    assert.equal(updated.somethingElse, 7);
    assert.deepEqual(updated.questions, INPUT.questions);
  });

  it("sends an empty answer rather than dropping the question", () => {
    // The host refuses a short `answers` before it gets here, so this is the defensive shape: a
    // question the model asked always appears in what it reads back, answered or not.
    const updated = answersFor(INPUT, [[], []]);

    assert.deepEqual(updated.answers, { "Which library?": "", "Which features?": [] });
    assert.equal(questions.length, 2);
  });
});
