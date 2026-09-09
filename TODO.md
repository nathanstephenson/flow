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
  Session. A Flow-implemented one would live in a *second* one, so either the term widens or
  pi's version needs its own name.
- **It moves the agent loop into the daemon.** With Claude the CLI owns the subagent loop and we
  watch. Here we would own it, making retries, timeouts, cancellation and the child's failure modes
  the daemon's problem — a real scope increase for something that currently owns Agent Sessions and
  nothing else.

## Decide whether pi can ask its human anything

`src/backend/pi/index.ts` declares `enquiries: false`, and the reason is the one already written
above for Subagents: `createAgentSession`'s `tools` option is a `string[]` filter over pi's built-ins,
not a place to register a host-side tool, so there is nowhere to put an equivalent of the Claude
SDK's `AskUserQuestion`.

The protocol is ready for it either way — `answerEnquiry` is optional on `BackendSession` and paired
with the capability flag, so a pi adapter that found a channel would need the method and the flag and
nothing else. What is unresolved is whether pi has such a channel at all, which is the same
documentation question the Subagent entry above is waiting on, and worth answering once for both.

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

The cheap half of this is done: `TranscriptEntry`'s switch is exhaustive now, so a missing `Entry`
kind is a compile error rather than a row that renders nothing. It caught the compaction marker's
missing tone on the first build. A harness (jsdom and a rendering library) is the larger question,
and it is what the components above still want.

`ComposerEnquiry` joins the list, and it is now the strongest case of the lot. Its animation, the
remembered-rows-on-close trick it borrows from `ComposerMenu`, the cursor jumping to the Other row on
the first typed character, and `aria-activedescendant` tracking a cursor that lives in another element
are all things only a rendered DOM and a real key event can show. The rules underneath are pure and
tested — `enquiry-keys.test.ts` and `test/enquiry.test.ts` between them cover which keys are borrowed
and what an answer contains — and `composer-extensions.test.ts` pins the keymap's precedence. What is
untested is that any of it is wired to anything.

`ComposerInput` is now the sharpest case for one, and it has already made the argument itself: it
shipped with its placeholder installed both directly and in a compartment, so reconfiguring it drew
a second placeholder over the first. Typecheck, the build and 681 tests all passed; a person looking
at the box found it. Everything else it carries fails the same way — a composing IME owning Enter, an
image paste being consumed rather than inserted, a controlled value pushed back into an uncontrolled
editor without resetting the selection mid-word, `[data-composer-input]` staying findable for
`focus-pane`.

The cheap half of *that* is now done too. `EditorState.create` needs no DOM, so
`composer-extensions.test.ts` builds the real editor headlessly and asserts on facets: that the
menu's keymap is the first group CodeMirror consults, and that exactly one placeholder is installed
before and after a reconfigure. Both were verified to fail when the original bugs are put back.

What is still uncovered is everything needing layout, focus or a real key event — the IME guard, the
paste path, the pill's appearance, the height cap. That is the harness, and it is still the larger
question.

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
