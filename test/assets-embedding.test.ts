import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { manifestOf, NoWebBuild } from "../src/web/manifest.ts";
import { SHARED_MODULES, assertSharedModules } from "../scripts/shared-modules.mjs";

const CONTENT_HASHED = /-[A-Za-z0-9_-]{8}\.[^.]+$/;
const ICON_FILES = [
  "favicon.svg",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "favicon.ico",
  "safari-pinned-tab.svg",
  "apple-touch-icon.png",
] as const;
const WEB_ROOT = fileURLToPath(new URL("../web/", import.meta.url));

/** A directory of built assets, as scripts/build-binary.mjs would find one. */
function distTree(): string {
  const dir = mkdtempSync(join(tmpdir(), "flow-dist-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><html></html>");
  writeFileSync(join(dir, "favicon.ico"), Buffer.from([0x00, 0x00, 0x01, 0x00]));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "assets", "index-Ab12Cd34.js"), "export {};\n");
  return dir;
}

/**
 * What stands behind the embedded web client now that it is generated at bundle time rather than
 * committed. Nothing typechecks the manifest any more — it is JSON.stringify of a plain object — so
 * the guarantee lives here, in the generator, pinned against a tree the test builds itself.
 *
 * These rules are the ones the Session Host is entitled to assume, and test/assets-fixture.ts spells
 * the same ones out by hand for the HTTP tier. The pair is what keeps that fixture honest.
 */
describe("the embedded manifest", () => {
  it("classifies a built tree the way the Session Host is entitled to assume", () => {
    const dir = distTree();
    try {
      assert.deepEqual(manifestOf(dir), {
        "/assets/index-Ab12Cd34.js": {
          type: "text/javascript; charset=utf-8",
          encoding: "utf8",
          immutable: true,
          body: "export {};\n",
        },
        "/favicon.ico": {
          type: "image/x-icon",
          encoding: "base64",
          immutable: false,
          body: Buffer.from([0x00, 0x00, 0x01, 0x00]).toString("base64"),
        },
        "/index.html": {
          type: "text/html; charset=utf-8",
          encoding: "utf8",
          immutable: false,
          body: "<!doctype html><html></html>",
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("classifies every committed icon for the source, npm, and binary manifest pipeline", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-icons-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><html></html>");
    try {
      for (const file of ICON_FILES) copyFileSync(join(WEB_ROOT, "public", file), join(dir, file));
      const manifest = manifestOf(dir);
      const expectedTypes: Record<string, string> = {
        "/favicon.svg": "image/svg+xml; charset=utf-8",
        "/favicon-16x16.png": "image/png",
        "/favicon-32x32.png": "image/png",
        "/favicon.ico": "image/x-icon",
        "/safari-pinned-tab.svg": "image/svg+xml; charset=utf-8",
        "/apple-touch-icon.png": "image/png",
      };
      for (const [path, type] of Object.entries(expectedTypes)) {
        assert.equal(manifest[path]?.type, type, path);
        assert.equal(manifest[path]?.immutable, false, path);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the approved adaptive mark and every raster size linked from the Entry Document", () => {
    const html = readFileSync(join(WEB_ROOT, "index.html"), "utf8");
    for (const file of ICON_FILES) assert.match(html, new RegExp(`href="/${file.replace(".", "\\.")}"`), file);
    assert.match(html, /rel="mask-icon"[^>]+color="#5f6368"/);

    const adaptive = readFileSync(join(WEB_ROOT, "public", "favicon.svg"), "utf8");
    assert.match(adaptive, /prefers-color-scheme:\s*dark/);
    assert.match(adaptive, /#181817/);
    assert.match(adaptive, /#f2f2ef/);
    assert.doesNotMatch(adaptive, /<(?:rect|text|animate)|gradient/i, "the primary SVG stays transparent, static, and letter-free");

    assert.deepEqual(pngDimensions(join(WEB_ROOT, "public", "favicon-16x16.png")), [16, 16]);
    assert.deepEqual(pngDimensions(join(WEB_ROOT, "public", "favicon-32x32.png")), [32, 32]);
    assert.deepEqual(pngDimensions(join(WEB_ROOT, "public", "apple-touch-icon.png")), [180, 180]);

    const ico = readFileSync(join(WEB_ROOT, "public", "favicon.ico"));
    assert.deepEqual([...ico.subarray(0, 6)], [0, 0, 1, 0, 3, 0]);
    assert.deepEqual(Array.from({ length: 3 }, (_, index) => ico[6 + index * 16]), [16, 32, 48]);
  });

  it("refuses a tree with no Entry Document, rather than shipping an unopenable client", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-dist-"));
    writeFileSync(join(dir, "orphan.js"), "export {};\n");
    try {
      assert.throws(() => manifestOf(dir), /no index\.html/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a directory that was never built, as the error the CLI turns into advice", () => {
    assert.throws(() => manifestOf(join(tmpdir(), "flow-not-built-at-all")), NoWebBuild);
  });
});

/**
 * The guarantee that matters is the throw in scripts/build-web.mjs, which cannot be skipped because
 * build:binary depends on it. This exercises that check rather than a copy of its input, so quietly
 * deleting it breaks `npm test` too.
 */
describe("the shared client modules", () => {
  it("names the modules both front-ends are built from", () => {
    assert.deepEqual([...SHARED_MODULES].sort(), [
      "src/client/connection.ts",
      "src/client/context-usage.ts",
      "src/client/diff.ts",
      "src/client/markdown.ts",
      "src/client/model-choices.ts",
      "src/client/reduce.ts",
      "src/client/relative-time.ts",
      "src/client/search.ts",
      "src/client/session-label.ts",
      "src/client/status.ts",
      "src/client/tool-summary.ts",
    ]);
  });

  it("passes a graph holding all of them", () => {
    assert.doesNotThrow(() => assertSharedModules(new Set(SHARED_MODULES)));
  });

  it("names the module that went missing", () => {
    for (const missing of SHARED_MODULES) {
      const graph = new Set(SHARED_MODULES.filter((module) => module !== missing));
      assert.throws(() => assertSharedModules(graph), new RegExp(missing), missing);
    }
  });
});

/**
 * The one thing a synthetic tree cannot prove: that the embedder understands everything Vite
 * actually emits. A file type absent from CONTENT_TYPES is served application/octet-stream, which is
 * how a font or a wasm module gets served wrongly by the next thing that reads it.
 *
 * Opt-in because it needs Vite and its platform binding, which the two-second loop should not:
 * FLOW_ASSETS=1 npm test
 */
if (process.env["FLOW_ASSETS"] !== "1") {
  console.log("# skipping the Vite emit check (set FLOW_ASSETS=1 to run)");
} else {
  describe("a real Vite build", () => {
    it("emits nothing the embedder cannot classify", async () => {
      const { build } = await import("vite");
      const outDir = mkdtempSync(join(tmpdir(), "flow-assets-"));
      try {
        await build({
          configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
          logLevel: "warn",
          build: { outDir, emptyOutDir: true, sourcemap: false },
        });

        const manifest = manifestOf(outDir);
        for (const file of ICON_FILES) assert.ok(manifest[`/${file}`], `Vite omitted ${file}`);
        for (const [path, asset] of Object.entries(manifest)) {
          if (!asset) continue;
          assert.notEqual(
            asset.type,
            "application/octet-stream",
            `${path}: add its extension to CONTENT_TYPES in src/web/manifest.ts`,
          );
          assert.equal(asset.immutable, CONTENT_HASHED.test(basename(path)), path);
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    });
  });
}

/**
 * The invariant no type can express, and the one this whole arrangement rests on: a build output
 * reaches the program through src/web/embedded.ts and nowhere else (ADR 0017). Reintroducing an
 * import of a generated module under src/ is what this catches.
 */
function pngDimensions(path: string): [number, number] {
  const bytes = readFileSync(path);
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
}

describe("src/ holds no build output", () => {
  it("keeps generated manifests out of the source tree", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const offenders: string[] = [];
    const descend = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) descend(full);
        else if (entry.name.endsWith(".ts") && readFileSync(full, "utf8").includes("assets.generated")) {
          offenders.push(full.slice(root.length + 1));
        }
      }
    };
    descend(root);
    assert.deepEqual(offenders, []);
  });

  it("has no committed manifest on disk", () => {
    const generated = fileURLToPath(new URL("../src/web/assets.generated.ts", import.meta.url));
    assert.equal(statSync(generated, { throwIfNoEntry: false }), undefined);
  });
});
