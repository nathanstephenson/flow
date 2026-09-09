# Subscription credentials are barred from hosted mode

Anthropic does not permit third-party products to offer claude.ai login or subscription rate limits
without prior approval. Flow therefore constrains the credential, not the adapter: running
the Claude Agent SDK against an engineer's own subscription is confined to local mode, where the
tool inherits credentials that engineer installed themselves and brokers no login. Should a hosted
mode be built, the Claude Agent SDK remains available there against org-held API keys — it is the
subscription path, not the adapter, that must be refused, and that refusal belongs in code rather
than in convention.
