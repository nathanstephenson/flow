# Agent Sessions can be imported from Claude Code

Builds on ADR 0001, ADR 0003 and ADR 0028.

People come to Flow with work already under way in Claude Code. Before this change, the only way to
bring that work in was to describe it again in a new Agent Session. Claude Code keeps every
conversation as a JSONL file under `<config>/projects/<scope key>/`, and Flow's Claude records use
the same scope key (`projectKey`). So Flow can read a conversation, and a Revive can continue it.

**An import is one conversation, named by the user.** The `import` command takes a Scope and a
conversation id. The host reads that one file, and copies only that conversation for a continue
import. It never lists or reads another Scope's conversations, and never imports in bulk. This keeps
ADR 0028's rule that Flow "never bulk imports other Agent Sessions' records". The id must be a UUID
before it is joined into a path.

**Listing is per Scope.** `list_imports` lists the conversations Claude Code recorded in one Scope.
An Agent Session is bound to its Scope for life (ADR 0013), so a conversation from another directory
could not be continued here anyway. The list leaves out Flow's own legacy Claude records, which a
pre-isolation Agent Session wrote into the same tree. It marks a conversation that was already
imported, but still offers it, because the conversation may have continued in Claude Code since.

**There are two modes, and neither starts a Backend Session.**
- `continue` copies the conversation into the Agent Session's own `claude-projects` records with
  `importClaudeConversation`. This is the same narrow copy a legacy Revive makes: one UUID, its
  sidecars, no links, and no overwrite. The copy happens at import time, so the Conversation
  Context matches the Presentation Transcript, even if Claude Code appends to its file later. The
  Agent Session is Dormant with the conversation id as its resume token. Its first message Revives
  it through the ordinary path (ADR 0003).
- `view` copies nothing but the transcript. The Agent Session is Ended: readable, never Revived and
  never Reaped. It needs no backend, so it works on a host without the Claude adapter.

**The Presentation Transcript is translated, not copied.** The importer turns Claude Code records
into ordinary Agent Events with their original times. These include `user_message`, `turn_started`,
`message`, `thinking`, `tool_started`, `tool_ended`, `compacted`, `notice` and `turn_ended`. It drops
what a human never saw: request blobs, file-history snapshots, meta caveats, the compaction summary,
redacted reasoning and Subagent sidechains. It rebuilds slash commands and `!` shell commands as
typed, and shows their output as notices. A tool call with no recorded result is closed as an error,
so it does not spin forever. Prompt images become Attachments when Flow supports their media type.

**Records are read in file order.** Claude Code rebuilds a conversation by walking `parentUuid` from
the leaf. But the results of parallel tool calls hang off sibling branches, and a walk drops them. So
the importer reads the file in order and skips duplicate records. An abandoned rewind branch can then
appear in the transcript. That is a smaller error than a tool call with no result.

**An import opens with no Capabilities.** The transcript opens with `session_started`, as every
transcript does, but its model list is empty: no Backend Session has served it yet. `create` never
returns an Agent Session without models, so an empty list on a stopped Agent Session can only mean
an import. The web composer lets such a Dormant session be sent to, since sending Revives it. On the
first Revive, the host writes `capabilities_changed` unless the adapter has already done so.

**The source is named on the wire.** Commands carry `source: "claude-code"`, and the meta records
`imported: { source, conversationId }` apart from `resumeToken`. The token moves when the backend
forks the conversation, but `imported` keeps naming the original. A second source is then a new
member of `ImportSource`, not a change to the commands.

The TUI does not offer Import yet. `flow import` covers the terminal.
