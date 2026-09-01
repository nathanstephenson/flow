import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, before, after } from "node:test";
import { fileURLToPath } from "node:url";

import { FakeBackend } from "../src/backend/fake/index.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve, type RunningServer } from "../src/daemon/server.ts";
import { editDiff } from "../src/client/diff.ts";
import { ASSETS, SHARED_MODULES, SOURCE_HASH } from "../src/web/assets.generated.ts";
import { sourceHash } from "../scripts/build-assets.mjs";

const TOKEN = "web-test-token";
const IMMUTABLE = "public, max-age=31536000, immutable";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

describe("web assets", () => {
  let running: RunningServer;

  before(async () => {
    const host = new SessionHost();
    host.registerBackend(new FakeBackend());
    running = await serve({ host, token: TOKEN, scope: "/tmp/scope" });
  });

  after(async () => {
    await running.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${running.url}${path}`, { headers: { cookie: `goodharness=${TOKEN}`, ...headers } });

  /**
   * The relocated anti-drift guarantee. Byte-equality between the served reducer and the TUI's is
   * what used to stop the two front-ends diverging; the web app now imports src/client/reduce.ts
   * directly, so the compiler does that. What is left to prove is that the committed bundle is not
   * *older* than the source it was built from — src/client/** is in the digest's input set, so
   * editing reduce.ts without rerunning `npm run build:assets` fails right here.
   *
   * It recomputes the digest rather than calling buildAssets() on purpose: this has to pass on a
   * fresh clone with no web/dist, and under --omit=dev with no Vite installed.
   */
  it("keeps the embedded bundle in step with the sources it was built from", () => {
    assert.equal(SOURCE_HASH, sourceHash(), "run `npm run build:assets`");
  });

  /**
   * An assertion about an assertion. The guarantee that matters is the throw in
   * scripts/build-web.mjs, which cannot be skipped because build:binary depends on it; this exists
   * so that quietly deleting that check also breaks `npm test`.
   */
  it("records which client modules the bundle is required to be built from", () => {
    assert.deepEqual([...SHARED_MODULES].sort(), [
      "src/client/connection.ts",
      "src/client/diff.ts",
      "src/client/reduce.ts",
      "src/client/relative-time.ts",
    ]);
  });

  it("serves the shell at / and every asset Vite emitted at its own URL", async () => {
    const shell = await get("/");
    assert.equal(shell.status, 200);
    assert.match(shell.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(shell.headers.get("cache-control"), "no-store");

    for (const [path, asset] of Object.entries(ASSETS)) {
      if (!asset) continue;
      const response = await get(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get("content-type"), asset.type, path);
      assert.equal(response.headers.get("cache-control"), asset.immutable ? IMMUTABLE : "no-store", path);
    }
  });

  it("requires authentication for the UI itself, not just the API", async () => {
    // The hashed assets and the SPA fallback are new reachable surface sitting behind the same token
    // gate, so each is named here: neither may become a way to read the app without the cookie.
    const script = Object.keys(ASSETS).find((path) => path.startsWith("/assets/") && path.endsWith(".js"));
    assert.ok(script, "Vite emitted no hashed script");

    for (const path of ["/", script, "/s/deep-link"]) {
      assert.equal((await fetch(`${running.url}${path}`)).status, 401, path);
    }
  });

  it("answers an unknown path with the shell, but keeps /api and /assets honest", async () => {
    const deepLink = await get("/s/some-agent-session");
    assert.equal(deepLink.status, 200);
    assert.match(deepLink.headers.get("content-type") ?? "", /text\/html/);

    for (const path of ["/api/nope", "/assets/index-deadbeef.js"]) {
      const response = await get(path);
      assert.equal(response.status, 404, path);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/, path);
    }
  });

  it("tells a client the default Scope and available backends", async () => {
    const config = (await (await get("/api/config")).json()) as { scope: string; backends: string[] };
    assert.equal(config.scope, "/tmp/scope");
    assert.ok(config.backends.includes("fake"));
  });
});

/**
 * The tier that catches what SOURCE_HASH cannot: a hand-edited manifest, or an input set too narrow
 * to notice a change. Rebuilds with Vite and compares filenames and per-file digests. Opt-in because
 * it needs Vite and its platform binding, which the two-second loop should not: GOODHARNESS_ASSETS=1 npm test
 */
if (process.env["GOODHARNESS_ASSETS"] !== "1") {
  console.log("# skipping embedded asset rebuild (set GOODHARNESS_ASSETS=1 to run)");
} else {
  describe("embedded assets", () => {
    it("are Vite's actual output for the sources on disk", async () => {
      const { build } = await import("vite");
      const outDir = mkdtempSync(join(tmpdir(), "goodharness-assets-"));
      let emitted: Map<string, string>;
      try {
        await build({
          configFile: fileURLToPath(new URL("../web/vite.config.ts", import.meta.url)),
          logLevel: "warn",
          build: { outDir, emptyOutDir: true, sourcemap: false },
        });
        emitted = digestTree(outDir);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }

      const embedded = new Map(
        Object.entries(ASSETS).flatMap(([path, asset]) =>
          asset ? [[path, sha256(Buffer.from(asset.body, asset.encoding))] as const] : [],
        ),
      );

      assert.deepEqual([...embedded.keys()].sort(), [...emitted.keys()].sort(), "run `npm run build:assets`");
      for (const [path, digest] of emitted) {
        assert.equal(embedded.get(path), digest, `${path} differs; run \`npm run build:assets\``);
      }
    });
  });
}

/** Every file under `root`, keyed by the URL path the generator would give it. */
function digestTree(root: string, prefix = "/"): Map<string, string> {
  const digests = new Map<string, string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) for (const [path, digest] of digestTree(full, `${prefix}${entry.name}/`)) digests.set(path, digest);
    else digests.set(`${prefix}${entry.name}`, sha256(readFileSync(full)));
  }
  return digests;
}

describe("edit diffs", () => {
  it("reads the shape Claude's Edit tool actually produces", () => {
    // Captured from a real session: {replace_all, file_path, old_string, new_string}.
    const diff = editDiff({
      replace_all: false,
      file_path: "/tmp/gh-demo/greeting.txt",
      old_string: "Hello, world!",
      new_string: "Goodbye, world!",
    });
    assert.deepEqual(diff, {
      path: "/tmp/gh-demo/greeting.txt",
      removed: ["Hello, world!"],
      added: ["Goodbye, world!"],
    });
  });

  it("treats a Write as pure addition", () => {
    assert.deepEqual(editDiff({ file_path: "a.txt", content: "one\ntwo\n" }), {
      path: "a.txt",
      removed: [],
      added: ["one", "two"],
    });
  });

  it("leaves non-editing tools alone", () => {
    assert.equal(editDiff({ file_path: "a.txt" }), undefined);
    assert.equal(editDiff("ls -la"), undefined);
    assert.equal(editDiff(undefined), undefined);
  });
});
