import type { AssetManifest } from "./assets.ts";

/**
 * The web client baked into this build, and the one place a build artifact enters the program.
 *
 * Empty here and replaced wholesale by scripts/build-binary.mjs at bundle time, because the single
 * executable is the only build that can carry its assets — a SEA blob has no filesystem to read them
 * from. A source run finds this empty and loads web/dist from disk instead (src/cli/main.ts), so
 * both serve the same bytes by the same manifestOf(); only where they come from differs.
 *
 * Nothing generated is committed under src/ as a consequence, which is the whole point: the manifest
 * is 2.5 MB that Vite content-hashes, so every branch touching web/ used to collide on it (ADR 0017).
 */
export const EMBEDDED: AssetManifest = {};
