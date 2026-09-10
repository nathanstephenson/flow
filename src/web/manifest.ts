import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, posix, sep } from "node:path";

import type { AssetManifest } from "./assets.ts";

/**
 * Turn a directory of Vite output into the manifest the Session Host serves from memory.
 *
 * One implementation with two callers, which is the point: scripts/build-binary.mjs runs it at bundle
 * time to produce the manifest it injects, and src/cli/main.ts runs it at startup so a source run
 * serves the same bytes the binary would. A second implementation is how the two would drift.
 */

const CONTENT_TYPES: Record<string, [type: string, isText: boolean]> = {
  ".css": ["text/css", true],
  ".html": ["text/html", true],
  ".ico": ["image/x-icon", false],
  ".js": ["text/javascript", true],
  ".json": ["application/json", true],
  ".png": ["image/png", false],
  ".svg": ["image/svg+xml", true],
  // The Shell's terminal emulator. It is fetched and handed to WebAssembly.compile(), so the type is
  // not load-bearing the way it would be for instantiateStreaming — but the fallback would call it
  // application/octet-stream, and being wrong in the manifest is how it gets served wrongly by the
  // next thing that reads it.
  ".wasm": ["application/wasm", false],
  ".webp": ["image/webp", false],
  ".woff2": ["font/woff2", false],
};

// Vite content-hashes everything but the Entry Document, and a hashed name may be cached forever.
// That is a fact about the build, so the judgement is made here — where the hashing is known —
// rather than in the Session Host.
const CONTENT_HASHED = /-[A-Za-z0-9_-]{8}\.[^.]+$/;

/** Raised when there is no build to serve, so a caller can say what to run rather than stack-trace. */
export class NoWebBuild extends Error {}

/**
 * The embedded manifest for a directory of Vite output, keyed by the URL path each file was emitted
 * at. Throws `NoWebBuild` unless the directory exists and carries an Entry Document, because a
 * manifest without one is a web client that cannot be opened.
 */
export function manifestOf(dist: string): AssetManifest {
  if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) {
    throw new NoWebBuild(`no web build at ${dist}`);
  }

  const manifest: AssetManifest = {};
  for (const relPath of walk(dist).sort()) {
    const [type, isText] = CONTENT_TYPES[extname(relPath)] ?? ["application/octet-stream", false];
    const bytes = readFileSync(join(dist, relPath.split("/").join(sep)));
    manifest[`/${relPath}`] = {
      type: isText ? `${type}; charset=utf-8` : type,
      encoding: isText ? "utf8" : "base64",
      immutable: CONTENT_HASHED.test(posix.basename(relPath)),
      body: isText ? bytes.toString("utf8") : bytes.toString("base64"),
    };
  }

  if (!manifest["/index.html"]) throw new NoWebBuild(`no index.html under ${dist}`);
  return manifest;
}

/** Every file at or under `target`, as `/`-separated paths relative to it. */
function walk(target: string): string[] {
  const found: string[] = [];
  const descend = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) descend(join(directory, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  descend(target, "");
  return found;
}
