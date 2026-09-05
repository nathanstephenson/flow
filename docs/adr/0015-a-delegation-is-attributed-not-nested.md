# A Delegation is attributed, not nested

A subagent's work appears in the Presentation Transcript as ordinary Entries carrying a `producer`
naming the Delegation that made them, plus one `delegation` Entry carrying its lifecycle. The
transcript stays one flat, append-only, sequence-numbered list. Showing a Delegation's work indented
under the tool call that spawned it is a rendering concern, done by grouping the flat key list at
paint time.

**A Delegation is neither kind of session, which is why it is neither word.** CONTEXT.md reserves
Agent Session for the durable thing GoodHarness owns and Backend Session for the SDK's ephemeral one.
A subagent is a third thing: it owns no Presentation Transcript, it is never Revived, it dies with
the turn that spawned it, and it lives wholly inside one Backend Session. Calling it a session would
make `_Avoid_: session` in two glossary entries a lie, and would invite someone to ask the Session
Host to Revive one.

**Identified by the tool call that spawned it, so there is no second id space.** The `Agent` tool
call already has a `callId`, the SDK already attributes a subagent's messages to it via
`parent_tool_use_id`, and a reader can already see that call as a `tool` Entry. Minting a Delegation
id would mean maintaining a mapping between the two and a rule for what happens when they disagree.
The tool Entry is what the parent asked for; the delegation Entry is what the subagent is doing about
it; they are two views of one thing and they share one id.

**Nesting the Entries was the obvious alternative and was rejected on four counts, any one of which
would have been enough.** `upsert` is a flat `findIndex` over `entries` keyed on kind and id, so
nesting needs a recursive upsert — and every child snapshot then rebuilds the parent tool Entry, so
`next.entries !== view.entries` fires for the parent row on every child token. `entryKey` becomes
non-unique or needs a path. `TranscriptEntry`'s props contract is `{ entry, query, sessionId }` "and
nothing else, by contract" so that `memo` holds; a `children: Entry[]` rebuilt per tick breaks it and
re-renders the whole subtree per token. And `agent-session-view.ts` decides the key list changed **by
length alone**, sound only while the transcript is append-only — nesting moves entries out of the top
level, so a subagent's twenty messages would arrive with `entries.length` unchanged and `getKeys()`
would hand back a stale list. Its comment says that failure "breaks quietly", which is the worst
available outcome and the reason this decision is written down rather than left to taste.

The two rules that follow, and that a reviewer should enforce: collapsing a Delegation filters
**keys**, never `entries`; and children are never sorted to sit beside their parent in `entries`.
Both are the same rule — the flat list is append-only and ordered by `seq`, and grouping happens
above it.

**Lifecycle is a snapshot, not a started/ended pair.** `message` and `thinking` are upsert-by-id
snapshots because a client joining at `since: N` must converge with one that saw everything. A
Delegation must be too: a `delegation_started` that named it, followed later by an end, leaves a
late-joining client holding a lifecycle it cannot complete. So one event type carries the whole
state, repeated on every transition, latest-wins. That also keeps `entries.length` unchanged across a
Delegation's whole life, which is what keeps the length heuristic above sound.

**Waiting names what is being waited on, as a variant rather than a flag.** A boolean `waiting` that
cannot say what it waits for is a spinner with extra steps. The union is `provider` — the backend is
retrying or rate-limited, which pi already knows and currently flattens into a `notice` — `child`,
and `permission`. Permission is in the union ahead of the Permission Prompt that will populate it,
because the alternative is a second breaking change to a shipped protocol for a case we already know
is coming.

**A Delegation's Spend is per model, not per Delegation, and the protocol does not pretend
otherwise.** The SDK reports cumulative usage keyed by model. Two Delegations on the same model are
indistinguishable in it. Modelling a `costUSD` on the Delegation itself would require inventing an
attribution the backend does not supply, so Spend stays where the data is — a per-model breakdown on
`context_usage` — and a Delegation Entry carries no cost of its own.

**Capabilities gate it, so an adapter that cannot report Delegations is not a broken one.**
`Capabilities.delegation` distinguishes "this backend has no subagents" from "this backend does not
tell us about them", the same distinction `effortLevels` draws for models that offer no Effort. A
client hides the affordance rather than showing an empty tree, and the conformance contract gates its
Delegation assertions on the flag the way it already gates Effort on `effortLevels.length`.
