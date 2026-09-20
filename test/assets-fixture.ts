import type { AssetManifest } from "../src/web/assets.ts";

/**
 * A hand-written stand-in for the embedded web client.
 *
 * The real manifest is built from web/dist and nothing commits it (ADR 0017), so `npm test` cannot
 * assume one exists — the suite has to pass on a fresh clone with no build and under --omit=dev with
 * no Vite. The HTTP tier serves this instead, and nothing is lost: those tests are about the Session
 * Host's routing — content types, cache-control, the token gate, the SPA fallback — and none of them
 * is a property of the real bundle.
 *
 * Every field mirrors a rule in src/web/manifest.ts, and the pairing is held honest from the
 * other end by test/assets-embedding.test.ts, which pins those rules against a tree it builds
 * itself: `; charset=utf-8` on text types, base64 for anything else, and `immutable` iff the
 * basename carries an 8-character content hash.
 */
export const FIXTURE_ICON_PATHS = [
  "/favicon.svg",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/favicon.ico",
  "/safari-pinned-tab.svg",
  "/apple-touch-icon.png",
] as const;

const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64");

export const FIXTURE_ASSETS: AssetManifest = {
  // The Entry Document is the one text file Vite does not content-hash, and no-store on it is the
  // whole reason immutable is safe on everything else.
  "/index.html": {
    type: "text/html; charset=utf-8",
    encoding: "utf8",
    immutable: false,
    body: `<!doctype html><html><head>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
<link rel="icon" href="/favicon-16x16.png" type="image/png" sizes="16x16">
<link rel="icon" href="/favicon.ico" type="image/x-icon" sizes="16x16 32x32 48x48">
<link rel="mask-icon" href="/safari-pinned-tab.svg" color="#5f6368">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<script type="module" src="/assets/index-Ab12Cd34.js"></script></head><body><div id="root"></div></body></html>`,
  },
  // Deliberately not index-deadbeef.js, which a test requires to 404 as a missing hashed file.
  "/assets/index-Ab12Cd34.js": {
    type: "text/javascript; charset=utf-8",
    encoding: "utf8",
    immutable: true,
    body: 'console.log("fixture bundle");\n',
  },
  "/favicon.svg": {
    type: "image/svg+xml; charset=utf-8",
    encoding: "utf8",
    immutable: false,
    body: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
  },
  "/favicon-16x16.png": { type: "image/png", encoding: "base64", immutable: false, body: png },
  "/favicon-32x32.png": { type: "image/png", encoding: "base64", immutable: false, body: png },
  "/favicon.ico": {
    type: "image/x-icon",
    encoding: "base64",
    immutable: false,
    body: Buffer.from([0x00, 0x00, 0x01, 0x00]).toString("base64"),
  },
  "/safari-pinned-tab.svg": {
    type: "image/svg+xml; charset=utf-8",
    encoding: "utf8",
    immutable: false,
    body: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>',
  },
  "/apple-touch-icon.png": { type: "image/png", encoding: "base64", immutable: false, body: png },
};
