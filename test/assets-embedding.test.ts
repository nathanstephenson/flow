import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { manifestOf } from "../scripts/build-assets.mjs";
import { SHARED_MODULES, assertSharedModules } from "../scripts/shared-modules.mjs";

const CONTENT_HASHED = /-[A-Za-z0-9_-]{8}\.[^.]+$/;

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

  it("refuses a tree with no Entry Document, rather than shipping an unopenable client", () => {
    const dir = mkdtempSync(join(tmpdir(), "flow-dist-"));
    writeFileSync(join(dir, "orphan.js"), "export {};\n");
    try {
      assert.throws(() => manifestOf(dir), /no index\.html/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a directory that was never built", () => {
    assert.throws(() => manifestOf(join(tmpdir(), "flow-not-built-at-all")), /no Vite output/);
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
        for (const [path, asset] of Object.entries(manifest)) {
          if (!asset) continue;
          assert.notEqual(
            asset.type,
            "application/octet-stream",
            `${path}: add its extension to CONTENT_TYPES in scripts/build-assets.mjs`,
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
