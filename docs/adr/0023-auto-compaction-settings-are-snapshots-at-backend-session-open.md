# Auto-compaction Settings are snapshots at Backend Session open

Providers Settings can select auto-compaction per Backend Adapter and model. An absent entry uses
the backend default. An entry can disable auto-compaction or enable it with an integer target
percentage from 1 to 99. The percentage is a target, not a guarantee. Manual compaction and its
Agent Events do not change.

ConfigStore owns these Settings. The Session Host reads a snapshot each time a Backend Session
opens, including Revive. Saving does not change running Backend Sessions. Backend Adapters do not
read Flow's settings file. This follows ADR 0009 without a second owner or change subscription.

Pi applies its snapshot to the selected model at open and after a model change. It converts the
target using the actual model context window:

`reserveTokens = floor(contextWindow * (1 - targetPercent / 100))`

Pi also uses reserved tokens to set the summary token budget. The UI states this effect. When the
context window is unknown, percentage control is unavailable and the adapter keeps its original
SDK compaction settings. Selecting a model with no override restores those original settings,
not the previous model's override. Flow uses in-memory SDK overrides and does not write Pi Settings.

Claude receives `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `DISABLE_AUTO_COMPACT` in its startup environment
for the selected model. Its CLI can compact earlier and other backend restrictions can still apply.
A model change in a running Backend Session does not change that environment. This limitation is
accepted and stated in the UI: applying the new model's setting requires a fresh Backend Session.
When Flow does not select a model at startup, the CLI chooses its own model and compaction defaults.

Auto-compaction Settings have a separate Capability from manual compaction. Model catalogue replies
carry that Capability so Providers Settings can show only supported controls.
