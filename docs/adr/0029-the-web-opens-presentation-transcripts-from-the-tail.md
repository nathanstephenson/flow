# The web opens Presentation Transcripts from the tail

The durable Presentation Transcript remains append-only and sequence-numbered (ADR 0001). This
changes how the web reads it, not what is stored, what enters Conversation Context, or how the
CLI and TUI replay raw Agent Events. A browser opening a long Agent Session must not download and
reduce every past event before showing its latest answer, nor briefly replay past Running or
Awaiting activity into today's composer.

The Session Host lazily constructs a shared, in-memory presentation cache when an Agent Session's
log is first viewed. It reads the complete durable record once to run the existing shared reducer,
then keeps that reduced result current on append. It is a derived cache, not a second durable
record or a competing reducer. Its first construction still reads the entire log server-side;
moving that work off the browser does not make it disappear.

## Snapshot first, then reduced patches

The web opens `GET /api/sessions/:id/presentation/events?limit=400`. Its first JSON SSE frame is a
`snapshot`: the current event `seq`, current `ViewState` metadata without `entries` or `lastSeq`,
a bounded tail of indexed reduced entries, `related` indexed entries outside that tail, and the
loaded `start` ordinal and complete reduced entry `total`. Current metadata supplies activity,
Spend, queue and open controls immediately. Historical events are not replayed into chrome. The
connection becomes live only after the snapshot has been processed, not merely after HTTP 200 or
flushed stream headers.

Following `update` frames carry `seq`, changed or new indexed entries and `total`; a complete
metadata replacement is included when metadata changes. An entry upsert retains its ordinal,
including updates to a row outside the loaded tail. Ordinals are zero-based positions in the
complete reduced transcript, not raw event sequence numbers. New rows receive increasing ordinals;
upserts neither reorder nor renumber earlier rows. The raw SSE subscription and its exclusive
`since` replay cursor remain available unchanged for CLI and TUI consumers.

Backward reads use `GET /api/sessions/:id/presentation?before=N&limit=400`, where `before` is an
exclusive ordinal. Pages return reduced entries with their original indices, `start`, `total` and
the event `seq` at which they were read. The web merges by ordinal, with sequence versions preventing
a delayed page from overwriting a newer live upsert. Pages only extend the rows available to read;
they never restore historical activity over current chrome.

On reconnect the web evaluates its *current* oldest loaded ordinal and supplies it as `start` to
the presentation stream. The next snapshot refreshes that loaded suffix, including backward pages
read since the previous connection opened. Reconnecting from the original tail boundary would
leave those older rows stale. Existing retry, silence watchdog, cancellation and terminal
401/403/404 behavior remain the transport policy. Presentation streams send periodic SSE comment
heartbeats; the watchdog counts incoming bytes without presenting those comments as updates. An
Idle Agent Session must not repeatedly download its loaded suffix merely because it has no new
events. Authenticated pages and streams are marked `no-store`.

## Missing rows stay explicit

Mounting a transcript does not automatically fetch the rest of it. Reading earlier entries is an
explicit backward-page operation. Search also explicitly loads missing pages when asked to search
beyond the loaded portion, and reports the boundary honestly: a match count over loaded rows is
not a claim that the whole Presentation Transcript has been searched. A page failure stops the
search without automatic retries; a successful explicit retry resumes the remaining pages of the
same query. Before exposing a backward extension to React, and again before notifying either
reactive surface if it remains uncommitted, the store exposes a measurement phase. Backward
loading from any pane preserves the main transcript's visible row, without accumulating fractional
scroll rounding over successive search pages or overriding subsequent reader movement.

A snapshot's event cursor proves delivery, not observation of a qualifying outcome. Indexed rows
carry an optional `outcomeSeq`, derived alongside the full reducer, for the exact outcome boundary
represented by that row. A metadata-only turn ending still publishes this proof. Reused or
reopened rows revoke superseded proofs. Unchanged old receipts and late progress retain their
existing proofs across newer turns, including an abort; actual outcome changes do not. Late tool
progress or independent Workflow notices cannot
replace the parent answer (or actual tool-only result) as its completion proof. Unread is
acknowledged only when that exact boundary is present on a rendered parent row and the existing
paint, focus, visibility and latest-follow checks pass. Producer-only tails, hidden old-row upserts,
and newer input requests cannot silently acknowledge an unseen answer. Needs input is not
auto-acknowledged: its cursor can coincide with an unrelated outcome's proof. Visible latest answers can
still be acknowledged without downloading unrelated older history.

Subagent cards cannot depend solely on the tail: their spawning rows may be much older while their
work is still running. The snapshot's `related` entries retain those older cards and unresolved
controls so current work is not silently omitted. Related entries do not pretend that all rows
between them and the tail have been loaded. Loading a Subagent's own prior rows is likewise an
explicit operation, rather than a reason to download the parent's entire transcript on mount.
An Idle parent can still have running Subagents or Background Calls (ADR 0016 and ADR 0021).

## Costs and limits

This bounds the initial transcript suffix by entry count, not bytes. Related activity cards and
unresolved controls are retained separately and can grow with the number of delegated jobs. A
single reduced entry, tool result or metadata field can still be large. Reconnect deliberately refreshes the loaded suffix, which can
grow as the reader requests more pages. The cache retains the complete reduced result in Session
Host memory, and the existing reducer still does O(n) work; this is not an incremental-reducer
complexity improvement. First-cache construction remains a full server-side replay.

This decision adds neither virtualization nor destruction of previously loaded rows. Explicit
backward reading and search can still grow browser memory and DOM work toward the complete reduced
transcript. Those are separate problems; tail-first loading removes mandatory full browser replay
from opening an Agent Session without sacrificing the durable Presentation Transcript or hiding
its unloaded boundary.
