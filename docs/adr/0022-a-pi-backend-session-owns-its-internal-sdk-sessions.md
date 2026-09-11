# A pi Backend Session owns its internal SDK sessions

A Backend Session is an ownership and lifetime boundary, not a count of SDK sessions. The pi
Backend Adapter may create internal SDK sessions to execute Subagents through Flow-owned custom
tools. Those Subagents remain inside the parent Backend Session: they have no separate Flow Agent
Session, Presentation Transcript, or Revive operation.

The target is the existing Claude Subagent experience in Flow. Implementation choices should
preserve its visible behaviour, including attributed output, concurrent work, foreground and
background execution, and completion reporting. Differences need an explicit scope decision or
an established SDK limitation; implementation simplicity alone is not a reason to remove behaviour.

The adapter owns their execution, event attribution, cancellation, and disposal. The Session Host
continues to own Agent Sessions and the Steering Queue; it does not manage the internal SDK
sessions. A Subagent's conversation stays separate from the parent's Conversation Context, with
its result returned to the parent.

For the first pi milestone, only the parent model may ask an Enquiry. Internal SDK sessions do not
receive the question tool. A Subagent that needs human input returns that need to the parent, which
may ask during its own turn. This keeps an Enquiry inside the turn that owns it and prevents
background work from asking while the parent has no turn open.

Subagents are limited to one level for this milestone. Only the parent receives the Subagent tool;
internal SDK sessions cannot use it to create further Subagents. Multiple sibling Subagents may
run concurrently. This bounds attribution and cancellation without preventing parallel work.

The parent may specify a model and Effort when launching a Subagent. Each omitted value inherits
from the parent at launch; later changes to the parent do not change an existing Subagent.

Creating separate Flow Agent Sessions would introduce independent lifetimes and Revive semantics
where none belong. Keeping the work inside the adapter avoids that, at the cost of making the pi
adapter responsible for child execution and failure handling rather than only translating SDK
events.

## Execution and completion

The `subagent` tool defaults to background execution, matching Claude's Agent tool. Setting
`run_in_background: false` holds the spawning call until the Subagent returns. Internal SDK
sessions inherit the parent's active tools, without `subagent` or `ask_question`, and use in-memory
Conversation Context. Child message and tool ids are qualified by the spawning call id so identical
SDK ids from two Subagents cannot overwrite each other in the Presentation Transcript.

The pi `bash` tool accepts `run_in_background`; `bash_output` reads its bounded output and
`kill_shell` stops it. Execution, truncation, shell Settings, and process-tree cancellation use pi's
own Bash implementation. A foreground Subagent's Background Calls stop when it returns its final
response, matching Claude's `backgroundEndsWithFinalResponse` contract. A background Subagent's
Calls can continue afterwards, retaining that Subagent's attribution until the Backend Session ends.

Completion notifications wait until the parent is Idle and manual compaction has finished. The
adapter delivers them as custom context messages, not human messages or duplicate tool results,
and opens a new Flow turn. Flow ends pi turns on `agent_settled`, not `agent_end`: the latter arrives
before the SDK is ready to accept new work. Ending first lets the Session Host dispatch queued human
messages before pending completion notifications; pi's native follow-up queue remains unused.

Abort stops the current turn and its foreground Subagents, not independent background work.
Disposal cancels all owned work, waits for SDK sessions and processes to stop, and suppresses new
completion turns. Undelivered notifications are discarded with the Backend Session rather than
Revived as independent work. Spend reporting is unchanged and remains a separate pi gap.

`test/backend/pi-work*.test.ts` exercises these paths through the installed SDK, a local model
endpoint, real shell processes, and the Session Host. It includes concurrent Subagents, model and
Effort inheritance and overrides, tool restrictions, failures, retry waits, compaction, Steering
Queue ordering, and shutdown.
