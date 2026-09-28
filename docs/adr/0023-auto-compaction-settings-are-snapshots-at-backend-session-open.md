# Auto-compaction Settings are snapshots at Backend Session open

Providers Settings configures auto-compaction once per Backend Adapter, for all of its models. An
absent entry uses the backend default. An entry can disable auto-compaction or enable it with an
integer target percentage from 1 to 99. The percentage is a target, not a guarantee. Manual
compaction and its Agent Events do not change.

Older settings files mapped each Backend Adapter to model-specific entries. On load, identical
legacy entries (including a single entry) become the backend-wide setting. If entries conflict or
are invalid, Flow warns and uses the backend default instead of arbitrarily applying one model's
policy to all models. The next Settings write stores the new representation.

ConfigStore owns these Settings. The Session Host reads a snapshot each time a Backend Session
opens, including Revive. Saving does not change running Backend Sessions. Backend Adapters do not
read Flow's settings file. This follows ADR 0009 without a second owner or change subscription.

Pi applies its snapshot to the selected model at open and after a model change. It converts the
target using each model's actual context window:

`reserveTokens = floor(contextWindow * (1 - targetPercent / 100))`

Pi also uses reserved tokens to set the summary token budget. The UI states this effect. When the
context window is unknown, Pi keeps its original SDK compaction settings for that model. Flow uses
in-memory SDK overrides and does not write Pi Settings.

Claude receives `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` and `DISABLE_AUTO_COMPACT` in its startup environment
regardless of whether Flow selected a model at startup. Its CLI can compact earlier and other backend
restrictions can still apply. A model change in a running Backend Session does not change that
environment. Applying new Settings requires a fresh Backend Session.

Auto-compaction Settings have a separate Capability from manual compaction. Model catalogue replies
carry that Capability so Providers Settings can show only supported controls.
