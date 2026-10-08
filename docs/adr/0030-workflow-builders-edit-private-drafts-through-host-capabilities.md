# 30. Workflow builders edit private drafts through host capabilities

## Status

Accepted (NAT-93).

## Decision

Settings → Workflows offers a conversational builder beside the visual editor. It owns a throwaway
Backend Session, not an Agent Session in the rail or a Workflow Execution. Its conversation and
Spend are visible in the editor; closing the builder discards them. Session Host shutdown stops
builder work, and abandoned builders expire rather than retaining workers indefinitely. Startup
cancellation revokes capabilities immediately, but owns late adapter disposal and retains its private
directories until startup and actual disposal have settled. Only caller-facing waits are bounded; a slow
`dispose()` remains owned, keeps its private directories and capacity slot, and is awaited by shutdown.
Host-mediated draft writes remain owned through interrupted IO/rollback too, before directory removal.
The view's `stopping` flag keeps Apply and further messages disabled while cleanup is pending.
Cancellation accepts only the retiring Backend Session's final cumulative Spend until disposal,
never its late tools or conversation output.

The builder edits its own private `workflow.json` draft. It cannot write saved Workflow Definitions,
Project files, host Settings, or execution records. The human explicitly applies a validated draft
to the visual editor, then uses the existing Save action. Applying is refused if the editor changed
since the builder started. Changing the workflow, Backend Adapter, or Project closes the old
builder; a builder cannot broaden its read Scope by changing its definition identity or Project.

For a project-specific definition, the read Scope is the opted-in source Project. For a machine-wide
definition, it is the configured Project Root, falling back to the Session Host's starting directory.
The resolved read Scope is displayed. These are references for authoring, not the eventual execution
Scope: a Workflow Execution still uses the Agent Session's actual Scope.

The model gets only three host-mediated capabilities: read a reference file, list a reference
directory, and replace its own workflow draft. Reference paths are bounded to the pinned read Scope,
reject symlink traversal and special files, and exclude protected host state and credential stores.
Writes validate the workflow graph and its fixed identity before replacing the previous draft.
Invalid writes leave the last accepted draft unchanged. Initial authoring input may be incomplete,
including blank names/model selections and broken edges or mappings; it is never executable. Every
agent write still requires a complete valid graph. Built-in filesystem tools, shell tools,
Subagents, external MCP tools, resource extensions, and hooks are not available. Both Claude and Pi
use this restricted tool set; the worker bridge independently denies unrelated host capabilities.
Questions are ordinary assistant text, not Enquiries requiring a second composer implementation.

Linux reference reads walk descriptor-relative `/proc/self/fd` paths. macOS 11+ uses a feature-probed
`O_NOFOLLOW_ANY` guard and a disposable, builtin-only reader process: its cwd is checked against the
inherited Scope descriptor, and any listing cwd change happens only inside that helper. Darwin's
`/dev/fd` does not support Linux-style child traversal. Unsupported guards fail closed; there is no
realpath-only fallback. Directory identities use BigInt to avoid rounding inode numbers. Helper
lifetime and output are bounded, and closing waits for active readers before closing the root fd.
Darwin refuses cross-device references, but same-device mount aliases are not independently
detectable. Keep mounted aliases to protected data out of the read Scope; path guards do not
provide a separate mount namespace or protect against privileged mount changes.

This capability restriction applies even when machine-wide filesystem isolation is off. It does
not claim to sandbox the trusted SDK or prevent authorised inference network requests. Normal
Backend Session worker isolation policy still applies; the model has no tool with which to invoke
arbitrary code or obtain broader filesystem authority. Builder instructions include Flow's workflow
contract and model catalogue, not executable Project instructions or a new graph format.

## Consequences

- Unsaved and new definitions can be built without first saving an invalid placeholder.
- Model output cannot silently overwrite newer visual changes or saved definitions.
- Closing the editor is intentionally not a durable Agent Session lifecycle operation.
- No shell search, workflow execution, or MCP discovery is offered inside the builder. Existing
  MCP snapshots can be preserved, but selecting new MCP tools remains a visual-editor operation.
- Project files remain untrusted reference data. Read-only access is not a confidentiality guarantee
  for everything the owner permits inside that Scope; do not place protected-file aliases there.
