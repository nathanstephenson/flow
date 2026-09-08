# TODO

Work that is known about and not done. Each entry says enough to be picked up cold: what is wrong or
undecided, where it lives, and why it was left. Anything that turns out to be a decision rather than
a task belongs in `docs/adr/` once it is made.

## Decide whether pi can support Subagents

`src/backend/pi/index.ts` declares `subagents: false`, and pi's event stream carries no parent or
agent identity on any message or tool call — so there is nothing to attribute a Subagent to even if
pi can spawn one.

The obvious route is closed: `createAgentSession`'s `tools` option is `string[]`, a filter over pi's
built-ins, not a place to register a host-side tool. Whether pi exposes a custom-tool or hook surface
under another name is unresolved, and is a documentation question rather than a types one.

Two things to settle before building anything:

- **It breaks the glossary.** CONTEXT.md defines a Subagent as living wholly inside one Backend
  Session. A GoodHarness-implemented one would live in a *second* one, so either the term widens or
  pi's version needs its own name.
- **It moves the agent loop into the daemon.** With Claude the CLI owns the subagent loop and we
  watch. Here we would own it, making retries, timeouts, cancellation and the child's failure modes
  the daemon's problem — a real scope increase for something that currently owns Agent Sessions and
  nothing else.

## Drop straggler events from a Dormant Agent Session

`onBackendEvent` in `src/daemon/host.ts` drops events for a record that is `ended` or `settled`, but
not `dormant`. A late emit from a backend torn down by `shutdown()` can therefore still append to
that session's log *after* `session_dormant`.

Found while auditing message routing. Adjacent to the revive race, but a separate fix, and a small
one.

## Make the transcript key-list check exact

`web/src/store/agent-session-view.ts` decides the key list changed by comparing `entries.length`
alone. That is sound only while the Presentation Transcript is append-only and nothing is reordered,
filtered or removed — and its own comment says it "breaks quietly" otherwise, as a key list that no
longer matches the transcript.

Replace it with an exact signal: a version the reducer bumps only when the *set* of keys changes,
compared instead of the length. The comment then becomes unnecessary rather than load-bearing, which
is the actual goal — a warning is the weakest form of a guarantee.

Touches `src/client/reduce.ts` on the streaming hot path, so measure before and after.

## Get the web components under test

This repo tests pure modules only; there is no component harness. So `SubagentsPane`, the Composer's
Subagent strip, the Agents row and `SubagentEntryView` are verified by running them and nothing else.

Worse, `TranscriptEntry`'s switch returns `undefined` for an unhandled `Entry` kind rather than
failing to compile — so a missing case renders nothing, with no error anywhere. `reduce.ts`, the TUI
and the CLI all make that a compile error; this one file does not.

The cheap half is worth doing on its own: make that switch exhaustive. A harness (jsdom and a
rendering library) is the larger question.

## Sort the Agents list by its own timestamps

`ordered` in `web/src/presentation/subagent-list.ts` sorts by position in the key list — first-seen
order — because when it was written `Entry` carried no time. It does now: a Subagent Entry has
`startedAt` and `endedAt`.

Position and start time agree in practice, since both follow spawn order, so this is tidiness rather
than a bug. But the rows display timestamps the sort does not use, and that will read as broken the
first time they disagree. Sorting finished Subagents by `endedAt` is also what "most recently
finished" would actually mean.

## Decide whether per-Subagent Spend is worth pursuing

Spend is reported per *model*, not per Subagent: `modelUsage` is keyed by model id, so two Subagents
on the same model are indistinguishable in it. "This Subagent cost X" is not derivable from what the
SDK gives us, and the Agents list cannot show a cost per row without inventing an attribution the
backend does not supply. Recorded in ADR 0015.

If it is wanted, the only honest route is accumulating `apiUsage` deltas here and attributing them
via `parent_tool_use_id` — worth a probe first to confirm those deltas are attributable at all.
