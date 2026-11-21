# The Spend Ledger keeps readings outside Agent Session directories

Spend is a running total per Agent Session, kept in its Presentation Transcript. A Reap (ADR 0006)
deletes that transcript, so totals over a time window or a lifetime cannot be read from transcripts.
The Session Host therefore appends each changed reading to `<stateRoot>/spend-ledger.jsonl`, one line
per model, with its time, Spend Source and Scope. Lines are fsynced and are never rewritten.

The ledger stores readings rather than differences. The difference is derived on load from the
previous reading for the same key, so a restart always knows the last total exactly, and a total that
goes down is counted as a new count. Summary Model naming and Git publish text have no Agent Session
Spend, so they write one reading under a key of their own.

A Fork copies its source's transcript prefix (ADR 0040). The copy leaves out Spend readings, so the
source's cost is counted once. On the first start with no ledger, the Session Host fills it once from
the transcripts that still exist, after the last fork marker of each. Cost from sessions that were
already Reaped is lost.

The Scope is stored so that a Project filter can be added later without losing earlier history.
