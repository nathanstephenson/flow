# TODO

Work that is known about and not done. Each entry says enough to be picked up cold: what is wrong or
undecided, where it lives, and why it was left. Anything that turns out to be a decision rather than
a task belongs in `docs/adr/` once it is made.

## Report pi Spend, including Subagents

`src/backend/pi/index.ts` reports Conversation Context occupancy but no Spend. Subagents now make
model calls in internal SDK sessions (ADR 0022), so reading only the parent's SDK totals would miss
their Spend. Reporting needs to account for both, preserve per-model totals, and carry prior Spend
across Revive without counting any call twice. This was left outside the Enquiry, Subagent, and
Background Call milestone.

## Decide whether pi can be asked before it acts

`src/backend/pi/index.ts` declares `permissions: false`. Custom-tool registration is now confirmed,
but a hook that can hold built-in tools for authorisation is a separate question, not settled by
that finding.

What is true today: pi's adapter has no permission handling at all, and its event union has no
permission or approval member, so `translate()` sees `tool_execution_start` with no pre-execution
hook to hang anything off. So the standing consequence, until this is answered, is an asymmetry worth
naming: **a Claude Agent Session asks before running an unauthorised tool, and a pi one runs it
silently.** Clients hide the affordance on the flag, so nothing breaks — but nothing warns either.

This remains separate from the Enquiry and Subagent milestone.

## Run the two spikes ADR 0018 is still owed

Both are one file beside `spikes/ask-user-question.ts`, and neither blocks anything shipped — the
design is correct either way. They are owed because two things are currently *reasoned about* rather
than measured, which is the standard ADR 0016 set for itself.

- **Does `tool_started` reliably precede the permission callback for a fall-through tool?** This is
  what licenses folding the decision onto the `tool` Entry with `patchTool` instead of giving it an
  Entry of its own: `patchTool` silently no-ops when the row is absent, so an inverted ordering is a
  prompt that vanishes from the transcript. The ~4 ms lead was measured for `AskUserQuestion` and has
  never been measured for anything else.
- **Does the CLI issue concurrent permission requests, or serialise them?** Prompt for two
  non-allowlisted tools in one turn, logging on entry *and* on settle, holding each callback five
  seconds. If the second entry line lands before the first settle line they are concurrent. The
  reducer decides oldest-first either way, so this only settles whether the promotion path is ever
  exercised — and therefore whether it is dead code.

A third, smaller, and the one with something to gain: log `title`, `description`, `suggestions` and
`matchedAskRule` off the callback's options bag on a real fall-through. If the CLI is already writing
prompt text for a human, or already saying *why* it is asking, that beats précising the arguments
ourselves — and `updatedPermissions` on the allow branch is the rule-grained Standing Authorisation
ADR 0018 declined without knowing what it does.

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

## Attribute a Subagent's Permission Prompt to it

`SubagentWait`'s `"permission"` has now been reserved by two decisions — ADR 0015 put it in the union
ahead of the feature, and ADR 0018 shipped the feature without populating it. The blocker is the same
one ADR 0016 recorded: the SDK's permission callback carries an `agentID`, and nothing has ever been
observed filling it in. So `producer` is on the `permission` event and always unset, and a Subagent
blocked on a prompt reports `running` rather than what it is actually waiting for.

Worth one line in whichever spike above gets run: log `agentID` on a fall-through raised from inside
a Subagent. If it is populated, this is a one-line change in the adapter and the union member finally
means something.
