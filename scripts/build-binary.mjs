// Build a single executable: bundle to one CommonJS file, then inject it into a copy of node.
//
// Claude Code is a prerequisite for the binary, not a payload. The Agent SDK spawns the CLI as a
// child process and a child needs a real file on disk, which a SEA blob cannot provide.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const result = await build({
  entryPoints: [join(root, "src/cli/main.ts")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // Bundled dependencies call createRequire(import.meta.url), which esbuild lowers to undefined in
  // a CommonJS build. Point it at a real file URL for this bundle instead.
  banner: {
    js: "const __goodharnessMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "__goodharnessMetaUrl" },
  outfile: join(out, "goodharness.cjs"),
  // pi pulls in optional native and wasm packages that cannot be bundled. They are only reachable
  // through the pi adapter, which is loaded lazily, so the binary works without them.
  external: ["koffi", "@silvia-odwyer/photon-node", "@earendil-works/pi-coding-agent"],
  logLevel: "info",
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB`);

writeFileSync(
  join(out, "sea-config.json"),
  JSON.stringify({ main: join(out, "goodharness.cjs"), output: join(out, "sea.blob"), disableExperimentalSEAWarning: true }, null, 2),
);

execFileSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { stdio: "inherit" });

const binary = join(out, "goodharness");
copyFileSync(process.execPath, binary);
execFileSync(
  process.execPath,
  [
    join(root, "node_modules/postject/dist/cli.js"),
    binary,
    "NODE_SEA_BLOB",
    join(out, "sea.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
  ],
  { stdio: "inherit" },
);

console.log(`\nbuilt ${binary}`);
