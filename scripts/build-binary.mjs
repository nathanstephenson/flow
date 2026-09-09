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
    js: "const __flowMetaUrl = require('node:url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "__flowMetaUrl" },
  outfile: join(out, "flow.cjs"),
  // pi pulls in optional native and wasm packages that cannot be bundled. They are only reachable
  // through the pi adapter, which is loaded lazily, so the binary works without them.
  //
  // node-pty is here for the same reason and with a sharper consequence: a SEA blob cannot contain a
  // native addon, so the binary serves no Shells. That is reported rather than hidden — the import
  // is lazy (src/daemon/shell.ts), its failure becomes `shell: false` on /api/config, and the web
  // client hides the control instead of offering one that breaks. `ws` is pure JS and bundles fine;
  // only its optional native accelerators are excluded.
  external: [
    "koffi",
    "@silvia-odwyer/photon-node",
    "@earendil-works/pi-coding-agent",
    "node-pty",
    "bufferutil",
    "utf-8-validate",
  ],
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`bundle: ${(bytes / 1024 / 1024).toFixed(1)} MB`);

writeFileSync(
  join(out, "sea-config.json"),
  JSON.stringify({ main: join(out, "flow.cjs"), output: join(out, "sea.blob"), disableExperimentalSEAWarning: true }, null, 2),
);

execFileSync(process.execPath, ["--experimental-sea-config", join(out, "sea-config.json")], { stdio: "inherit" });

const binary = join(out, "flow");
copyFileSync(process.execPath, binary);

// macOS refuses to run a binary whose code signature no longer matches its contents, and injection
// changes the contents. The signature is stripped first and an ad-hoc one applied afterwards;
// without this the kernel SIGKILLs the binary at launch with no diagnostic beyond "killed".
const isMac = process.platform === "darwin";
if (isMac) codesign(["--remove-signature", binary]);

execFileSync(
  process.execPath,
  [
    join(root, "node_modules/postject/dist/cli.js"),
    binary,
    "NODE_SEA_BLOB",
    join(out, "sea.blob"),
    "--sentinel-fuse",
    "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
    // Mach-O has no equivalent of an ELF note section; the blob needs a segment of its own.
    ...(isMac ? ["--macho-segment-name", "NODE_SEA"] : []),
  ],
  { stdio: "inherit" },
);

if (isMac) codesign(["--sign", "-", binary]);

console.log(`\nbuilt ${binary}`);

function codesign(args) {
  try {
    execFileSync("codesign", args, { stdio: "inherit" });
  } catch (error) {
    throw new Error(
      `codesign ${args[0]} failed. Xcode command line tools are required to build the binary on ` +
        `macOS: xcode-select --install. (${error instanceof Error ? error.message : error})`,
    );
  }
}
