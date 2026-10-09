# 31. Workflow authoring discovers MCP tools without Agent Sessions

## Status

Accepted. Extends ADR 0024 and changes the authoring-discovery requirement of ADR 0025.

## Decision

The workflow editor discovers tools directly from configured MCP Connections. It does not require
creating an Agent Session or opening a Backend Session. Authoring Scope is the opted-in source
Project, or the machine-wide Project Root / host starting directory, shared with the builder's
reference Scope. The connection picker lists all configured connections; choosing one discovers
its tools. Workflow execution and step testing still require an owning Agent Session with those
connections enabled, and still compare pinned transport/server/tool identities and schemas.

A host-owned authoring service initializes MCP clients, lists tools and validates each schema,
then disposes the clients. It never calls a tool. It uses current credential storage, existing
noninteractive direct transport behavior, bounded startup, capacity, output and a short Scope/
directory-identity/transport-identity/isolation-policy cache. Directory identity is checked before
startup and after discovery/cleanup and passed to stdio launch preparation. Linux unrestricted
stdio starts from a validated, retained directory descriptor; Bubblewrap validates the exact
Scope descriptor it mounts. Platforms without descriptor-bound stdio launch fail closed for
stdio authoring discovery; HTTP discovery remains available. Concurrent readers share discovery,
not callable handles.
Unavailable connections and incompatible tools carry safe diagnostics; one failure need not hide
compatible tools. The ten-second authoring deadline starts at request admission and includes Scope
checks, queue wait, initialization and disposal response waits. Expired queued work is removed and
cannot start later when cleanup capacity becomes free. Scope canonicalization and directory
identity checks run on all platforms in a guarded, bounded metadata helper, not the Session Host;
identical pending checks share a helper without caching completed identities. The editor applies a
fifteen-second deadline to metadata requests, including response body reads, and offers manual Retry
on failure. Authoring requests have a bounded response, but stdio capacity and cleanup remain
owned until the supervisor reports actual leader exit and process-group cleanup, not merely bounded
transport close. Host shutdown stops admission and retains ownership through that cleanup.

The restricted builder reads a virtual `mcp-tools.json` through its existing host read capability.
The catalogue discovers default-enabled connections and includes explicitly discovered cached
connections. It contains exact tool snapshots and diagnostics, not URLs, arguments, credentials,
MCP clients or invocation functions. Schemas and other service-provided metadata are untrusted data.
Writes can introduce only snapshots supplied by the host, or preserve original snapshots unchanged;
the model cannot fabricate or edit their identity/schema fields. The authoring Scope must still
match the builder's pinned Scope. The builder supplies its pinned directory identity to discovery,
and validates the catalogue's captured identity as well as checking before and after catalogue
reads. An A → B → A path swap cannot admit tools from B. Darwin per-read Scope checks use the
bounded, killable reader helper rather than host metadata I/O. The builder receives no external MCP tools or additional native
capabilities and cannot invoke the discovered services.

## Consequences

MCP steps are readily authorable without a throwaway conversation. HTTP services may need prior
sign-in in MCP Settings. Local stdio discovery **starts configured server code**, even though no
`tools/call` is issued: it uses the normal filesystem-isolation policy and can write within Scope;
when isolation is off, that code has unrestricted host filesystem authority. This is not a promise
that server initialization is side-effect-free, nor a weakening of the builder's own filesystem
capabilities. Disabled-by-default connections are not automatically started by builder catalogue
reads; the human can select them in the editor first.

Discovery snapshots are authoring data, not live execution authorization. Config/server/schema
drift remains fail-closed at execution, and retrying discovery does not retry a remote mutation.
