# Worktrees live under the state root and are reaped only when clean

An Agent Session can be started in a Worktree the Session Host cuts for it, at
`<stateRoot>/worktrees/<repo>/<branch>`, and a reap removes that directory only when
`git status --porcelain` comes back empty. This is the first thing in GoodHarness that runs git —
before it, the only git knowledge in the tree was one `statSync` on `.git` telling the Candidate walk
where to stop.

**A Worktree is a Scope, so it is chosen at birth and never entered later.** That an Agent Session is
bound to its Scope for its whole life is stated in the glossary, asserted in `src/cli/main.ts`, and
printed to the person creating one — "It is bound to this Scope for its whole life". A different
directory is a different Scope, so "switch this Agent Session to a worktree" is not a switch at all;
it is a *new* Agent Session somewhere else. Offering it as a switch was rejected for that reason
alone: the alternative was rebinding Scope mid-life, which would have cost an ADR revising Scope, new
dialog copy, a rule for what the Presentation Transcript says across the move, and every Shell
restarted in a new directory — all to avoid the word "new". Switching *branch* is the operation that
genuinely does stay in one Scope, and it is the one this feature offers on a live session.

**Beneath the state root, because the host owns them.** The obvious location was beside the
repository, `<root>/<repo>-<branch>`, and it was rejected on a rule this codebase already has:
`isRepository` counts `.git` as a *path that exists* rather than as a directory, precisely so a linked
worktree is recognised — which means every worktree placed under the Project Root would be discovered
as a Candidate and offered for opting in. That is exactly the list-that-grows-into-noise ADR 0011 was
written to prevent, and it would have needed a new exclusion rule in the walk to undo. Under the state
root nothing has to change: `<stateRoot>` defaults to `~/.goodharness`, the walk skips dotted
directories, and a repository is a leaf, so a Worktree is invisible to discovery three times over.
The cost is a working tree in a directory no human would have guessed, which is real, and is what
`git worktree list` in the origin repository is for.

**Nested by repository so the path still reads.** A Scope's last segment is what a client calls the
Project, so a flat `<stateRoot>/worktrees/<branch>` would have named every Agent Session after its
branch and dropped the repository entirely. Nesting means the Scope ends `<repo>/<branch>`, which
`ScopeLabel` already renders correctly because it draws a Scope as dirname plus basename. The pane
header needed one change: `projectName` takes the basename alone, on the stated grounds that leading
directories "are the same for every Agent Session on this machine, so they cost a line's width to say
nothing" — a premise that is simply false for a Worktree, whose parent is the repository. So it asks
the same question one segment higher when told to. It is told by a boolean, `worktree`, and not by the
repository's name: the name is already in the Scope, and sending it too would be a second source of
truth about where an Agent Session lives, able to disagree with the first.

**Removed only when clean, which is a narrower rule than it first appears.** ADR 0006 is careful that
reaping is "the only operation in GoodHarness that destroys a Presentation Transcript" and that a
Settle stays reversible, "a Settle you regret in the morning is recoverable". Deleting a Worktree
would be a second destructive act on that same one-day timer, from a sweep nobody is watching. What
made a rule easy to write is that `git worktree remove` does not delete the branch ref or its
commits: committed work survives a reap and stays reachable by name, so the only thing ever at risk is
what was never committed — one `status --porcelain`. Always removing was rejected as data loss on a
timer; never removing was rejected because the state root would then accumulate a working tree per
Agent Session forever, which is most of the reason for putting them there. A dirty Worktree therefore
outlives its Agent Session and is announced through an observer, which means the state root can hold
directories no live session points at. Those are derivable — read `worktrees/`, ask git — so no
bookkeeping is added for them here.

**The flag is recorded, not derived from the path.** "Does this Scope sit beneath `<stateRoot>/worktrees`"
would have been shorter, and is how `Project.group` is worked out. The two are not alike: a wrong group
shows a wrong heading, while a wrong answer here runs `git worktree remove` on a directory nobody asked
us to own. The state root is an environment variable and can differ between the daemon that cut a
Worktree and the one that reaps it, and a Scope beneath it can be typed by hand, since
`/api/directories` completes paths anywhere on the machine — so the prefix is both losable and
forgeable. `SessionMeta.worktree` also has to carry the repository and the real branch name, neither of
which the path holds: the path uses the repository's basename, and the branch is flattened on the way in.

**The branch control sits on the composer, not in the pane header.** It was in the header first, on
the rule `composer.tsx` states: the header says what an Agent Session *is*, the composer says what
the next turn will *do*, which is why the model and the Effort level are down there. A branch reads
like identity under that rule. What changed the reading is what the control is *for* — the edits the
next message causes land in this directory on this branch — which makes it a property of the message
about to be sent, and puts it beside the model rather than beside the Project name. It sits in the
composer's one strip of readings (`TurnStrip`) — model and Effort at the left, the Conversation
Context meter centred, the branch at the right.

**The checkout is named in the branch's tooltip, not beside it.** It went through a revision as a
label of its own, which was clearer but spent a permanent reading on something that can never change:
a Scope is fixed for an Agent Session's whole life, so there is no version of it a reader could act
on. The cost of demoting it is worth stating plainly, because it undoes something the label was
introduced to fix: **a Worktree is no longer distinguishable at a glance.** It is legible on hover,
and inferable from a branch named `goodharness/…`, and that is all. If glanceability turns out to
matter, the cheap fix is a different icon for the two cases rather than the label's return.

Nothing here may become a control for the checkout. Anyone tempted is proposing to rebind Scope,
which the first section of this ADR rejects. The wording lives in `src/client/scope-kind.ts` rather
than in either client, for the reason `context-usage.ts` is shared: it is one phrase two front-ends
must say identically. It is "Project checkout" and not "Local checkout" because local mode is the
only mode GoodHarness has, so "local" would contrast with nothing today and mislead on the day it
does — and not "main checkout", which collides with a branch called `main` in the very tooltip that
now has to name both.

## Consequences worth stating

**The branch is reported as last observed, not live.** It is read at create, on Revive, after a switch,
and at the end of a turn — that last one because tools are pre-approved (ADR 0004), so the model itself
can run `git checkout`. It is never polled, so a `git switch` in another terminal leaves the reported
branch stale until one of those happens. Polling was rejected on ADR 0010's reasoning for not caching
the Project walk: it is complexity bought in order to be more often wrong.

**A refused command is a 409, and this is the first one.** `switch_branch` is refused while a turn is in
flight, and git refuses checkouts of its own; both reach the client as `CommandRefused` → 409 with the
reason, on the asymmetry `ConfigError` → 400 already sets. `/api/command` had no such arm before, so
every refusal was a 500 whose message happened to be right. `revive` on an Ended Agent Session is the
same kind of thing and is still a 500; walking through the door this opens is a separate change.

**Telling the model cannot use the Steering Queue.** After a switch the model's earlier file reads are
wrong, so it has to be told, and the queue turned out to be the one channel that cannot carry it:
`send(…, "after_turn")` only queues while a turn is in flight, and a switch is permitted only when one
is *not* — so it would have dispatched immediately as a turn nobody asked for. Pushing straight onto the
queue instead strands the note, because `drain` runs only when a turn ends, so it would arrive *after*
the next message, which is the one order that defeats the purpose. The note therefore rides along with
the next message: it reaches the model before it acts, costs no extra turn, and is not a `user_message`
the human never sent — it is part of one they did.

**A branch read can land out of order.** The end-of-turn refresh is deliberately fire-and-forget, so two
can be in flight at once, and without a guard an older answer overwrites a newer one — leaving the
reported branch wrong until something else happened to correct it. `SessionRecord.branchGeneration` is
that guard, and a switch bumps it too, so a reading taken before the switch cannot outrank it. This was
found as a test that failed about one run in three, not by inspection.
