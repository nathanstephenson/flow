# Presentation Transcript and Conversation Context are separate artifacts

Flow keeps its own append-only Presentation Transcript and never reads a backend's stored
history back. The two records answer different questions: the Presentation Transcript is what a
human saw, and the Conversation Context is what the model can currently see. Compaction makes the
distinction unavoidable — after it, the model's context is a summary while the reader still expects
the full history — so reconciling them would mean choosing which one to corrupt. Keeping them apart
buys exactly one translation path per Backend Adapter, at the cost of storing bytes the backend has
also stored.
