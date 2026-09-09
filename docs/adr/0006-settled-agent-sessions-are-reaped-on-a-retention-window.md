# Settled Agent Sessions are reaped on a retention window

An engineer can Settle an Agent Session to declare they are done with it: the Backend Session stops
and a retention window opens, after which the Session Host deletes the session from disk entirely —
transcript, meta and backend state. Only Settled sessions are reaped, and the window is configurable
in `<stateRoot>/config.json`, defaulting to one day.

Settled is deliberately a separate state from `ended` and deliberately reversible: a Revive or the
next message un-settles it, on the same one-action rule ADR 0003 set for Dormant. Reusing `ended`
was rejected because `ended` refuses Revive, which would have made a single button an irreversible
act with a deletion timer attached — a Settle regretted the next morning has to be recoverable, while
one that is forgotten is reaped. The clock starts at the Settle rather than at the session's last
activity, so settling something untouched for a week still grants a full window instead of making it
eligible for deletion on the next sweep.

This is the only operation in Flow that destroys a Presentation Transcript, which sits close
enough to ADR 0001 to be worth separating: that ADR makes a transcript append-only so what a human
saw is never quietly altered, and deleting one wholesale on an explicit instruction is a different
act from rewriting it. Reaping sweeps on host load and hourly thereafter, so a daemon that was off
for a week catches up when it starts.
