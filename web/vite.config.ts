import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, type Plugin } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

/** What `goodharness serve` writes: `{ url, token }` at mode 0600 (src/cli/main.ts). */
type Handoff = { url: string; token: string };

/**
 * The state root is mirrored from defaultStateRoot() in src/daemon/store.ts rather than imported:
 * this file is loaded by Vite's own config loader, and pulling in TranscriptStore and the protocol
 * types for two lines is not a coupling worth having. Keep the two in step.
 */
function stateRoot(): string {
  return process.env["GOODHARNESS_STATE_DIR"] ?? join(homedir(), ".goodharness");
}

function readHandoff(): Handoff | undefined {
  try {
    return JSON.parse(readFileSync(join(stateRoot(), "daemon.json"), "utf8")) as Handoff;
  } catch {
    return undefined;
  }
}

/**
 * Where /api and /auth go. Resolved once, at config load — a known limitation rather than an
 * oversight: a Session Host restarted on a fresh ephemeral port leaves this proxying into the void.
 * The fix is to give the host a fixed port, `npm start -- serve --port 4318`, not to re-read
 * daemon.json on every request.
 */
function daemonProxy(): { target: string; changeOrigin: boolean; ws: boolean } {
  const target = process.env["GOODHARNESS_URL"] ?? readHandoff()?.url;
  if (!target) {
    throw new Error(
      `nothing to proxy to: no GOODHARNESS_URL, and no daemon.json under ${stateRoot()}. Start a ` +
        "Session Host with `npm start -- serve --port 4318`, or set " +
        "GOODHARNESS_URL=http://127.0.0.1:4318.",
    );
  }
  return {
    target,
    // Deliberately false: the host parses request.url against a fixed base and never reads Host, and
    // originAllowed() checks hostname only, so Origin: http://127.0.0.1:5173 is already allowed.
    changeOrigin: false,
    // On for the Shell socket at /api/shells/:id/stream, which is the one thing here that is not
    // SSE (ADR 0008). Without this the upgrade is answered by the dev server rather than forwarded,
    // and the terminal never connects under `npm run dev` while working fine in the binary.
    ws: true,
  };
}

/**
 * Prints the cookie handoff against *this* origin.
 *
 * src/cli/main.ts prints the Session Host's own `${daemon.url}/auth?token=…`, and opening that in a
 * browser is wrong twice over during development: `localhost`, `127.0.0.1` and `[::1]` are three
 * different cookie hosts even though they are one machine, so a cookie taken on the host's hostname
 * is not necessarily sent to the dev server's; and /auth redirects to a relative "/" — which is what
 * makes it work through a proxy at all — so following it lands you on the host's *embedded* bundle
 * rather than on this dev server. Printing the dev origin's own URL leaves nothing to hand-edit.
 */
function devHandoff(): Plugin {
  return {
    name: "goodharness-dev-handoff",
    apply: "serve",
    configureServer(server) {
      const printUrls = server.printUrls.bind(server);
      server.printUrls = () => {
        printUrls();
        // Read again rather than reuse anything from config load: the Session Host writes a fresh
        // token on every start, and the one in daemon.json now is the one the gate will accept.
        const handoff = readHandoff();
        const origin = server.resolvedUrls?.local[0]?.replace(/\/$/, "");
        if (!handoff || !origin) {
          server.config.logger.warn(`  dev handoff: no daemon.json under ${stateRoot()} — start a Session Host`);
          return;
        }
        server.config.logger.info(`  dev handoff: ${origin}/auth?token=${handoff.token}`);
      };
    },
  };
}

export default defineConfig(({ command }) => ({
  root: here,
  plugins: [react(), tailwindcss(), devHandoff()],
  resolve: {
    // Mirrors "paths" in web/tsconfig.json — Vite does not read tsconfig paths. Keep the two in step.
    alias: {
      "@": resolve(here, "src"),
      "@client": resolve(root, "src/client"),
    },
  },
  server: {
    // Pinned to IPv4. Vite binds [::1] only by default, which would put the browser on a different
    // cookie host from the one the /auth handoff and originAllowed() expect.
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // /api carries commands and the event stream; /auth is the one-time cookie handoff. Both go to
    // the running host so the browser stays on one origin and SameSite=Strict holds.
    //
    // Only for `vite`: scripts/build-web.mjs loads this same config, and a build must not need a
    // running Session Host — that would put `npm run build:binary` and CI behind a daemon.
    ...(command === "serve" ? { proxy: { "/api": daemonProxy(), "/auth": daemonProxy() } } : {}),
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, assetsDir: "assets" },
}));
