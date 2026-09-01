import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// The Session Host binds an ephemeral port, so the dev server is pointed at it explicitly. Step 3
// replaces this with a read of <stateRoot>/daemon.json.
const daemon = {
  target: process.env["GOODHARNESS_URL"] ?? "http://127.0.0.1:4318",
  // Deliberately false: the host parses request.url against a fixed base and never reads Host, and
  // originAllowed() checks hostname only, so Origin: http://localhost:5173 is already allowed.
  changeOrigin: false,
  ws: false,
};

export default defineConfig({
  root: here,
  plugins: [react()],
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
    proxy: { "/api": daemon, "/auth": daemon },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false, assetsDir: "assets" },
});
