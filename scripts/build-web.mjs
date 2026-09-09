// `npm run build:web` in full: build web/ with Vite, then prove the bundle contains the modules both
// front-ends share.
//
// It writes nothing outside web/dist. Embedding is scripts/build-binary.mjs's job and happens at
// bundle time (ADR 0017), so the only output of this script is the Vite build itself.
//
// Vite is driven through its JS API rather than the CLI for one reason: the API returns the build
// result, and result.output[].modules is the only place the module graph is visible. `vite build
// --manifest` is not a substitute — the manifest lists entry chunks and their imports, not the graph.
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "vite";

import { assertSharedModules } from "./shared-modules.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const result = await build({
  configFile: join(root, "web/vite.config.ts"),
  // No sourcemaps in the embedded build: React sourcemaps would add megabytes to the binary for no
  // benefit, since you debug against real sources in the dev server.
  build: { sourcemap: false },
});

const outputs = (Array.isArray(result) ? result : [result]).flatMap((bundle) => bundle.output ?? []);
const graph = new Set(
  outputs
    .flatMap((chunk) => Object.keys(chunk.modules ?? {}))
    .map((id) => relative(root, id).split(sep).join("/")),
);

assertSharedModules(graph);
