# 37. Agents communicate through host-owned Agent Session capabilities

## Status

Accepted.

## Decision

Ordinary parent agents receive four host-mediated tools: `session_list`, `session_inspect`,
`session_create` and `session_send`. They operate host-wide, across Projects. The worker receives
callbacks through explicit, validated RPC methods, never the Session Host token, Settings, backend
state directories or a general-purpose host API. Workflow Builders, Summary Models, Workflow Steps
and ordinary Subagents do not receive these capabilities.

Discovery and inspection are read-only and pre-approved. They neither Revive stopped work nor
acknowledge Attention. Inspection returns bounded pages of the Presentation Transcript, not another
Backend Session's private Conversation Context. Entry count and serialized content are bounded;
oversized entries carry a truncated preview. Older pages use the returned start ordinal.

Creation and messaging follow the Backend Adapter's existing Permission Prompt, permission mode
and Standing Authorisation policy. Creating an independent Agent Session does not copy Conversation
Context. Its Scope and Backend Adapter default to the caller's; its MCP selection and permission
policy are inherited (Claude Auto becomes Ask when selecting another backend). Optional Worktree
creation uses the existing host path. No tool can change another Agent Session's permission mode,
answer its Enquiry or decide its Permission Prompt.

Agent messages carry the sending Agent Session's host-owned ID and an explicit “not human
authorization” label in both the Presentation Transcript and the receiving Conversation Context.
Delivery uses `after_turn`: Idle work starts now, busy work keeps its turn and receives the message
from the Steering Queue afterwards. Dormant and Settled work may be Revived; Ended work refuses.
Self-messaging is refused. Delivery acknowledges acceptance, not a reply; agents inspect later or
send an explicit reply to the sender's ID. There is no implicit forwarding or synchronous wait.

Capabilities are bound to a live Backend Session and revoked on replacement, stop or host shutdown.
Mutating calls check cancellation before accepting effects and recheck ownership after asynchronous
Revive. Accepted creation is owned through startup even if its RPC caller disconnects, and drained
before host shutdown disposes Agent Sessions. Creation writes a receipt naming the new Agent Session
into the caller's transcript before initial delivery. A delivery failure returns that ID rather than
hiding successful creation. Cancellation and uncertain transport failures do not imply rollback:
agents must inspect receipts before retrying to avoid duplicate work.

## Consequences

These tools intentionally grant visibility across this local Session Host, not a multi-tenant access
boundary. Permission modes that already run tools without prompting also apply here; the new tools
do not force a second approval policy. Messages and inspected transcripts are untrusted agent data,
not a source of human authorization. Independent Agent Sessions can incur Spend and edit the same
Scope concurrently; use a Worktree when independent edits need isolation.
