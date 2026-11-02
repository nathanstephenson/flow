# 33. In sandbox mode, MCP clients run in the Agent Session's VM

## Status

Accepted. Amends ADR 0024 and ADR 0025 for sandbox mode only.

## Decision

Flow still owns MCP Connections, OAuth credentials, Retry and status (ADR 0024). In sandbox mode the
clients run inside the Agent Session's VM, in the worker process, instead of in the Session Host.
The host keeps a stand-in that forwards `open`, `retry`, `status` and `tools` to the worker, so
Settings, Retry and readiness behave as before. Tool calls stay inside the worker.

Remote MCP traffic therefore leaves from the VM, and the sandbox's egress policy applies to it. A
server's domain must be allowed in the base environment, or its calls are blocked.

OAuth refresh stays on the host. The worker's HTTP transport has no OAuth provider. Its `fetch`
asks the host for the current access token and sets `Authorization`. On a 401 it asks the host to
refresh, then retries the request once. The host refreshes with the SDK's `auth()` and its existing
`McpAuth` provider, saves to the credentials file, and returns only the new access token. The
refresh token never enters the VM, and the authorization server does not need to be allowed in the
VM. Secret-backed header values are resolved on the host and passed to the worker, so they do enter
the VM.

Local MCP servers start as children of the worker in the VM and inherit the supervisor's marker.

Direct MCP Workflow Steps (ADR 0025) of a sandbox session call their tool through the session's
worker, so they also run in the VM. Identity and schema checks stay on the host. Workflow authoring
discovery (ADR 0031) only lists tools: remote discovery stays on the host, and local discovery is
refused in sandbox mode.

## Consequences

Sandbox-to-sandbox features that go through the Flow host are unaffected, because they use the
worker channel, not the network. An access token and any Secret-backed header value are readable by
the agent inside the VM until they expire or change. Local MCP server commands must exist in the
guest image.
