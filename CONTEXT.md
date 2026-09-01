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

**Presentation Transcript**:
The append-only, sequence-numbered record of what a human saw. Never rewritten, never compacted.
_Avoid_: history, log, messages

**Conversation Context**:
What the model can currently see. Compacted and owned by the backend, not by GoodHarness.
_Avoid_: history, transcript, memory

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

**Revive**:
Attaching a fresh Backend Session to a Dormant Agent Session, continuing the same Presentation
Transcript.
_Avoid_: resume, restart, reconnect

**Scope**:
The working directory an Agent Session is bound to.
_Avoid_: workspace, project, repo

**Effort**:
How hard a model is asked to think on a turn. Declared per model rather than per Agent Session,
because not every model offers it.
_Avoid_: thinking, reasoning, budget, thinking level

**Capabilities**:
What a Backend Adapter can be asked to do, declared per Agent Session so clients hide controls
rather than break on them.
_Avoid_: features, flags, support
