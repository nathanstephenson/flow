import type { AssetManifest } from "../src/web/assets.ts";

/**
 * A hand-written stand-in for the embedded web client.
 *
 * The real manifest is a build artifact that only scripts/build-binary.mjs produces (ADR 0017), so
 * it is not on disk during `npm test` and the HTTP tier serves this instead. Nothing is lost: those
 * tests are about the Session Host's routing — content types, cache-control, the token gate, the SPA
 * fallback — and none of them is a property of the real bundle.
 *
 * Every field mirrors a rule in scripts/build-assets.mjs, and the pairing is held honest from the
 * other end by test/assets-embedding.test.ts, which pins those rules against a tree it builds
 * itself: `; charset=utf-8` on text types, base64 for anything else, and `immutable` iff the
 * basename carries an 8-character content hash.
 */
export const FIXTURE_ASSETS: AssetManifest = {
  // The Entry Document is the one text file Vite does not content-hash, and no-store on it is the
  // whole reason immutable is safe on everything else.
  "/index.html": {
    type: "text/html; charset=utf-8",
    encoding: "utf8",
    immutable: false,
    body: '<!doctype html><html><head><script type="module" src="/assets/index-Ab12Cd34.js"></script></head><body><div id="root"></div></body></html>',
  },
  // Deliberately not index-deadbeef.js, which a test requires to 404 as a missing hashed file.
  "/assets/index-Ab12Cd34.js": {
    type: "text/javascript; charset=utf-8",
    encoding: "utf8",
    immutable: true,
    body: 'console.log("fixture bundle");\n',
  },
  // Neither text nor content-hashed: one entry covering both axes the Entry Document does not.
  "/favicon.ico": {
    type: "image/x-icon",
    encoding: "base64",
    immutable: false,
    body: Buffer.from([0x00, 0x00, 0x01, 0x00]).toString("base64"),
  },
};
