# Flow

Flow lets an engineer run and watch coding-agent sessions from a terminal or browser across agent SDKs.

## Language

### Sessions and records

**Agent Session**: The durable unit of work, bound to a Scope and owning a Presentation Transcript. Survives a Session Host restart as Dormant.
_Avoid_: session, run, job

**Backend Session**: The execution boundary serving an Agent Session, owning its Conversation Context, Subagents and Background Calls. Several may serve one Agent Session over its life.
_Avoid_: session, process, connection

**Presentation Transcript**: The append-only record of what a human saw; never compacted.
_Avoid_: history, log, messages

**Conversation Context**: What the model can currently see, owned and compacted by the backend.
_Avoid_: history, transcript, memory

**Spend**: Cumulative billing for an Agent Session across models, including Subagents; not Conversation Context occupancy. Summary Model naming and Git publish text are excluded.
_Avoid_: usage, cost, tokens, context

**Subagent**: Delegated work with its own conversation, owned by a Backend Session and identified by its spawning tool call, not its name. Backgrounded work can outlive a turn, but not the Backend Session, and does not occupy the Agent Session.
_Avoid_: child session, task, sidechain, agent

**Background Call**: A tool call continuing past its turn, owned by its Backend Session and identified by the call. Unlike a Subagent, it has no conversation; it does not occupy the Agent Session.
_Avoid_: background task, async tool, Subagent

**Session Host**: The daemon owning Agent Sessions and the Steering Queue.
_Avoid_: server, manager, supervisor

**Backend Adapter**: The translation of an agent SDK into Agent Events and session commands.
_Avoid_: driver, provider, runtime, plugin

### Human interaction

**Attachment**: A file added to a message, stored with its Presentation Transcript and carried into Conversation Context. Only images are supported today; output markdown images are distinct.
_Avoid_: upload, blob, paste, image

**Draft**: Unsent message text and Attachments held only in the browser, per Agent Session or for one not yet created. Not a Steering Queue entry or a selected Scope.
_Avoid_: composer state, buffer, autosave, pending message

**Steering Queue**: Sent messages held by the Session Host until the current turn ends.
_Avoid_: inbox, buffer, backlog

**Command**: A named composer operation performed by Flow, not a model prompt or tool. It occupies the Agent Session but is not a user turn in the Presentation Transcript.
_Avoid_: slash command, action, tool

**Skill**: A named prompt expanded by the backend at the start of a message. Unlike a Command, it enters both records as an ordinary user turn.
_Avoid_: command, prompt template, macro

**Enquiry**: A tool call asking the human one to four Questions, answered once as a whole within its turn. It occupies the Agent Session and requests input, not authorisation.
_Avoid_: prompt, dialog, poll, permission

**Question**: One part of an Enquiry, with a header, selection mode and two to four Options. An **Option** has a label and description; an **Answer** contains selected labels or the human's own words.
_Avoid_: choice, poll, option for a whole Question

**Permission Prompt**: A tool call awaiting authorisation within its turn, occupying the Agent Session. The human allows it, refuses it, or grants Standing Authorisation.
_Avoid_: approval, confirmation, gate, enquiry

**Standing Authorisation**: A machine-wide tool grant held in Settings, applied when a Backend Session opens. It covers the tool, not particular arguments, and is distinct from adapter pre-approval.
_Avoid_: permission, allowlist, trust

### Lifecycle and activity

**Lifecycle**: Stored Agent Session state: Live, Dormant, Settled or Ended. Live activity is derived: Idle, Running or Awaiting.
_Avoid_: state, phase, mode

**Live**: An Agent Session with a Backend Session attached; reports its activity rather than Live as its status.
_Avoid_: active, open, running

**Idle**: Live activity with no turn in flight. Backgrounded Subagents or Background Calls may still be working.
_Avoid_: ready, waiting, dormant

**Running**: Live activity with the model holding the turn, not merely background work in progress.
_Avoid_: busy, working, thinking

**Awaiting**: Live activity with a turn held open on an Enquiry or Permission Prompt. Unlike Idle, it occupies the Agent Session.
_Avoid_: blocked, paused, idle

**Resting**: The time an Agent Session last became Idle, used to order rows within a Band. Streaming and Awaiting do not update it.
_Avoid_: last activity, updated, touched

**Band**: Rail ordering tier: Awaiting, working, Idle, Dormant, then Settled and Ended together. Working includes Idle Agent Sessions with background work.
_Avoid_: group, tier, section, bucket

**Dormant**: No Backend Session is running; the Presentation Transcript is readable and the Agent Session can be Revived.
_Avoid_: idle, stopped, dead

**Settled**: Declared done by its owner, with no Backend Session running. Remains readable and can be Revived, but is eligible for Reaping.
_Avoid_: closed, archived, ended

**Reap**: Delete a Settled Agent Session and its Presentation Transcript after its retention window.
_Avoid_: cleanup, purge, expire

**Revive**: Attach a fresh Backend Session to a Dormant Agent Session, continuing its Presentation Transcript; also un-settles a Settled Agent Session.
_Avoid_: resume, restart, reconnect

**Ended**: Deliberately disposed of, with no Backend Session running. Its Presentation Transcript remains readable, but it cannot be Revived and is never Reaped.
_Avoid_: closed, deleted, settled

### Directories and shells

**Scope**: The working directory an Agent Session is bound to.
_Avoid_: workspace, project, repo

**Project**: A directory its owner has opted into as a candidate Scope, independent of any Agent Session.
_Avoid_: scope, workspace, repo

**Candidate**: A discovered repository beneath the Project Root that is not yet a Project or offered as a Scope.
_Avoid_: project, suggestion

**Worktree**: A Scope created and owned by the Session Host from a Project. Bound at Agent Session creation and removed on Reap only when clean.
_Avoid_: checkout, clone, workspace

**Project Root**: The configured directory beneath which Candidates are discovered; does not restrict Project locations.
_Avoid_: workspace root, home, cwd

**Entry Document**: The HTML document served for the web client's root and deep links.
_Avoid_: shell, app shell, index

**Shell**: An ephemeral shell process serving an Agent Session in its Scope; never Revived.
_Avoid_: terminal, pty, console, session

**Scrollback**: Bounded recent Shell output retained for reconnecting clients; lossy and never written to disk.
_Avoid_: transcript, history, log

### Settings and models

**Settings**: Session Host values governing all Agent Sessions on the machine, not one Scope.
_Avoid_: config, preferences, profile

**Provider**: An inference endpoint serving models through a Backend Adapter, not an agent harness.
_Avoid_: backend, adapter, vendor

**Default Backend**: Machine-wide Backend Adapter choice for new Agent Sessions when none is specified.
_Avoid_: default provider, preferred harness

**Default Model**: Per-Backend Adapter model choice for new Agent Sessions when none is specified; never reapplied on Revive.
_Avoid_: preferred model, fallback model

**Default Effort**: Per-Backend Adapter Effort choice for new Agent Sessions when none is specified; never reapplied on Revive or inherited by a Summary Model.
_Avoid_: default thinking, reasoning budget

**Summary Model**: Per-Backend Adapter model used to name Agent Sessions and draft editable Git publish text through a throwaway Backend Session, outside their Spend.
_Avoid_: naming model, title model, small model

**Effort**: How hard a model is asked to think, with available levels declared per model.
_Avoid_: thinking, reasoning, budget

**Capabilities**: What a Backend Adapter can do for an Agent Session, used by clients to expose supported controls.
_Avoid_: features, flags, support
