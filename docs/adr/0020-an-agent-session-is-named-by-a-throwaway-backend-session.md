# 20. An Agent Session is named by a throwaway Backend Session

Date: 2026-09-10

## Status

Accepted.

## Context

An Agent Session was named once, at its first dispatch, from the first line of what its owner typed
— sixty characters of it, then an ellipsis. The rail and the pane header therefore read as a column
of truncated sentences: "can you have a look at the thing where the upl…". There was no way to name
one again, by hand or otherwise.

A better name is a model call, and the daemon had nowhere to make one. Every model this process can
reach, it reaches through a Backend Adapter, and every adapter reaches models by constructing a
*session* — an agent with tools, a working directory, and a Conversation Context.

Two facts shape what follows:

- **A model id is only knowable from a live Backend Session.** Claude's list comes from
  `supportedModels()`, a control request on a running stream; pi's comes off a constructed session's
  model registry. `Capabilities` is declared per Agent Session for exactly this reason, and the New
  Agent Session dialog already refused to offer a model on those grounds.
- **A `ClaudeSession` parks a tool call it cannot pre-approve**, holding it on a Permission Prompt
  until a human decides. That is right for a session someone is watching and fatal for one nobody
  is: the turn never ends.

## Decision

**An Agent Session is named by the Summary Model, in a throwaway Backend Session that runs no tools,
from the Presentation Transcript, and failing to do so costs nothing.**

**Through an ordinary Backend Adapter, not a new SDK client.** The daemon gains no second HTTP
client and no credentials of its own, so ADR 0005's rules are untouched and any adapter — including
one written later — can serve a Summary Model. The alternative, a small direct Anthropic client, is
cheaper per call and only ever works for one shape of Provider.

**With `tools: "none"`, and an adapter honouring it must deny rather than park.** A new option on
`BackendCreateOptions`, not a tool list: which tools a session may run is a question the Standing
Authorisations already answer, and a second mechanism for saying it would be one more place for the
two to disagree. Denying is the load-bearing half — parking is what would hold the turn open until
the caller's timeout. It also means the throwaway session never reads the Scope it nominally runs
in, which is what makes that directory incidental rather than a decision.

**From the Presentation Transcript, never the Conversation Context.** They are different records
(ADR 0001), and only the first can be read with nothing running. So a rename never Revives (ADR
0003), opens no turn on the session it is naming, and occupies nothing — which is why it is a member
of the `Command` union without being a Command in CONTEXT.md's sense.

**And the throwaway session is kept warm, because the spawn is the whole cost.** Measured against
the real backend: a cold session answers in 24–44 seconds and one that has finished booting answers
in about six. Nothing about the spawn can be made smaller — `query()` loads ~14,200 tokens of Claude
Code preset whatever options it is handed; `settingSources: []` changed nothing and a custom
`systemPrompt` *appends* to the preset rather than replacing it. So the Session Host keeps **one**
tool-less session booted ahead of need, hands it to the next naming, and boots a replacement. Each
naming still gets a fresh session, so no name is produced in a context holding another session's
transcript.

**Fire-and-forget at dispatch, and it may only ever replace a first-line name.** The first line goes
up synchronously, so there is no empty state and no spinner; the model's name lands seconds later
and replaces it. `SessionRecord.titleSource` records which of the three a title is, and
`titleGeneration` — borrowed from `branchGeneration`, whose comment describes the same hazard —
stops a slower answer overwriting a newer one. A summary can therefore never change a name that was
already settled under its reader.

**Silence on the automatic path, a refusal on the human one.** `firstLine` already produces
something usable, so a Summary Model that is missing, slow or talking nonsense costs the better name
and nothing else — least of all the turn somebody is waiting on. A rename somebody clicked turns the
same outcome into a message they can read.

**Three to seven words, enforced deterministically and never truncated.** `nameFrom` is pure and is
where the feature is actually decided; the prompt interpolates the same two constants it checks, so
the wording and the rule cannot drift. An over-long answer is rejected rather than cut, because a
name severed mid-phrase reads as a bug and is worse than the first line of what the human typed.

## Per-backend Settings amendment

Default Backend is machine-wide and resolved by the Session Host when a create command omits its
backend. Web and terminal clients honour it; explicit choices win. With no setting, automatic
selection prefers Claude, then the first registered adapter. An unavailable configured adapter is
refused rather than silently rerouting a prompt. Existing Agent Sessions keep their bound adapter.

Default Model, Default Effort and Summary Model are configured per Backend Adapter. Naming reads the
Summary Model for the Agent Session's own adapter; unset means no naming model. Default Effort is
resolved at creation, with explicit effort taking precedence, and never enters a naming request.
Legacy `providers.summary` is read only for its named backend; editing that backend's summary
supersedes the legacy value. The spare remains one bounded slot across all backends, so alternating
backends can lose the warm-start benefit without sharing a Conversation Context.

Pi's catalogue uses credential-aware discovery rather than the full registry. Its model identities
include the Provider; an old bare id is accepted only when exactly one authenticated model matches.
Configured authentication is not a live credential validation; revoked credentials can still fail
when used. An empty pi catalogue does not offer arbitrary ids as a workaround.

## Consequences

**`GET /api/models` exists, and it spawns a process per backend.** A machine-wide Default Model and
Summary Model have to be chosen before any Agent Session exists, so the Providers section cannot
wait for a `session_started` — it opens the same kind of throwaway session and reads its
Capabilities. This is cached for the daemon's life, unlike `/api/branches` and `/api/directories`
beside it, and the departure is deliberate: those answers change outside Flow between keystrokes,
this one changes when an account's entitlements do. "Check again" is the way to re-ask. A backend
that cannot answer returns a 200 carrying a `problem`, and its field becomes a text input.

**Nothing validates a model id at save time.** `applyPatch` is I/O-free by design, and checking
whether a backend can serve an id needs a running one. So a Default Model nobody can reach fails on
the first turn of every session created afterwards, and the picker is the whole of the mitigation.
The section's copy says so outright.

**The Summary Model's Spend is not counted anywhere.** Spend is read off the counters of the Backend
Session serving an Agent Session, and this call happens in a different one that is thrown away.
CONTEXT.md's claim that Spend is *everything* billed for an Agent Session is therefore now false by
a small amount, and is amended to say so rather than fixed. Merging a throwaway session's counters
into `record.spend` would make the meter jump for a turn nobody saw.

**The Default Model is read at create and never on Revive.** The tempting place to read it is
`startBackendSession`, which is also the Revive path — and that would silently move a week-old
Dormant Agent Session onto whatever the default is today, on the turn its owner came back to write.
Resolving once into `SessionMeta.modelId` is what makes the choice stick for a session's life.

**`Provider` is a wider word than it was.** CONTEXT.md reserved it for an inference endpoint and
told you to avoid "backend" and "adapter"; the Providers section is keyed by Backend Adapter,
because a model id is only reachable through one. The glossary entry is amended rather than the
section renamed.

**The title is still not on the wire as anything but a title.** `titleSource` is daemon-internal: a
client is handed `SessionSummary.title` and has no decision to make about where it came from.
Clients learn a new name from the `/api/sessions` poll, which `useCommand` already nudges after
every command — no `title_changed` event, which would put something no human saw into an
append-only record.

**The spare buys latency, not money, and mostly for the second name onwards.** Token cost is
14,202 either way — pre-warming moves the wait, it does not remove the work. And warming when an
Agent Session is created is only a head start: somebody types a first message in 5–40 seconds
against a 24–44 second boot, so the *first* name is usually still part-cold. What reliably gets the
six seconds is every naming after that, and a `rename` somebody clicked — which is the awaited,
watched path where the difference is the whole of the feature.

**A daemon that has made one Agent Session holds one idle CLI for the rest of its life.** It runs
no tools and spends nothing, but it will show up in `ps` with no Agent Session behind it, and
`SessionHost.shutdown` is not the daemon's exit path — there is no signal handler — so only the
one-shot runner ever disposes it deliberately. An idle-expiry rule would trade that back for a cold
first name; it has not been worth it yet.

**Deliberately not warmed at daemon start.** That would give the first clicked Rename its six
seconds, but starting `flow` would then spawn a model process nobody asked for — close enough to
what ADR 0003 refused that it should be a decision somebody makes, not a side effect of this one.

**A Summary Model cleared in the Settings can outlive its own configuration.** Nothing pushes a
Settings change (ADR 0009), so a held spare is only dropped at the next read-through, which is the
next Agent Session creation. The same staleness ADR 0009 already accepts for Standing
Authorisations, and the same reason.

**A hand-typed name is still not offered.** `rename` carries no `title` field. Adding one later is
compatible, and a field nothing sends is a field that will be wrong the day something does.

## Git publish text amendment

Opening Publish also uses the Agent Session's configured Summary Model, without Default Effort,
in a fresh tool-less Backend Session. It drafts a commit message and pull request title and body
from local changes and branch commits. Reading Git status never prompts a model. The reader can
edit the text before confirming; a missing or failed Summary Model leaves manual entry available.
This call is outside the Agent Session's Spend, like naming. It performs no Git writes.
