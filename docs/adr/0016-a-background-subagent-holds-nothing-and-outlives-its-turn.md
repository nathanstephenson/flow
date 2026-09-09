# A background Subagent holds nothing and outlives its turn

An `Agent` tool call the model backgrounds — which the SDK documents as the default — returns its
`tool_result` at once, carrying an agent id and an output file instead of a report. `ClaudeSession`
tells that receipt from an answer by reading `status` off `SDKUserMessage.tool_use_result`, the
structured `AgentOutput` the SDK asks callers to render from: `async_launched` and `remote_launched`
are launches, `completed` is an answer. On a launch the Subagent gives up its hold on the turn and
keeps its card, and `Subagents` moves it from `open` to `detached`. It is closed turns later by the
`system`/`task_notification` that reports it settled, matched back to its `callId` through the
`task_id` map `system`/`task_started` populates. When a settled Subagent wakes the model — the CLI
injects the notification and the model speaks again, unprompted — `ensureTurn` mints a turn for what
it says, and the Session Host takes occupancy from that `turn_started` rather than from having
dispatched.

Captured against Claude Code 2.1.247 by `spikes/background-subagent.ts`, one background `Explore`
counting files in `./docs`: `subagent(running)` and the `Agent` `tool_ended` at 09:57:19, the
launching turn ended at 09:57:21, the Subagent's own rows streaming attributed for eight seconds
with no turn open, `subagent(complete)` at 09:57:29, and a second turn on a different id at 09:57:31
carrying the answer the model gave once woken. Two turns for one prompt, which is the shape this
decision is about.

**The turn is not the unit of a Subagent's life, and pretending otherwise cost us both of the things
the pretence was for.** Until this decision, the first `tool_result` bearing a Subagent's spawning
`callId` was taken as proof it had finished. For a backgrounded agent that fires at launch, so the
card went terminal before the Subagent had started, `Subagents.returned` released the held turn end,
and the Steering Queue dispatched the next message into a turn still running — the exact failure the
`Subagents` docstring says the module exists to prevent, reached by a path it did not consider. The
rows the Subagent went on to produce were still attributed by `parent_tool_use_id` to a card that
was already complete and whose brief `clear()` had discarded, so nothing could reopen it. Worst and
least visible: the CLI re-invokes the model when the agent settles, and those words arrived with
`this.turnId` undefined — a whole model response, and its Spend, outside any turn at all.

**Holding the turn open instead was the obvious alternative and was rejected because the session
would be lying about being busy.** It is the smaller change by far: keep `returned` off the launch
receipt, let the hold run until `task_notification`, and CONTEXT.md, this ADR's predecessor and the
conformance contract all stay as written. But trace what the parent model does in that window. It
emits the launch receipt, receives its own `result` — `terminal_reason: 'background_requested'` —
and stops. It is idle, waiting to be woken. Holding would have shown the Agent Session `running` and
refused to dispatch for however long the agent took, which for an `Explore` sweep is minutes, and
CONTEXT.md justifies occupancy for a Command on grounds that are simply untrue here: nothing is
spending, and nothing is holding the backend. Blocking steering while the model sits idle is a worse
lie than amending a glossary entry, and steering is the whole point of ADR 0002.

**A minted turn is how work nobody asked for gets accounted for, rather than an exception to
turns.** The alternative was to attribute the re-invoked response to the turn that spawned the
Subagent, which is over, or to emit it with no turn, which is what the bug did. Both make
`openTurnId` and the reducer's `status` disagree with what is happening. A turn minted on the first
thing the model says is the same shape every other turn has — `turn_started`, rows, `turn_ended`
from the `result` — and needs no new event and no new state. It is minted on the model speaking
rather than on the notification arriving, because a notification the model does not answer
(`ambient`, `skip_transcript`) would otherwise open a turn nothing would ever close.

**The Session Host now takes occupancy from `turn_started` as well as from dispatching, and the two
cannot disagree.** `turnInFlight` was set only by `dispatch` and `compact`, both before the adapter
acknowledges, for the race the field's own comment describes — an adapter-minted turn had no way to
occupy the session, so the Steering Queue would have dispatched straight into it. Handling
`turn_started` in `onBackendEvent` is redundant for every turn the host itself started, which is why
it is safe: it can only ever set a flag that path has already set.

**The task id is mapped, not adopted, so ADR 0015's single id space survives.** `task_notification`
usually carries `tool_use_id` and the map is only its fallback, but `task_updated` carries none, and
that is the message that reports an agent killed rather than finished. `noteTask` refuses a `callId`
it does not already know as a Subagent's, which is what keeps a backgrounded `Bash` or `Monitor` —
same three message types, same task id space — out of Subagent bookkeeping without an allowlist of
task types to maintain.

**A detached Subagent's brief survives `clear()` and dies with the Backend Session.** `clear()` is
called from `endTurn` and empties what is turn-scoped; the detached map and its task ids are not,
because the snapshot that closes one is emitted from that brief turns later. What ends them is
`dispose`, through a new `abandon()`, because they are children of the CLI process and go when it
goes. That is also why `closeOpenSubagents` in the Session Host needs no change and its reasoning
stays sound: a detached Subagent unfinished at shutdown really is a record of something that will
never finish, and aborting it on load is still right.

## Consequences worth stating

**A long background agent no longer shows the session as busy, and that is the trade.** Someone
watching an Agent Session that launched four `Explore` agents sees it idle, because the model is.
The Subagent cards are the only thing saying work is in flight, which puts more weight on the second
surface ADR 0015 called for than it had before.

**The conformance contract no longer requires pairing within the turn, only pairing.** The assertion
was "pairs every Subagent with a terminal snapshot before the turn ends"; the turn-scoped half of it
is what this decision repeals, and what remains is what an adapter actually owes — no card left
spinning with nothing that will ever close it. An adapter that reports a launch and never its
notification now fails that assertion for the right reason.

**Backgrounded `Bash` and `Monitor` calls wake the model the same way and are not covered.** They
settle through the same `task_started` / `task_notification` messages and will mint a turn through
`ensureTurn` exactly as a Subagent does, which is correct. What they have is no card, so there is
nothing on screen between launch and report to say the session is waiting on anything. Whether a
background task that is not a Subagent deserves a lifecycle Entry of its own is a separate decision,
and this one does not make it.

**A detached Subagent cannot end a turn that is not its own, because no Subagent emits a `result` at
all.** This was written down as the one risk the decision left open — a detached Subagent holds
nothing, so a stray `result` arriving mid-steer would reach `finishTurn` and end the human's turn
early. `spikes/background-result-attribution.ts` drove exactly that shape against CLI 2.1.247:
launch a background agent, steer "What is 2+2?" while it runs, and log every message. Three `result`
messages arrived for three prompts — the launch, the steered question, the re-invocation — and not
one for the Subagent, whose eleven seconds of work came through as `assistant` messages carrying
`parent_tool_use_id` and settled through `task_notification`. `--foreground` shows the same: one
Subagent running 6.5s to 17.1s, still exactly one `result`, arriving after the parent's final text.
The risk does not exist.

**Which leaves `Subagents.hold` answering a question nothing asks, and that is worth knowing rather
than acting on.** Its docstring's premise — "a `result` emitted for a subagent cannot be told apart
from the one that ends the turn" — does not hold at this CLI version, because there is no such
result. The module is therefore load-bearing only for its bookkeeping, not its holding, and
`background()` releasing a held end is a no-op in practice. That is *why* this decision is safe
under either behaviour, and it is deliberately not a licence to delete `hold`: the observation is
one CLI version on the happy path, and says nothing about a nested Subagent, an interrupt, or an
error. Its removal is a separate decision needing its own captures.

**A detached Subagent's own rows do not open a turn.** `ensureTurn` mints only for the Agent
Session's own model. A Subagent streams for as long as it runs, and minting for those rows would
occupy the session throughout — reinstating, through the back door, the blocking this decision
exists to remove.

**Nothing polls, and no tool was added to let the model poll.** `TaskOutput` and `TaskStop` stay out
of `DEFAULT_ALLOWED_TOOLS`. Notifications arrive unprompted, so polling would be a second path to
the same state, and the one thing `TaskStop` would buy — stopping a detached agent without aborting
the session — is a control no front-end offers yet.
