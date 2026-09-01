// `npm run build:assets` in full: build web/ with Vite, prove the bundle contains the modules both
// front-ends share, then embed the result via scripts/build-assets.mjs.
//
// Two scripts because a Vite build cannot be synchronous and buildAssets() must stay so. Vite is
// driven through its JS API rather than the CLI for one reason: the API returns the build result,
// and result.output[].modules is the only place the module graph is visible. `vite build --manifest`
// is not a substitute — the manifest lists entry chunks and their imports, not the graph.
import { writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { buildAssets } from "./build-assets.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The modules the web app must be built from rather than reimplement. Asserting this at build time
 * is stronger than a test because it cannot be skipped: build:binary -> prebuild:binary ->
 * build:assets -> here. You cannot produce a binary whose bundle was not built from the shared
 * reducer.
 *
 * The list is the modules the web app is *currently* built from, not every module in src/client/.
 * It can only name what the bundle actually imports, so a shared module the web app does not use yet
 * cannot be asserted here — context-usage.ts, model-choices.ts, session-label.ts and status.ts are
 * all shared with the TUI and all still absent below. Each joins the list as the web app starts
 * importing it; until then it is shared code with no gate on it, and the compiler is the only thing
 * keeping the two front-ends honest about it.
 */
const SHARED_MODULES = [
  "src/client/connection.ts",
  "src/client/diff.ts",
  "src/client/reduce.ts",
  "src/client/relative-time.ts",
];

const result = await build({
  configFile: join(root, "web/vite.config.ts"),
  // No sourcemaps in the embedded build: React sourcemaps would add megabytes of string literal to
  // a git-tracked file for no benefit, since you debug against real sources in the dev server.
  build: { sourcemap: false },
});

const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output ?? []);
const graph = new Set(
  outputs
    .flatMap((chunk) => Object.keys(chunk.modules ?? {}))
    .map((id) => relative(root, id).split(sep).join("/")),
);

for (const module of SHARED_MODULES) {
  if (!graph.has(module)) {
    throw new Error(`the web bundle does not contain ${module}; the two front-ends would drift`);
  }
}

writeFileSync(join(root, "src/web/assets.generated.ts"), buildAssets(SHARED_MODULES));
console.log("wrote src/web/assets.generated.ts");
