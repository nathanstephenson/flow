# 16. An Enquiry is answered inside the turn that asked it

Date: 2026-09-09

## Status

Accepted.

## Context

The Claude Agent SDK offers `AskUserQuestion`: the model poses one to four multiple-choice questions
and the tool call does not return until they are answered. Until now the Claude adapter denied it
along with everything else outside its allowlist, so a model that wanted to ask its human something
was told the tool was unavailable.

Serving it is the first time Flow holds a turn open on a person. Everything else the harness
waits for is a machine and comes back on its own: a model call returns, a compaction finishes, a
Subagent ends. A human may take five minutes, or may close the laptop.

Two facts from `spikes/ask-user-question.ts`, both confirmed against the real CLI, shape what follows:

- The permission callback carries a required `toolUseID`, and it is the id of the `tool_use` block on
  the assistant message — which arrives about four milliseconds *earlier*.
- The tool result the model reads back is **prose**: `The user answered: "…"="zod", …`. The structure
  of what was chosen does not survive the round trip.

## Decision

**An Enquiry is answered inside the turn that asked it, whole, and every path that ends that turn
settles the callback.**

Four things follow, and they are the decision:

**It is keyed by the tool call that asked it.** `askId` is the `toolUseID`, so an Enquiry needs no id
space of its own — the rule ADR 0015 sets for a Subagent, available here for the same reason. The
`enquiry` Entry and the `tool` Entry are two views of one thing, and the front-ends drop the tool row
by the mechanism that already drops a Subagent's spawning call.

**It is answered in one act.** The SDK resolves the entire tool call with a single `updatedInput`, so
there is one promise and one answer. Answering question-by-question would need a fourth state —
asked, but partly filled — recorded in an append-only Presentation Transcript for no reader's benefit.
Pacing the questions one at a time is a rendering decision and stays in the front-ends, which both do
it; the wire sees one `answer_enquiry`.

**What was chosen is carried on the Enquiry's own snapshot**, not read back from the tool result. The
result is prose, so a front-end rendering an answered Enquiry from the tool call alone would be
parsing an English sentence to recover what its own user clicked.

**Nothing revives to answer one.** `send` and `compact` both Revive a Dormant Agent Session, because
what they carry is still meaningful afterwards. An answer is not: it resolves a promise held by a
Backend Session that no longer exists, so reviving would start a process and spend money to answer
nothing. The command is refused, and the transcript already carries the `aborted` snapshot saying why.

## Consequences

**A turn can always end.** Abort, stream error, `dispose`, the host tearing a backend down, and a
daemon restart each settle or close every open Enquiry — the adapter by *denying* the callback, the
host by appending a terminal snapshot derived from the transcript. Denial rather than dropping is what
leaves the CLI's own conversation record complete: a real `tool_result` against the right id, so a
later Revive resumes onto a turn with no dangling `tool_use`. This was verified end to end, not
reasoned about — a session torn down mid-Enquiry revives and takes a normal turn.

**There is no timeout, deliberately.** A timer that abandoned an Enquiry someone was still reading
would be worse than one that waits. Abort is the escape, and both front-ends make an open Enquiry
impossible to miss: the composer is locked to answering it and says so.

**`asking` is cleared by five different events**, not only by the Enquiry's own terminal snapshot but
by `turn_ended`, `session_dormant`, `session_settled` and `session_ended`. A torn turn that left it
set would lock the composer with no key that unlocks it — the one failure of this feature a human
could not recover from without reloading.

**pi serves Enquiries through a Flow-owned `ask_question` custom tool.** Its execution waits for
`answerEnquiry` and releases the wait on the SDK's abort signal. Disposal waits for abort to finish
before disconnecting, so the SDK saves the cancelled tool result rather than restoring a missing
result on Revive. `test/backend/pi-enquiries.test.ts` verifies this against the installed SDK with
a local model endpoint. The capability is false and the answer method is absent when the tool is
disabled, including Summary Model calls. Enquiries remain parent-only for the first pi milestone (ADR 0022).

**The one-shot CLI runner aborts an Enquiry rather than waiting on one.** It takes a single prompt and
has no input at all, so waiting would hang forever — which reads as a slow model rather than as a
question. It prints what was asked and how to resume the session somewhere it can be answered.

**A Subagent's Enquiry is not yet attributable.** The callback carries an `agentID`, but nothing has
been observed populating it, so `producer` is carried on the event and left unset. `SubagentWait`'s
`"permission"` — reserved by ADR 0015 ahead of exactly this — is what a Subagent blocked on one
reports, once there is something to report.
