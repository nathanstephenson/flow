# 19. An Agent Session's Lifecycle is stored and its activity is derived

Date: 2026-09-10

## Status

Accepted.

Revises ADR 0009, whose Settings paragraph names `status` and `updatedAt` as the whole of what
`SessionHost.reap` compares and sanctions `web/src/presentation/reapable.ts` copying that rule
client-side. The pair is now `status` and `settledAt`; the copy and its tests move with it.

## Context

`SessionRecord.status` carried two facts in one field. Three complaints landed at once, and all
three were that field.

**A session with background Subagents reads as doing nothing.** ADR 0016 established that a
backgrounded Subagent is not occupancy — it does not hold the Steering Queue, and holding the turn
open for it "would be a lie that the session is busy". That decision is right and stands. But it
left the rail with no way to say *work is happening here*, so four `Explore` agents running for
three minutes looked identical to a session nobody had touched since Tuesday.

**A session waiting on a person is never marked as such.** `status-indicator.tsx` has carried an
`awaiting` dot and a `--status-awaiting` token since before either feature that produces one
existed, with a docblock explaining that `ask_user_question` "does not exist". ADR 0016 shipped the
Enquiry and ADR 0018 shipped the Permission Prompt. Both hold a turn open on a human with no
timeout, both were reduced into `ViewState.asking` and `ViewState.authorising` — and neither was
ever lifted to a status, because `SessionStatus` had no member for it and the rail sees only the
polled summary. Two decisions shipped the thing; none of them named it.

**The rail reordered constantly.** `onBackendEvent` restamped `updatedAt` on every backend event and
`list()` sorted by it descending, so any streaming Agent Session floated to the top on each
two-second poll and pushed every other row down. The one ordering rule anyone had written down —
`list()`'s comment that Settled must sink because "settling is itself the most recent activity" — was
already an admission of this bug shape in a narrower case.

Measured by `spikes/status-rail.ts`, which parks four Agent Sessions in the states the rail has to
tell apart and streams into one of them: 95 events accumulated on the Running row across three polls
without moving it, where `updatedAt` would have held it at the top for the whole turn.

Underneath all three: `status` conflated a fact that survives a restart with one that does not.
ADR 0003 fixed that Agent Sessions "that were running load as Dormant" and a restart "drops any turn
torn by the restart". So `dormant`, `settled` and `ended` mean something on the far side of a
restart, and `running` and `idle` are annihilated by it.

## Decision

**An Agent Session stores a Lifecycle and derives its activity, and the rail is banded by how alive
each Agent Session is rather than ordered by one timestamp.**

Six things follow, and they are the decision:

**The cut is what a wrong answer costs.** ADR 0013 set the rule when it recorded the worktree flag
rather than deriving it from a path: "a wrong group shows a wrong heading, while a wrong answer here
runs `git worktree remove` on a directory nobody asked us to own." Apply it. A wrong activity draws
a wrong dot until the next event arrives, which is cosmetic and self-correcting; a wrong Lifecycle
reaps a transcript on a one-day timer. So `SessionLifecycle` is `live | dormant | settled | ended`
and is persisted, while `idle | running | awaiting` are computed by `deriveStatus` and never stored.
The four `record.status = …` assignments that used to shadow `turnInFlight` are gone, so occupancy
is no longer a value that can disagree with the flag the Steering Queue reads.

**Awaiting is occupancy, and `turnInFlight` remains what the guards read.** CONTEXT.md already said
an Enquiry and a Permission Prompt each "occupies the Agent Session while it waits", and ADR 0002's
queue depends on knowing the session is busy — so `awaiting` had to be busy, not a third thing
between busy and free. `occupied()` in `client/status.ts` is how callers ask. The hazard this
creates is real and cost a change to five call sites: widening `SessionStatus` makes every
`=== "running"` silently false during `awaiting`, and the compiler catches none of them. The worst
was `switchBranch`, which would have stopped refusing and moved a working tree out from under a live
tool call; it now reads `turnInFlight` directly, which is the question it was always asking.

**A background Subagent gets a count, not a colour.** Making `running` mean "work is happening
somewhere" was the obvious way to answer the first complaint and was rejected, because it repeals
ADR 0016 by the back door: the model would be idle, the Steering Queue would dispatch, and the
status would say otherwise — and `switchBranch` and the compaction guard would then refuse work that
is perfectly safe. `SessionSummary.activeSubagents` carries the true and narrower fact instead, and
the rail draws it as its own mark beside the status dot. The trade ADR 0016 accepted stands; what
changes is that the rail now has a second surface on which to say what it gave up.

**The rail is banded by how alive an Agent Session is, then ordered by `restingAt` inside each
band.** The bands are Awaiting, working, Idle, Dormant, and Settled with Ended. A single recency key
was tried first and rejected in review: it put an Agent Session that finished ten minutes ago above
one that was still working, and the top of a list is where a reader looks for what is happening.
Banding fixes the order without giving back the stability the key was introduced for — a row moves
when its band changes and at no other time, so a turn streams for an hour without touching the list.
Working is the one band that is not simply a status: `activeSubagents > 0` lifts an Idle Agent
Session into it, which is how ADR 0016's trade is paid for rather than repealed.

**`restingAt` is stamped on the transition into Idle, and nowhere else.** Stamped on the transition
rather than on the state, because `onBackendEvent` runs per streamed token and stamping on the state
would reproduce exactly the churn this replaces. Awaiting deliberately does not stamp, though it is
equally its owner's turn: the band already surfaces it, so a stamp would buy nothing and would cost
real churn — a turn that hit two un-authorised tools would come back out of Awaiting with a fresh
timestamp and jump the working band. `updatedAt` leaves `SessionSummary` altogether rather than
staying on as a field with no reader, and the rail and the TUI both print `restingAt`, because a
list that shows one time while ordering by another reads as broken the first time they disagree.

**The open-prompt index is an index; the transcript stays the truth.** `statusOf` cannot scan a
transcript, because `list()` runs for every Agent Session on every poll and that is the budget
`branch` is already held on the record to stay inside. So the host keeps three Sets of open
Permission Prompt, Enquiry and Subagent ids, maintained incrementally in `onBackendEvent` and seeded
from the existing scanning helpers on load. Those helpers keep scanning wherever a terminal snapshot
is written. The asymmetry is deliberate: a drifted index shows a wrong dot until the next event,
while an index believed by the code that closes torn prompts would leave a dangling `asked` on disk
that replays into a composer nobody can unlock.

## Consequences

**A Permission Prompt now moves a row between bands, which is the one motion this adds.** A turn
that hits several un-authorised tools bounces `running → awaiting → running`, and each leg is a jump
to and from the top of the rail rather than a dot changing colour. Accepted because ADR 0018 makes
prompts rare by construction — only a tool nothing has already authorised raises one — and because
not stamping `restingAt` on Awaiting means the row returns to the position it left rather than to
the top of its band.

**`activeSubagents` is load-bearing for the order now, not only for a mark.** It decides a band, so
a count that drifts moves a row rather than only mis-drawing a dot. `railBand` lifts on it only when
the status is `idle`, because a Subagent cannot outlive its Backend Session and a count on a Dormant
or Settled Agent Session is a stale index rather than live work.

**`activeSubagents` refreshes on the two-second poll for unfocused rows.** A Subagent that starts and
finishes inside one poll never draws its mark. That is a miss rather than a flicker, and it is the
cost of the rail not holding an event stream per Agent Session (ADR 0008).

**A latent retention bug is fixed on the way past.** `setModel`, `setEffort` and `abort` all call
`touch()` and none of them refuse a Settled Agent Session, so opening one and changing its model
restarted its deletion clock. ADR 0006 fixed that the clock starts at the Settle; `settledAt` is now
its own field and is written once, by `settle`, and cleared by a Revive. `reap` reads it, and keeps
the rule that an unreadable timestamp is left alone — extended to a missing one, which is what a
summary from a pre-split daemon carries.

**One rail-versus-pane contradiction dissolves rather than being fixed.** `settle()` carries a
comment about a trailing `turn_ended` making "the rail say settled while the pane said idle". Settled
and idle were only ever contradictory because they were the same field; they are now on different
axes, and the host and the reducer derive through the same function, so the two agree by
construction rather than by two hand-maintained switch statements happening to line up.

**Metas written before this decision load correctly and are rewritten on the first boot.**
`lifecycle` falls back to the deprecated `status` mirror, `settledAt` and `restingAt` to
`updatedAt`, which is exactly what both used to mean. `persist` keeps writing the `status` mirror so
that rolling the daemon back does not read every Settled Agent Session as Dormant and quietly stop
reaping them; it can be dropped once no shipped daemon reads it.
