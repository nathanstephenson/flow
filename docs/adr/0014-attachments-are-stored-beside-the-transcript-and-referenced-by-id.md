# Attachments are stored beside the transcript and referenced by id

A pasted image reaches the Session Host as base64 on the `send` command, is written to
`<stateRoot>/sessions/<id>/attachments/<uuid>.<ext>`, and appears in the Presentation Transcript as
that filename and nothing else. The web client renders it with a plain `<img src>` pointing at
`GET /api/sessions/:id/attachments/:attachmentId`. Both Backend Adapters were already able to carry
one — the narrowing was ours: every path from a human to a model in this codebase was a string.

**Bytes on the command, ids in the transcript.** These are two halves of one decision and neither
survives alone. A transcript is read in full on every load and replayed on every Revive (ADR 0001),
so base64 on one of its lines is not a size problem that shows up later; it is a record that stops
being readable at all — one 4K screenshot is a 5 MB line in a file whose whole value is that a human
can open it. Going the other way, keeping the bytes only in flight was rejected against what ADR 0001
says a transcript *is*: the append-only record of what a human saw. Someone who pasted a screenshot
saw a screenshot, and a Revive a week later that shows the words without it is a record that has
quietly edited itself. So the bytes are durable and the transcript names them.

**An upload endpoint was the obvious alternative and was rejected on the orphans.**
`POST /api/attachments` returning an id, then `send` carrying ids, is the conventional shape and it
buys two things: a small command channel, and a cheap retry after a refused send. It costs a route, a
second refusal path for a `send` naming an id that does not exist, and — the part that decided it — a
class of garbage that has no owner. Every paste someone thinks better of leaves bytes at an id no
transcript will ever name, so something has to sweep them, on a timer, against a "was this ever
sent?" question the store cannot answer. Inline has no such class: the bytes arrive in the same act
that commits to them. The precedent for putting a web-only field on a shared command is already here,
in `create.worktree.branch` — "the web client's alone: the TUI has no text entry outside its prompt
line, so nothing it cannot do is hidden behind this field". A terminal has no clipboard image either.

**Written at send, not at dispatch.** `send(…, "after_turn")` queues while a turn is in flight, so
there is a window — possibly minutes — between accepting a message and dispatching it. Holding the
bytes in memory across it would make a queued message one crash away from losing the picture while
keeping the words, which is the specific failure ADR 0001 exists to prevent, arriving through the
back door. So the Steering Queue holds ids and the disk holds the bytes from the moment the send is
accepted. The cost is that an aborted queue leaves files nothing names — the one orphan case that
remains. They are inside the session directory, so a Reap takes them (ADR 0006) with no new
bookkeeping, and deleting them on abort was rejected as code written to reclaim kilobytes on a
single-user local daemon.

**The id is the filename, so the media type is never sent twice.** `<uuid>.png` means
`mediaTypeOf(id)` answers what a `content-type` header and an SDK payload both need, and
`user_message` carries ids alone. Carrying `{ id, mediaType }` instead would be two records of one
fact, able to disagree about a file on disk — and it would leave the HTTP route unable to find the
file from the URL without a `readdir` or a transcript read. This runs directly against the reasoning
in `SessionMeta.worktree`, which writes down what could be derived from a path, and the difference is
the stakes: a wrong answer there runs `git worktree remove` on a directory nobody asked us to own,
where a wrong answer here serves one wrong header. The extension set is closed and checked on the way
in, so it cannot be wrong. That same check is also the traversal guard — `mediaTypeOf` accepts a uuid
and one of four extensions and nothing else, so `../../token` is refused for the same reason a `.txt`
is, and there is no second rule able to fall out of step with the first.

**`acceptsImages` is on `ModelInfo`, not on `Capabilities`.** The session-level flag beside
`compaction` and `fork` was the first shape and it is wrong, because pi's model registry declares
`input: ("text" | "image")[]` per model: a session that can be shown an image on one model cannot on
the next, and a per-session answer would start lying the moment someone switched. `events.ts` already
records the general form of this argument about Effort — it lives on the model "because that is where
both SDKs put it" — and this is the same argument with a different field. The asymmetry between the
adapters is real and is fine: pi reads it, and Claude states `true` outright because
`supportedModels()` reports effort and fast mode but nothing about input modality, every model it
serves being able to see an image. That is the same kind of claim the Claude adapter already makes
about `providers` and `compaction`.

**Serving image bytes at all needs saying, given ADR 0012.** That decision is emphatic — "Images are
not fetched at all — a remote image in a transcript is a tracking pixel with extra steps" — and a
reader who finds an `<img>` in `transcript-entry.tsx` deserves to know why it is not a reversal. It
is not the same thing twice: ADR 0012 refuses to fetch an image a *model* named in its markdown,
where the URL is chosen by the output and the fetch tells a third party that a transcript was opened.
An Attachment is bytes the Session Host holds, put there by the person reading them, served from its
own origin behind the same bearer check as every other route. Nothing is fetched from anywhere the
daemon is not. This is also why the glossary's entry for **Attachment** tells you to avoid the word
"image" for it: the two meanings would otherwise collide in the one file that has to keep them apart.

**Validated at both ends, strictly at the host.** The composer refuses a bad paste with a toast, and
the host refuses the command with `CommandRefused` → 409. That is not redundancy: the composer's job
is to not offer what cannot work, and the host's is the rule the Settings already state — "read
leniently and written strictly: a value it cannot use costs only its own default on the way up, but
one offered by a client is refused". The caps are four media types (Claude's `Base64ImageSource` union
verbatim, since pi will take any string and so the narrower end fixes it), 5 MB of base64 per
attachment, and ten per message. 5 MB clears the strictest provider limit rather than the Claude API's
own 10 MB, and ten keeps every request well under the twenty-image threshold above which a stricter
per-image dimension limit applies to every image in the request — so an oversized paste is quietly
downsized, which is the friendly failure, rather than rejected by the provider. Nothing is downscaled
client-side: the API does it for free, and a canvas round-trip would be work spent to send a worse
picture.

## Consequences worth stating

**The host's model check is a backstop and cannot be the whole rule.** It refuses only when it can
name the model in force, and `record.modelId` is absent whenever nobody overrode the default — which
is the common case. So the positive check ("this model *can* be shown one") belongs to the client,
which reduces `model_changed` and therefore always knows, and an unidentifiable model is allowed
through rather than blocking every default-model session. A client that lied would get an error from
the provider, surfaced as a `notice`. This is the one place where the two ends are not
interchangeable, and it is why the composer treats an unknown model as one that cannot.

**A queued message's Attachments are not previewable until it dispatches.** `queue_changed` still
carries `pending: string[]`, and widening it so a client could show a thumbnail in the queue would
change the shape of an event already written into every transcript on disk. The queue display needs
depth and a preview, both of which a text gives it. Accepted as a limitation rather than solved.

**A model switch can strand a queued Attachment.** Nothing forbids `set_model` between a queued send
and its dispatch, so a message accepted for a vision model can dispatch to one that cannot see it.
The backend's own error becomes a `notice`, which is the existing pattern for a backend refusal.
Guarding it would mean re-validating the whole queue on every `set_model`, for a sequence nobody has
performed yet.

**An Attachment whose file has gone is skipped, not fatal.** `loadAttachments` drops an id it cannot
read and dispatches the rest. That can only mean the session directory was interfered with, and
losing an image from a turn is a smaller harm than refusing to send the words that came with it.

**`serve` now takes the store.** It reads Attachment bytes directly rather than asking the Session
Host for them, because this is a read of a file the store owns and routing it through the host would
put a byte-serving method on the thing that owns Agent Sessions. `src/cli/main.ts` constructs one
store and passes it to both, so there is no second opinion about where they live. Omitting it — as a
Session Host with no state root does — makes the route 404, which agrees with the host, since it
refuses a send carrying one for the same reason.
