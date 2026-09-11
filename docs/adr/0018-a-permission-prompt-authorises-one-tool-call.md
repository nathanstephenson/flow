# 18. A Permission Prompt authorises one tool call

Date: 2026-09-09

## Status

Accepted.

## Context

The Claude adapter pre-approved a fixed list of tools and **refused everything else**. A tool outside
`DEFAULT_ALLOWED_TOOLS` got `"X is not enabled for this session. Continue without it."` The reasoning
was sound — a fall-through with nothing to resolve it stalls the turn — but the effect was that Flow
had one mode: auto-approve, or nothing. The human was never asked.

What actually reached that fall-through was measured rather than assumed, and it shapes everything
below:

- **`BashOutput` and `KillShell`** — how a backgrounded `Bash` is read and stopped. Refused, which
  was a latent bug: the tool that *started* the job was allowed. Under a naive version of this change
  they would raise a prompt on every poll of a background job, making the most benign pair in the set
  the loudest. They are now pre-approved, and that is a bugfix this decision carries rather than a
  permission question.
- **Every `mcp__*` tool.** This is the feature. `gdrive__trash_file`, `github__*` writes, `slack_*` —
  tools with real consequences outside the Scope, unreachable until now and exactly the ones a human
  should be asked about.
- `SlashCommand`, `AskUserQuestion` (parked already), and whatever the next CLI release adds.

ADR 0016 established that this can be done at all: a `canUseTool` callback can be held open on a
person for minutes, provided every path that ends the turn settles it. It also fenced the term off —
CONTEXT.md's Enquiry entry says an Enquiry is *"not a Permission Prompt (nothing is being authorised
— the tool is already allowed to run)"* — and ADR 0015 reserved `SubagentWait`'s `"permission"` value
ahead of it. The name existed in the ubiquitous language with nothing behind it.

## Decision

**A Permission Prompt authorises one tool call, is decided inside the turn that made it, and every
path that ends that turn settles it.**

Six things follow, and they are the decision:

**It is keyed by the tool call it is about, and folded onto that call's row.** `callId` is the SDK's
`toolUseID`, so no new id space — the rule ADR 0015 sets for a Subagent and ADR 0016 reuses for an
Enquiry. But where an Enquiry gets its own Entry and *suppresses* the tool row, this gets no Entry at
all: the decision is an `authorisation` field on the `tool` Entry, set through the `patchTool` the
reducer already has. The row a reader needs is the one already naming the tool and précising its
arguments; a second row would print `WebFetch https://…` and then `Permission: allowed` underneath
it. This is what keeps the change out of four exhaustive switches over `Entry["kind"]`, out of
`search.ts` and out of `subagent-rows.ts`.

**The event carries the tool's name and nothing else.** Not the input: `tool_started` already put it
in the same transcript under the same id, and a Presentation Transcript is read in full on every load
(ADR 0001) — an authorised `Write` would otherwise write its file into the record twice, the mistake
`attachments` are ids to avoid. `toolSummary()` already turns those arguments into a line for both
front-ends, so what a human is asked to allow reads exactly like the row above it. The name *is*
carried, because a composer is handed the chrome and nothing else.

**A refusal says nothing about the human.** The message the model reads back is verbatim the
adapter's own pre-existing one — `"X is not enabled for this session. Continue without it."` A model
told "the human declined" learns there is somebody in the loop and spends the turn negotiating; one
told the tool is unavailable moves on. Which decision produced it belongs in the transcript, where a
reader can see it, and not in the Conversation Context. The SDK's `interrupt` flag on the deny branch
is deliberately unused: Deny ends one call, and Abort ends the turn.

**A no lasts the turn; a yes can last forever.** A refused tool is refused silently for the rest of
the turn, because a model that wanted a tool wants it several times and re-asking the moment someone
says no pins the composer on the same question while the model rephrases. It is cleared in `endTurn`
beside `subagents.clear()`: a no was about what was being attempted, not about the tool forever. The
Always decision is the only thing here that outlives a turn, and it becomes a **Standing
Authorisation** — a Setting, machine-wide, listed and revocable in the Settings.

**Prompts are decided oldest-first, from a single value.** One assistant message can carry several
tool calls, so several prompts can be open at once. `ViewState.authorising` holds the oldest, and
deciding it promotes the next by scanning `entries` for a row still `asked`. Not a list: this reaches
a chrome compared per key by identity, and an array rebuilt on each arrival could never compare equal
— re-rendering the whole chrome on every streamed token, which is what `activeSubagents` is a *count*
to avoid. Held `undefined` rather than empty for the same reason.

**The Settings have one owner, and it is not the host.** The adapter honours a Standing Authorisation
but never persists one: it is handed the list at create time on `BackendCreateOptions`, and an Always
adds the name to its own in-memory set so the rest of that Backend Session stops asking. The Session
Host writes the grant through a narrow bound `allowTool`, not through the store — ADR 0009's rule
that the object owning Agent Sessions must not become the owner of a typeface. **Settle first,
persist after:** crashing between the two loses a grant and the next session asks once more, where
the other order would leave a tool permanently authorised that the human never saw run.

## Consequences

**An unattended session now holds a turn open where it used to continue.** This is the real cost of
the change and it is accepted deliberately. Before, the fall-through returned at once and the turn
finished; now a session with nobody watching waits, with no timeout, on ADR 0016's reasoning — a
timer that abandoned a prompt someone was still reading would be worse than one that waits, and a
client can always attach later. The **one-shot CLI runner is the exception**, because it never can:
it *denies* rather than aborting, which is where it parts company with its own Enquiry branch. A
denial is a complete answer for a permission in a way it never is for an Enquiry, so `flow "do X"`
still finishes its turn where aborting would kill every headless run that touched an MCP tool.

**ADR 0004's blast radius has changed.** That decision rests its threat model on "tools are
pre-approved: an endpoint that accepts a prompt and runs Bash without prompting is an
arbitrary-code-execution endpoint". A local endpoint can now do one thing more — **permanently widen
what is pre-approved, for every future Agent Session**. That is not a step change (Bash and Write
were already auto-approved machine-wide) but it is a new kind of write, and it is why the grant is
listed and revocable rather than only recorded.

**A Standing Authorisation is name-grained, and that is coarse.** `permissions.allow` holds tool
names, not rules: it cannot express `Bash(git:*)` or "this MCP server, read tools only". So one Allow
on `mcp__gdrive__trash_file` authorises every future deletion, in every session, whatever the
arguments. The mitigations are the label — "Always allow on this machine", asserted in
`test/permission.test.ts` because the wording is a safety property — and the revocation list, which
is what makes a coarse grant recoverable. The SDK's own `updatedPermissions`, `suggestions` and
`matchedAskRule` are rule-grained and were **not** used: they would put the grants in a file Flow
does not own, where the list could not be shown or revoked. That is a trade worth revisiting, and it
is the thing to probe first if the grain proves too coarse in practice.

**Precedence is operator deny > Standing Authorisation > prompt.** `allowedTools` is given only the
pre-approved set and a grant is honoured in `canUseTool` instead, so `disallowedTools` — which an
operator meant — cannot be undone by a grant a human clicked.

**`permissionMode` stays `"default"`.** `bypassPermissions` auto-approves *before* the callback,
which would take away the only place a tool can be held open on a human. Nothing about asking rather
than denying changes that, and the paragraph in README.md that described the fall-through as denying
has been rewritten rather than deleted.

**The pi adapter still serves no Permission Prompts.** Custom tools now provide Enquiries and
Subagents (ADRs 0016 and 0022), superseding the earlier claim that pi had no registration channel.
Holding tools for authorisation is a separate integration that the adapter does not implement.
`permissions: false` remains honest, and TODO.md records the gap: Claude sessions ask, while pi
sessions run tools without Flow asking for authorisation.

**A Subagent's Permission Prompt is still not attributable.** The callback carries an `agentID` that
nothing has been observed to populate — the finding ADR 0016 recorded — so `producer` is on the event
and left unset, and `SubagentWait`'s `"permission"` still has nothing to report. It has now been
reserved through two decisions without being populated by either.

**Two measurements are still owed, and both are one spike.** Whether `tool_started` reliably precedes
the callback for a fall-through tool is what licenses `patchTool` over an Entry of its own —
`patchTool` silently no-ops when the row is absent, and the ~4 ms lead was measured for
`AskUserQuestion` and never for anything else. Whether the CLI issues concurrent permission requests
at all, or serialises them, is the other. The design is correct either way (the single-valued
`authorising` decides oldest-first regardless, and a torn ordering is a missing row rather than a
stalled turn), which is why it was built before the spike rather than after — but the ordering one
should be run before anyone trusts the transcript to be complete.
