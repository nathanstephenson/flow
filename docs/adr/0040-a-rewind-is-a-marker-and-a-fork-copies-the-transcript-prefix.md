# A Rewind is a marker, and a Fork copies the transcript prefix

Keeps ADR 0001.

A Rewind returns the Conversation Context to just before a user message. A Fork starts a new Agent
Session from that point. Claude Code and pi both remove the later messages from their own view. Flow
does not do this in the Presentation Transcript.

**The Presentation Transcript stays append-only.** A Rewind appends a host-owned `rewound` event.
The reducer marks the entries from the user message onward as `rewound` and keeps them. The web
transcript does not show them. The record of what the human saw stays complete, and paging by index stays stable.

**A Fork copies the events before the user message.** The copy keeps the original timestamps and
user message ids, and Flow also copies the Attachments those events refer to. Flow drops the source's
`session_started` and `queue_changed` events and the `scope` of `revived`, because they describe the
source. A `forked` event follows the copy. The Fork stays readable after the source is Reaped.

**The backend cut is persisted by the host.** Neither SDK records a cut until the next message is
appended. The host stores `rewindTo` in the session meta and gives it to every Backend Session it
starts, until a turn starts. A Revive in that window therefore keeps the cut.

**User message ids are shared with the backends.** The host gives each prompt its `user_message`
id. Claude uses it as the SDK message `uuid`. pi has no such field, so the adapter keeps a map from
the id to its entry id beside the session file. Messages sent before this change have no mapping and
cannot be Rewind targets.

**File rewind is Claude only.** Claude has file checkpoints, and Flow keeps them in the backend state
directory so they survive a Revive. A Fork does not copy them, because they refer to paths in the
source Scope. pi has no file checkpoints.

Considered: truncating the Presentation Transcript, which breaks ADR 0001 and index paging; and a
Fork that only refers to its source, which loses history when the source is Reaped.
