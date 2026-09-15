# 24. Flow owns MCP connections and tools

## Status

Accepted.

## Decision

Settings hold MCP Connections. Each has a stable ID, a display name, a local command or remote HTTP URL, and an `enabledByDefault` value that defaults to true. Only tools are supported. Flow does not load Pi extensions or Claude project MCP settings to supply these tools.

An Agent Session stores its selected connection IDs. Defaults apply only at creation. Revive preserves the IDs and reads the current definitions. Deleted definitions are ignored when creating or reviving an Agent Session; deletion does not change an open Backend Session. Existing Agent Sessions without stored selections receive none.

Each Backend Session owns its MCP clients and local processes. The official MCP SDK supplies stdio and Streamable HTTP transports. Connection startup is asynchronous and bounded, so an unavailable service cannot stop an Agent Session from opening. Connection status is separate from the Presentation Transcript. Retry reconnects the selected definition snapshot, not newly edited Settings. Retry requires an Idle Agent Session without Subagents, Background Calls, or Workflow Steps in flight and refuses to interrupt an active MCP call. New model work waits for any Retry already in progress.

Pi receives ordinary custom tools and keeps extensions disabled. Claude receives Flow-owned SDK servers that forward tool calls to the same clients. Tool registration removes and re-adds these servers at the safe boundary before model work starts; replacing servers under the same IDs does not refresh the Claude SDK tool catalog. Subagents and Workflow Steps inherit those clients. Existing permission rules remain in force: Claude asks for ungranted tools; Pi parent turns and ordinary Subagents run tools without Flow Permission Prompts; Workflow Steps obey their configured permission mode.

OAuth uses one identity per connection and endpoint on the machine. Credentials are stored in a separate file with mode `0600`, never in Settings or Settings responses. Sign-in uses a short-lived loopback callback, random state, PKCE, and the official SDK's authorization-server discovery and client registration. Changed endpoints cannot receive credentials from the old endpoint.

## Consequences

Agent Session creation remains nonblocking. The first model prompt and Workflow Step wait for bounded discovery and registration before starting. Failed connections remain visible with Retry rather than preventing unrelated work. Registration cannot overlap parent turns, Subagents, Background Calls, or Workflow Steps.

This keeps credential storage and tool lifetimes under Flow's control, at the cost of two small adapter bridges. OAuth servers must support dynamic public-client registration. Legacy HTTP+SSE transport, resources, and prompts are not included.
