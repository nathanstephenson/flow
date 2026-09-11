# Flow

Flow lets an engineer run and watch coding-agent sessions from a terminal or a browser, over
more than one agent SDK, without the two front-ends drifting apart.

## Language

**Agent Session**:
The durable unit of work Flow owns. Bound to a Scope, owns a Presentation Transcript, and
survives a daemon restart as Dormant.
_Avoid_: session, run, job

**Backend Session**:
The ephemeral execution boundary serving an Agent Session, holding its Conversation Context and
owning its Subagents and Background Calls. One Agent Session may be served by several Backend
Sessions over its life.
_Avoid_: session, process, connection

**Subagent**:
One unit of work a model handed off to be done apart from its own conversation, wholly inside one
Backend Session. Identified by the tool call that spawned it, so it is addressable without a new id
space — its **name is not its identity**, and two Subagents of the same kind routinely run at once.
It owns no Presentation Transcript and is never Revived. One the model backgrounds outlives the turn
that spawned it and reports back into a later one, so a running Subagent is not occupancy and does
not hold the Steering Queue; what it cannot outlive is its Backend Session, and one left running by
an unclean shutdown is closed as aborted, the way a torn turn is. Its conversation never enters the
parent's Conversation Context, so it costs Spend without costing occupancy. Because it is not
occupancy it never shows as Running: an Agent Session whose only work is backgrounded Subagents is
Idle, and how many are working travels beside the status as a count, so a rail can say work is
happening without saying the model is busy.
_Avoid_: subagent session, child session, sub-session, task, sidechain, delegation; and `agent` in
code, which collides with Agent Session — "Agents" is the label a reader sees, not the term.

**Background Call**:
A tool call the Backend Session goes on running past the turn that made it, reporting back into a
later one. Identified by that call, so it needs no id space of its own, and named by it — a reader
sees the tool. It owns no conversation and produces no work of its own, which is what separates it
from a Subagent: there is nothing to read, only something to wait for, so it is watched rather than
opened. Like a Subagent it is not occupancy and holds nothing, so an Agent Session whose only work
is Background Calls is Idle and steering into it dispatches; and like a Subagent it cannot outlive
its Backend Session, so one left running by an unclean shutdown is closed as aborted. What a reader
sees is two rows sharing one identity: the call, which carries what was asked for, and the Call,
which carries how it is going.
_Avoid_: background task, background job, async tool, deferred call; and Subagent, which is the
other thing that outlives a turn and the one this is most often mistaken for.

**Spend**:
Everything billed for an Agent Session so far, across every model, Subagents included. Distinct
from how full the Conversation Context is: Spend is cumulative and unbounded, occupancy is a
fraction of a window, and a session routinely bills many times what its window holds. One known
exception, stated rather than fixed (ADR 0020): naming a session bills the Summary Model in a
Backend Session that is thrown away, so that call appears in no Agent Session's Spend.
_Avoid_: usage, cost, tokens, context

**Presentation Transcript**:
The append-only, sequence-numbered record of what a human saw. Never rewritten, never compacted.
_Avoid_: history, log, messages

**Conversation Context**:
What the model can currently see. Compacted and owned by the backend, not by Flow.
_Avoid_: history, transcript, memory

**Attachment**:
A file the human added to a message, held beside the Presentation Transcript and carried into the
Conversation Context. Images are the only kind carried today. Addressed under the Agent Session it
was sent to, because it has no life apart from the transcript naming it: it is Reaped with that
transcript and is never reachable without it.
_Avoid_: upload, file, blob, paste, and above all **image** — a markdown image in model output is
already a different thing, and the one kind Flow refuses to fetch (ADR 0012).

**Draft**:
A message a reader has typed into a composer and not sent — the text and any Attachments, held for
the life of the page and never written to disk. Distinct from a Steering Queue message, which **has**
been sent: the Session Host owns that one and its Attachment bytes are already on disk, while a Draft
has been committed to nothing and exists only in the browser holding it. One per Agent Session, plus
one bound to none, for the Agent Session not yet created. It is the message alone — the Scope the New
Agent Session view remembers beside it is a form field, not part of the Draft.
_Avoid_: composer state, unsaved message, buffer, autosave, and **pending message**, which is the one
that matters: it reads equally as a Steering Queue entry, and the difference between the two is
whether anything durable exists yet.

**Command**:
Something a human triggers by name from the composer and **Flow itself performs** — compacting
the Conversation Context today. Never reaches a model and is the whole of the message it appears in,
so it enters no Presentation Transcript as a user turn. It does **occupy the Agent Session** while it
runs, and shows as a turn: a Command may spend money and hold the backend for minutes, and the
Steering Queue can only order what comes next if it knows the session is busy.
_Note_: `Command` in `src/protocol/commands.ts` is the wider union of every client→host message,
`send` and `create` included, and only some of its members are typeable. When both are in play, say
"a typed Command" for this one.
_Avoid_: slash command, action, tool — **tool** especially, which is what a model calls.

**Enquiry**:
The whole of one tool call asking its human — one to four Questions, held open **inside the turn that
asked it**. It occupies the Agent Session while it waits, is answered once and wholly, and cannot
outlive its turn: one left open by an unclean shutdown is closed as aborted, the way a torn turn and
its Subagents are. Identified by the tool call that asked it, so it is addressable without a new id
space. It is not a Command (nobody triggered it), not a message (it never becomes a user turn), and
not a Permission Prompt (nothing is being authorised — the tool is already allowed to run; the human
is supplying its input). Only a backend with a channel to ask through has them: `Capabilities.enquiries`
says which.
_Avoid_: ask, prompt, dialog, poll, permission.

**Question**:
One of an Enquiry's parts: a sentence asked, a short header naming the decision, whether several
Options may be chosen, and two to four Options. An **Option** has a label and a description; an
**Answer** is the labels chosen for one Question, or the human's own words where none fitted — which
the vocabulary does not distinguish, because the Options sit in the transcript beside the Answer and a
reader can see for themselves.
_Avoid_: choice, poll, and `option` for the whole of one.

**Permission Prompt**:
One tool call held open on a human's authorisation, inside the turn that made it. Identified by that
call, so it is addressable without a new id space, and answered once with one of three decisions —
allow it, refuse it, or authorise the tool for good. It occupies the Agent Session while it waits and
cannot outlive its turn: one left open by an unclean shutdown is closed as refused, the way a torn
turn, its Subagents and an open Enquiry are. Only raised for a tool nothing has already authorised,
which is what makes it rare. It is what CONTEXT.md's Enquiry entry says an Enquiry is not: here
something *is* being authorised, and the human is not supplying a tool's input but deciding whether
it runs at all. Only a backend that can be asked before it acts has them: `Capabilities.permissions`
says which, and pi has none — so a pi Agent Session runs whatever pi runs.
_Avoid_: approval, confirmation, gate, dialog; and **enquiry**, which is the other thing a turn can
wait on a person for.

**Standing Authorisation**:
A tool a human has authorised for every Agent Session on the machine, so no Permission Prompt is
raised for it again. A fact about the Settings rather than about any Agent Session: granted by
answering a Permission Prompt with Always, listed and revoked in the Settings, and read by a Backend
Session when it opens rather than watched — so one granted now reaches an older session on its next
Revive. A name and not a rule, which is the whole of its coarseness: it cannot say "this tool with
these arguments", so one grant covers every future call.
_Avoid_: permission, allowlist, trust, whitelist — and note the *pre-approved* set a Backend Adapter
ships with is not one of these: nobody was asked for it.

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
models; it is not an agent harness. The Settings section named for them is the one place the word
stretches: it is keyed by Backend Adapter, because a model id is only reachable through the adapter
that serves it.
_Avoid_: backend, adapter, vendor

**Default Backend**:
The Backend Adapter a new Agent Session uses when its creator named none, chosen for the machine
across web and terminal clients. An explicit choice wins; existing Agent Sessions never change adapters.
_Avoid_: default provider, preferred harness

**Default Model**:
The model a new Agent Session starts on when its creator named none. A Setting, and so machine-wide,
but declared per Backend Adapter, because a model id only means anything through the adapter that
serves it. Read when the session is created and never on a Revive, so it can never move an existing
Agent Session off the model it has been running on.
_Avoid_: preferred model, fallback model

**Default Effort**:
The Effort a new Agent Session starts with when its creator named none, chosen per Backend Adapter.
Never reapplied on Revive and never inherited by a Summary Model.
_Avoid_: default thinking, reasoning budget

**Summary Model**:
The model the Session Host uses to name an Agent Session, chosen per Backend Adapter for the machine.
An Agent Session uses only its own Backend Adapter's Summary Model, without the Default Effort.
Reached through an ordinary Backend Adapter, in a throwaway Backend Session that
holds no Presentation Transcript, runs no tools, and is disposed of when it answers — so it is not
an Agent Session, is never Revived, and nothing it says is ever seen (ADR 0020).
_Avoid_: naming model, title model, small model, haiku

**Session Host**:
The daemon process owning every Agent Session and the Steering Queue.
_Avoid_: server, manager, supervisor

**Steering Queue**:
Messages held by the Session Host awaiting the end of the current turn.
_Avoid_: inbox, buffer, backlog

**Lifecycle**:
The half of an Agent Session's state the Session Host writes down: Live, Dormant, Settled or Ended.
The other half — Idle, Running, Awaiting — is derived, because a restart destroys all three of them
and a stored copy could only be wrong. The cut is what a wrong answer costs: a wrong activity draws
a wrong dot until the next event, while a wrong Lifecycle reaps a transcript on a timer.
_Avoid_: state, phase, mode

**Live**:
The Lifecycle of an Agent Session with a Backend Session attached. Never reported as a status on its
own — a Live Agent Session reports which of the three activities it is in instead.
_Avoid_: active, open, attached, running

**Idle**:
The activity of a Live Agent Session with no turn in flight: its owner's turn, to type. Its
Backend Session is attached, which is what separates it from Dormant. Says nothing about whether
work is happening — a backgrounded Subagent or a Background Call leaves it Idle, which is the point.
_Avoid_: ready, waiting, free, dormant

**Running**:
The activity of a Live Agent Session whose model holds the turn. This is occupancy, and nothing
else: a backgrounded Subagent or a Background Call working is not Running, because the model is not.
_Avoid_: busy, working, active, thinking

**Awaiting**:
The activity of a Live Agent Session whose turn is held open on a person rather than on a model —
an open Enquiry or an open Permission Prompt. The reader's turn, to decide, and the one state that
will sit there until they come back. It is occupancy like Running: nothing offered mid-turn may be
offered while it holds.
_Avoid_: blocked, waiting, paused, stuck; and idle, which is the other way it can be your turn.

**Resting**:
The moment an Agent Session last came to rest, by going Idle. What the rail prints beside a row and
orders rows by *within* a Band, in place of a last-activity time that every streamed token
restamped — which floated whichever Agent Session was busiest to the top of the list and reordered
it under anyone trying to read it. Awaiting does not restamp it, though it is equally its owner's
turn: the Band already surfaces it, and a stamp would let a turn that hit two un-authorised tools
jump the working Band on its way back out.
_Avoid_: last activity, updated, touched, modified

**Band**:
Which tier of the rail an Agent Session sits in, ordered by how alive it is: Awaiting, then working,
then Idle, then Dormant, then Settled and Ended together. A row moves when its Band changes and at
no other time, which is what lets a turn stream for an hour without reordering the list. Working is
the one Band that is not simply a status — an Agent Session whose only work is backgrounded
Subagents or Background Calls is Idle and sits there anyway, because sinking it below something that
finished yesterday would hide the thing its owner wanted to watch. It is the one question that does
not care which kind of work it is.
_Avoid_: group, tier, section, bucket

**Dormant**:
The state of an Agent Session with no Backend Session running. Its transcript is readable and it can
be Revived.
_Avoid_: idle — which is now a Live Agent Session with no turn in flight, and the difference is
whether reviving costs anything — and stopped, paused, dead

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
Opted into rather than merely found — a repository Flow can see is a Candidate until it is
listed — and it need not be a repository at all, because someone chose it deliberately.
_Avoid_: scope, workspace, folder, repo

**Candidate**:
A repository Flow found beneath the Project Root that is not a Project yet. Offered only so
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
The single directory Candidates are looked for beneath, and the one Flow reports itself as
open on. Configured, never discovered. It bounds what is suggested, not what a Project may be: a
Project outside it is named by its own path.
_Avoid_: workspace, workspace root, home, cwd

**Entry Document**:
The HTML document the Session Host serves for `/` and for every deep-linked Agent Session. Served
`no-store`, which is what lets every asset it names be cached forever. A build may embed none, in
which case that deployment serves no web client at all.
_Avoid_: shell, app shell, index, page

**Shell**:
A shell process serving an Agent Session, started in its Scope. Ephemeral: unlike a Backend Session
it is never Revived, and it does not survive a daemon restart. An Agent Session may own several, and
they exit when it is Settled, Ended or Reaped.
_Avoid_: terminal, pty, console, session — and note it is unrelated to the Entry Document, which
older prose also called a shell.

**Scrollback**:
The bounded ring of recent Shell output the Session Host keeps so a reattaching client sees a
populated screen. Lossy by design — it is not a Presentation Transcript, and it is never written to
disk.
_Avoid_: transcript, history, log, buffer

**Settings**:
Values the Session Host reads from its state root, governing every Agent Session on the machine
rather than one Scope. Read leniently and written strictly: a value it cannot use costs only its own
default on the way up, but one offered by a client is refused. Machine-wide is the fact most easily
got wrong from a browser window showing one Scope, and the Standing Authorisations are where getting
it wrong costs the most.
_Avoid_: config, preferences, options, profile

**Effort**:
How hard a model is asked to think on a turn. Declared per model rather than per Agent Session,
because not every model offers it.
_Avoid_: thinking, reasoning, budget, thinking level

**Capabilities**:
What a Backend Adapter can be asked to do, declared per Agent Session so clients hide controls
rather than break on them.
_Avoid_: features, flags, support
