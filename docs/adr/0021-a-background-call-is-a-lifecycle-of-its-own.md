# A Background Call is a lifecycle of its own

A tool call the CLI goes on running past the turn that made it — a `Bash` with `run_in_background`,
a `Monitor` — gets a `background_call` event, an Entry kind, a card in the transcript, a count on
`SessionSummary` and a place in the rail's working Band. It is detected by `system`/`task_started`
carrying a `tool_use_id` that is not a Subagent's, closed by the `task_notification` or
`task_updated` that reports it settled, and bookkept in `src/backend/claude/background-calls.ts`.

This answers the question ADR 0016 left open in as many words: *"Whether a background task that is
not a Subagent deserves a lifecycle Entry of its own is a separate decision, and this one does not
make it."* It does now, and the answer is yes.

CONTEXT.md gains **Background Call**: a tool call the Backend Session goes on running past the turn
that made it, reporting back into a later one. It owns no conversation and produces no Entries of
its own, which is what separates it from a Subagent — the other thing that outlives its turn.

## Why anything at all

An Agent Session that backgrounds a forty-five-second `Bash` reads as finished. The model is idle,
which is true and which ADR 0016 was right to keep saying; but the tool row above says `complete`,
because the launch succeeded, and there is nothing anywhere claiming work is in flight. ADR 0016
recorded this gap ("no card, so there is nothing on screen between launch and report") and deferred
it because that decision was about occupancy, not about surfaces.

The trigger for deciding it now was the rail's status dot learning to go blue for a working Agent
Session. Once background Subagents lifted the dot, a backgrounded `Bash` not lifting it stopped
being an omission and became an inconsistency.

## The detector is `task_started`, and the obvious alternative does not work

`spikes/background-call-messages.ts` captured both cases against CLI 2.1.247. The receipt-shaped
detector — reuse `isAsyncLaunch`, which reads `status` off `tool_use_result` — is not merely
unreliable here, it is unavailable:

    Bash    tool_use_result={"stdout":"","stderr":"",…,"backgroundTaskId":"b0m1k9r1r"}
    Monitor tool_use_result={"taskId":"bqi5g1ccj","timeoutMs":3600000,"persistent":false}

Neither carries `status` at all, and the two do not agree on what they do carry —
`backgroundTaskId` against `taskId`. A detector reading the receipt would need to know both
spellings, and a third for the next tool: **a tool-name allowlist wearing a different hat**, which
is precisely what ADR 0016 built `Subagents.noteTask`'s refusal to avoid.

`task_started` is uniform. Both runs produced the same shape — `task_id` and `tool_use_id` on one
`system` message, for a plain tool call — so *"a `task_started` whose `tool_use_id` is not a
Subagent's"* is the whole detector and reads no tool-specific field. It also confirms ADR 0016's
passing assertion that these calls "settle through the same messages", which had never been
captured.

Three captured details shape the code rather than decorate it. `task_started` arrives **before** the
launching `tool_result` (9.2s against 9.3s), so `BackgroundCalls.noteTask` must accept a `callId` it
has only seen announced. The settle arrives **twice** — `task_updated` first, carrying no
`tool_use_id` at all, then `task_notification` — so the `task_id`→`callId` map is not a convenience
and `settled()` returning undefined the second time is load-bearing rather than defensive. And
`system`/`background_tasks_changed` brackets both events carrying neither id, so there is nothing on
it to key on.

## Routing on `describe`, not on what `background()` returns

`settleTask`, `task_started` and the launch path all ask the same question — is this callId a
Subagent's? — and all three ask it as `Subagents.describe(callId) !== undefined`.

The tempting alternative is to route on `Subagents.background(callId)`, which already answers
`undefined` for a call that is not a Subagent's. It also answers `undefined` for one that *is* but
held no turn end, and ADR 0016 records that releasing a held end is a no-op in practice — so that is
the common case, and routing on it would have dropped the card for nearly every launch. The bug
would have looked like a flaky feature rather than a wrong predicate.

`Subagents` is unedited by this decision. That is deliberate and is the cleanest evidence that ADR
0016's property survives: the refusal that keeps a backgrounded `Bash` out of Subagent bookkeeping
is still a boundary between two objects rather than an `if` inside one.

## Its own Entry, and its own count

A fourth `ToolStatus` was the smaller change and was rejected. `tool_ended` is emitted at the launch
receipt and must stay there: that receipt is a real `tool_result` the model read, and its `isError`
is the only signal a launch *failed*. Withholding it until the task settles would recreate ADR
0016's bug in mirror image — `task_notification` carries no tool result, so nothing would ever end
that row.

The count is a second field rather than added into `activeSubagents`, because only that one has a
pane behind it: a backgrounded `Bash` counted as an agent would offer a reader a card that does not
exist. What the two share is `working()`, which is the one question that does not care which of them
is busy, and which is why both are summed there and nowhere else.

`working()` takes a `WorkLoad` with both counts **required**. `agent-session-nav.tsx` builds an
object literal at the one call site where the blue dot is drawn, so an optional field would let a
forgetful caller compile while silently under-reporting work.

## Both rows render, unlike a Subagent's pair

`ownKeys` drops the tool call that spawned a Subagent because the two "are adjacent, carry the same
brief, and only one of them carries a status". For a Background Call the middle clause is false, and
completing the pattern would delete information: the tool row carries the command — `npm test --
watch`, which appears nowhere else in the transcript — and its result well carries the launch
receipt's shell id and output path, which `BashOutput` is later pointed at. The card carries a
status and a clock. Both say something, so both stay, and `subagent-rows.test.ts` asserts it so
nobody later tidies it away.

The cost, owned rather than hidden: a `complete` tool row sits directly above a `running` card for
the life of the Call. The card is drawn as a continuation of the row — same indent, its own `⟳`
gutter glyph — because that pairing is what makes the two readable together.

## Consequences

**No new `Capabilities` flag, and the conformance assertions are ungated.** `subagents: boolean`
exists so a client can hide an affordance rather than show an empty tree; a Background Call has none
behind it, so an adapter emitting none simply shows none — the shape `notice` already has. The new
assertions pass vacuously for such an adapter instead of skipping, which is a deliberate asymmetry
with the Subagent ones.

**`Monitor` is still not in `DEFAULT_ALLOWED_TOOLS`, so every `Monitor` call raises a Permission
Prompt** — real `awaiting` occupancy, on an Agent Session whose Background Call deliberately is not
occupancy. Reaching it in the spike needed `bypassPermissions`. This is left alone on purpose: ADR
0016 closed with "Nothing polls, and no tool was added to let the model poll", and reversing that is
an authorisation decision with its own captures to make. Nothing here depends on it, because
detection is structural — which tools produce cards is the only thing it changes. The pre-approved
path already works unprompted end to end: `Bash` launches, `BashOutput` reads, `KillShell` stops.

**`activeBackgroundCalls` is load-bearing for the rail's order, not only for a dot.** It decides a
Band through `working()`, so a count that drifts moves a row. It lifts only an `idle` Agent Session,
because a Background Call cannot outlive its Backend Session and a count on a Dormant or Settled one
is a stale index.

**A Background Call open when its Backend Session goes away is recorded `aborted`**, from all four
paths that take one away. A remotely-launched call is the honest exception — it may really still be
running elsewhere — and is recorded aborted anyway, because Flow has no channel to hear about it
again and a card spinning on a promise nothing can keep is the worse of the two lies.

**A Background Call breaks a Tool Chain**, because `isChainable` is left alone. That is correct: the
card is the row a reader must not have folded away, and a backgrounded `Bash` in the middle of
twenty greps splitting the fold in two is the point rather than a defect.

**There is no Background Calls pane, and the strip is sometimes not a button.** The Subagents Pane
exists to drill into one Subagent's nested transcript; a Background Call attributes nothing, so
every row would link nowhere. The Composer keeps one strip — its own comment argues that a row which
comes and goes costs the transcript height, and two strips would spend that argument twice — with a
combined label, rendered inert when only Background Calls are running. Reopen this if a Background
Call ever gains attributed rows: the Entry kind and the count such a pane would be built on already
exist by then.
