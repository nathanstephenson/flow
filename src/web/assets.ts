/**
 * The shape of the embedded web assets: what the Session Host is entitled to assume about a manifest
 * it is handed, and the contract src/web/manifest.ts is written against.
 *
 * The manifest itself is a build artifact and never appears under src/ — the binary build generates
 * it and injects it in place of src/web/embedded.ts (ADR 0017), so nothing typechecks the bytes.
 * These types are the whole of the agreement, and test/assets-embedding.test.ts is what holds the
 * generator to them.
 */

export type EmbeddedAsset = {
  type: string;
  /** utf8 text verbatim, or base64 for anything that is not text. */
  body: string;
  encoding: "utf8" | "base64";
  /** Content-hashed filenames may be cached forever; the shell may not. */
  immutable: boolean;
};

/** Keyed by the URL path Vite emitted the file at, `/index.html` included. */
export type AssetManifest = Record<string, EmbeddedAsset | undefined>;
