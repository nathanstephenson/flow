// Turn a directory of Vite output into the manifest the Session Host serves from memory, so that a
// single-executable build has nothing to find on disk at runtime.
//
// Nothing here writes into src/. The manifest is data, and the one build that embeds it —
// scripts/build-binary.mjs — hands it to esbuild at bundle time (ADR 0017). That is why this module
// takes the directory as an argument rather than reaching for web/dist itself: the binary build, the
// unit test that pins these rules against a synthetic tree, and the opt-in test that pins them
// against real Vite output all call it on a directory of their own.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, posix, sep } from "node:path";

const CONTENT_TYPES = {
  ".css": ["text/css", true],
  ".html": ["text/html", true],
  ".ico": ["image/x-icon", false],
  ".js": ["text/javascript", true],
  ".json": ["application/json", true],
  ".png": ["image/png", false],
  ".svg": ["image/svg+xml", true],
  // The Shell's terminal emulator. It is fetched and handed to WebAssembly.compile(), so the type
  // is not load-bearing the way it would be for instantiateStreaming — but the fallback would call
  // it application/octet-stream, and being wrong in the manifest is how it gets served wrongly by
  // the next thing that reads it.
  ".wasm": ["application/wasm", false],
  ".webp": ["image/webp", false],
  ".woff2": ["font/woff2", false],
};

// Vite content-hashes everything but the Entry Document, and a hashed name may be cached forever.
// That is a fact about the build, so the judgement is made here — where the hashing is known —
// rather than in the Session Host.
const CONTENT_HASHED = /-[A-Za-z0-9_-]{8}\.[^.]+$/;

/**
 * The embedded manifest for a directory of Vite output, keyed by the URL path each file was emitted
 * at. Throws unless the tree carries an Entry Document, because a manifest without one is a web
 * client that cannot be opened, and failing at build time beats 404ing at runtime.
 */
export function manifestOf(dist) {
  if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`no Vite output at ${dist}; run scripts/build-web.mjs, which builds it first`);
  }

  const manifest = {};
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

  if (!manifest["/index.html"]) {
    throw new Error(`no index.html under ${dist}; run scripts/build-web.mjs rather than this file`);
  }
  return manifest;
}

/** Every file at or under `target`, as `/`-separated paths relative to it. */
function walk(target) {
  const found = [];
  const descend = (directory, prefix) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) descend(join(directory, entry.name), `${prefix}${entry.name}/`);
      else found.push(`${prefix}${entry.name}`);
    }
  };
  descend(target, "");
  return found;
}
