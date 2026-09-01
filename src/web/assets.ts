/**
 * The shape of the embedded web assets. Hand-written, and deliberately separate from
 * assets.generated.ts: the root program emits declarations (tsconfig.json:20), so typing the
 * generated manifest by annotation rather than by inference keeps a half-megabyte string literal
 * out of the emitted `.d.ts`.
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
