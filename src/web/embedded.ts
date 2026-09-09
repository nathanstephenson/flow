import type { AssetManifest } from "./assets.ts";

/**
 * The web client this build serves, and the one place a build artifact enters the program.
 *
 * Empty in a source run, which is not a gap: development serves the client from the Vite dev server,
 * which proxies /api and /auth to a Session Host started separately (web/vite.config.ts), so the
 * host has no client to serve and browsing it directly is the documented mistake. The single
 * executable is the only build that embeds one, and scripts/build-binary.mjs replaces this module at
 * bundle time with the manifest built from web/dist (ADR 0017).
 *
 * Nothing generated is committed under src/ as a consequence, which is the whole point: the manifest
 * is 2.5 MB that Vite content-hashes, so every branch touching web/ used to collide on it.
 */
export const EMBEDDED: AssetManifest = {};
