# 0025: Direct MCP Workflow Steps own transport work, not a Subagent

## Decision

A Workflow Step may name a configured MCP connection and the server's **original** tool name.
Agent-facing generated aliases are not durable tool identities. Discovery is scoped to an explicitly
selected Agent Session; execution and recovery use only connections enabled for their owning Agent
Session. Selection stores hashes of transport configuration and initialized server identity, plus
unaltered discovered input/output JSON Schemas. The Workflow Definition copy pins these values for
an execution. Start and every attempted call compare them with fresh discovery; missing or changed
connections, servers, tools and schemas fail without retargeting.

Each attempt owns a separate `McpSession`, reusing existing configuration and OAuth credential
storage. It never disposes or retries the parent Backend Session's MCP client. The direct HTTP
transport uses existing bearer credentials but no interactive OAuth provider or authentication retry
on a tool POST. Thus a 401 cannot silently replay a mutation. Authentication failures require MCP
Settings sign-in/reconfiguration and an explicit manual decision. Direct requests use the configured
step deadline rather than the agent transport's ten-second HTTP fetch deadline. Initialization and
discovery remain independently bounded at ten seconds.

Direct steps do not invoke an Agent/model or start a workflow Subagent. They do not use or require
the code runtime, and make no claim to its isolation. Private permission callbacks are owned by the
step attempt. They use the existing workflow request envelope (whose legacy `subagentId` routing
field carries an opaque attempt ID) with `direct: true`; no backend handle is allocated. Ask mode
always needs a per-call decision, independent of machine-wide Standing Authorisation. Tests follow
the same path. Activity and output remain private workflow records; the existing completion notice
does not inject a parent composer request or Conversation Context message. There is no Spend event.

## Arguments and output

Recursive argument templates support literals, workflow/predecessor references, objects and arrays.
Graph availability checks traverse every reference. Resolution errors fail the step instead of
escaping the scheduler, preserving failure edges. Explicit JSON and null visual types permit typed
structured fields to be selected for downstream mappings; dynamically selected values are validated
at the consuming step.

Original JSON Schema validation uses AJV, without coercion, default insertion, property removal or
remote schema fetching. Draft-07, 2019-09 and 2020-12 are supported, with 2020-12 as the MCP default.
Unsupported dialects, unresolved external references, formats and keywords fail explicitly. The
schema-driven editor exposes composition, local refs, conditional/dependent fields, tuples, maps,
primitives and arbitrary JSON construction alongside the original constraints. Presentation hints
are not validators; the original schema is authoritative once all references resolve.

Successful output is `{ structuredContent: JSON | null, content: MCPContentBlock[] }`. Returned
blocks are preserved; text is never automatically parsed, and resource links are not fetched.
Discovered output schemas validate structured content. `isError` is failure even when transport
succeeded; successful empty/not-found data is not failure. Error results may become partial output
for ordinary failure edges and manual recovery. The complete serialized result must fit 100,000
UTF-8 bytes, before and after credential redaction. Oversized results fail without truncation or
partial retention. Supply output uses the same envelope, schema and size validation.

Configured credential values (including OAuth tokens, client secrets, and recognized credential
URL/argument fields) are excluded from durable arguments, output, partial output and errors.
Definition/start/recovery gates reject known credentials; service output and private activity are
redacted before persistence, with a store-level redaction safeguard. Common escaped and URL-encoded
forms are covered. As in ADR 0023, literal redaction is not a defence against arbitrary deliberate
encoding, or unknown credentials independently loaded by an external server.

## Failure and lifecycle

The default deadline is sixty seconds and includes permission waiting. Cancellation/timeout abort
owned local work and close its transport; unrelated parent calls are unaffected. This is not
rollback: a remote mutation may have completed even when the response was lost. No automatic retries
are scheduled. Existing failure/timeout edges, bounded loops, joins, durable attempts and manual
Retry/Supply output semantics apply. Restart interrupts in-flight work and requires recovery rather
than replay. Retrying revalidates pinned identity and schemas. Server drift requires a newly selected
definition/execution (or Supply output), not silent mutation of an old snapshot.
