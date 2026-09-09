import type { AssetManifest } from "../src/web/assets.ts";

/** The embedded manifest for a directory of Vite output. Throws unless it holds an Entry Document. */
export function manifestOf(dist: string): AssetManifest;
