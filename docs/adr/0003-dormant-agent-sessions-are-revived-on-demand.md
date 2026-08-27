# Dormant Agent Sessions are revived on demand

When the Session Host restarts, Agent Sessions that were running load as Dormant: transcript
readable, no compute running. A Revive is explicit, triggered by the engineer or by their next
message, and starts a fresh Backend Session that resumes the Conversation Context, drops any turn
torn by the restart, and continues the same Presentation Transcript behind a visible marker.
Auto-reviving everything was rejected because starting a daemon would then silently spawn agent
processes that spend money and edit files; treating restart as terminal was rejected because it
discards most of what a detachable daemon is for.
