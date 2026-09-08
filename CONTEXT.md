# GoodHarness

GoodHarness lets an engineer run and watch coding-agent sessions from a terminal or a browser, over
more than one agent SDK, without the two front-ends drifting apart.

## Language

**Agent Session**:
The durable unit of work GoodHarness owns. Bound to a Scope, owns a Presentation Transcript, and
survives a daemon restart as Dormant.
_Avoid_: session, run, job

**Backend Session**:
The SDK's ephemeral session serving an Agent Session, holding the Conversation Context. One Agent
Session may be served by several Backend Sessions over its life.
_Avoid_: session, process, connection

**Subagent**:
One unit of work a model handed off to be done apart from its own conversation, wholly inside one
turn of one Backend Session. Identified by the tool call that spawned it, so it is addressable
without a new id space — its **name is not its identity**, and two Subagents of the same kind
routinely run at once. It owns no Presentation Transcript, is never Revived, and cannot outlive the
turn: one left running by an unclean shutdown is closed as aborted, the way a torn turn is. Its
conversation never enters the parent's Conversation Context, so it costs Spend without costing
occupancy.
_Avoid_: subagent session, child session, sub-session, task, sidechain, delegation; and `agent` in
code, which collides with Agent Session — "Agents" is the label a reader sees, not the term.

**Spend**:
Everything billed for an Agent Session so far, across every model, Subagents included. Distinct
from how full the Conversation Context is: Spend is cumulative and unbounded, occupancy is a
fraction of a window, and a session routinely bills many times what its window holds.
_Avoid_: usage, cost, tokens, context

**Presentation Transcript**:
The append-only, sequence-numbered record of what a human saw. Never rewritten, never compacted.
_Avoid_: history, log, messages

**Conversation Context**:
What the model can currently see. Compacted and owned by the backend, not by GoodHarness.
_Avoid_: history, transcript, memory

**Attachment**:
A file the human added to a message, held beside the Presentation Transcript and carried into the
Conversation Context. Images are the only kind carried today. Addressed under the Agent Session it
was sent to, because it has no life apart from the transcript naming it: it is Reaped with that
transcript and is never reachable without it.
_Avoid_: upload, file, blob, paste, and above all **image** — a markdown image in model output is
already a different thing, and the one kind GoodHarness refuses to fetch (ADR 0012).

**Command**:
Something a human triggers by name from the composer and **GoodHarness itself performs** — compacting
the Conversation Context today. Never reaches a model and is the whole of the message it appears in,
so it enters no Presentation Transcript as a user turn. It does **occupy the Agent Session** while it
runs, and shows as a turn: a Command may spend money and hold the backend for minutes, and the
Steering Queue can only order what comes next if it knows the session is busy.
_Note_: `Command` in `src/protocol/commands.ts` is the wider union of every client→host message,
`send` and `create` included, and only some of its members are typeable. When both are in play, say
"a typed Command" for this one.
_Avoid_: slash command, action, tool — **tool** especially, which is what a model calls.

**Skill**:
A named prompt the **backend** expands when a message begins with it — `/tdd`, `/code-review`. Unlike
a Command it is ordinary text all the way down: it enters the Presentation Transcript and the
Conversation Context as the user turn it is, and may carry arguments after the name. A fact about the
Scope rather than the Agent Session, read off disk on request and never written down, because it is
stale the moment someone edits the file behind it.
_Avoid_: command, prompt template, macro; and note the two backends disagree underneath — pi splits
this into a Skill and a PromptTemplate, and the adapter offers both as Skills.

**Backend Adapter**:
The translation of one agent SDK into Agent Events and session commands.
_Avoid_: driver, provider, runtime, plugin

**Provider**:
An inference endpoint a Backend Adapter can reach — Anthropic, OpenAI, Google. A Provider serves
models; it is not an agent harness.
_Avoid_: backend, adapter, vendor

**Session Host**:
The daemon process owning every Agent Session and the Steering Queue.
_Avoid_: server, manager, supervisor

**Steering Queue**:
Messages held by the Session Host awaiting the end of the current turn.
_Avoid_: inbox, buffer, backlog

**Dormant**:
The state of an Agent Session with no Backend Session running. Its transcript is readable and it can
be Revived.
_Avoid_: idle, stopped, paused, dead

**Settled**:
The state of an Agent Session its owner has declared themselves done with. No Backend Session runs,
the transcript stays readable, and a Revive un-settles it — but left alone it is Reaped.
_Avoid_: closed, archived, done, finished, ended

**Reap**:
Deleting a Settled Agent Session and its Presentation Transcript from disk once its retention window
has passed.
_Avoid_: cleanup, purge, expire, prune, garbage collection

**Revive**:
Attaching a fresh Backend Session to a Dormant Agent Session, continuing the same Presentation
Transcript.
_Avoid_: resume, restart, reconnect

**Ended**:
The state of an Agent Session disposed of deliberately. No Backend Session runs and the Presentation
Transcript stays readable, but it refuses a Revive. Unlike Settled it is never Reaped, so it stays on
disk until removed by hand.
_Avoid_: closed, deleted, terminated, killed, settled

**Scope**:
The working directory an Agent Session is bound to.
_Avoid_: workspace, project, repo — a Project is a distinct thing, defined below, and calling a
Scope one confuses a binding with a candidate for it.

**Project**:
A directory its owner has opted into starting Agent Sessions from. A *candidate* Scope, not a Scope:
it exists before any Agent Session, outlives every one bound to it, and may have several at once.
Opted into rather than merely found — a repository GoodHarness can see is a Candidate until it is
listed — and it need not be a repository at all, because someone chose it deliberately.
_Avoid_: scope, workspace, folder, repo

**Candidate**:
A repository GoodHarness found beneath the Project Root that is not a Project yet. Offered only so
that opting in is a click rather than a typed path. Discovered, never configured, and never offered
as a Scope.
_Avoid_: project, suggestion, available project

**Worktree**:
A Scope the Session Host made, by cutting a branch from a Project. Owned by the host rather than by
whoever asked for it: it is chosen when an Agent Session is created, never entered later, and it is
removed when that Agent Session is Reaped — but only while it is clean, because a branch outlives a
reap and uncommitted work does not.
_Avoid_: checkout, copy, clone, workspace — and note it is a *kind of* Scope, not an alternative to
one, so an Agent Session bound to a Worktree is bound for its whole life like any other.

**Project Root**:
The single directory Candidates are looked for beneath, and the one GoodHarness reports itself as
open on. Configured, never discovered. It bounds what is suggested, not what a Project may be: a
Project outside it is named by its own path.
_Avoid_: workspace, workspace root, home, cwd

**Shell**:
A shell process serving an Agent Session, started in its Scope. Ephemeral: unlike a Backend Session
it is never Revived, and it does not survive a daemon restart. An Agent Session may own several, and
they exit when it is Settled, Ended or Reaped.
_Avoid_: terminal, pty, console, session

**Scrollback**:
The bounded ring of recent Shell output the Session Host keeps so a reattaching client sees a
populated screen. Lossy by design — it is not a Presentation Transcript, and it is never written to
disk.
_Avoid_: transcript, history, log, buffer

**Settings**:
Values the Session Host reads from its state root, governing every Agent Session on the machine
rather than one Scope. Read leniently and written strictly: a value it cannot use costs only its own
default on the way up, but one offered by a client is refused.
_Avoid_: config, preferences, options, profile

**Effort**:
How hard a model is asked to think on a turn. Declared per model rather than per Agent Session,
because not every model offers it.
_Avoid_: thinking, reasoning, budget, thinking level

**Capabilities**:
What a Backend Adapter can be asked to do, declared per Agent Session so clients hide controls
rather than break on them.
_Avoid_: features, flags, support
