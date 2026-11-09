// PLAYWRIGHT_MODULE=/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs node --test web/tests/shell-pane.browser.test.mjs
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
// Keep the real Dock, ShellPane, Ghostty WASM, and FitAddon. Only the host boundary is faked.
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { Dock } from './web/src/components/dock.tsx';
      const { side, mobile } = window.fixture;
      const dock = {
        tabs: [{ id: 'shell-tab', content: { kind: 'shell' } }],
        activeId: 'shell-tab', size: side === 'right' ? 380 : 240, minimised: false,
      };
      createRoot(document.getElementById('root')).render(
        <main id="frame" className="grid" style={{
          height: 600, width: 800,
          gridTemplateColumns: !mobile && side === 'right' ? 'minmax(0,1fr) 380px' : 'minmax(0,1fr)',
          gridTemplateRows: !mobile && side === 'bottom' ? 'minmax(0,1fr) 240px' : 'minmax(0,1fr)',
        }}>
          <Dock side={side} dock={dock} sessionId="shell-layout" shells
            mobile={mobile} dispatch={() => {}} />
        </main>
      );
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  outfile: "shell-pane-fixture.js",
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "shell-host-fixture",
    setup(build) {
      build.onLoad({ filter: /\/host\.tsx$/ }, () => ({
        contents: `export function useHost() { return { config: { fonts: { monospace: 'monospace' } } }; }`,
        loader: "tsx",
      }));
      build.onLoad({ filter: /\/shell-connection\.ts$/ }, () => ({
        contents: `
          window.shellSizes = [];
          window.shellOpens = 0;
          export async function openShell(sessionId, cols, rows) {
            window.shellOpens++;
            window.shellSizes.push({ cols, rows });
            return { id: 'fixture-shell' };
          }
          export function attachShell(id, handlers) {
            queueMicrotask(() => {
              handlers.ready();
              handlers.output(new TextEncoder().encode('Shell layout fixture\\r\\n$ '));
            });
            return { send() {}, close() {}, resize(cols, rows) { window.shellSizes.push({ cols, rows }); } };
          }
          export async function killShell() {}
        `,
        loader: "ts",
      }));
      build.onResolve({ filter: /ghostty-vt\.wasm\?url$/ }, () => ({ path: "wasm-url", namespace: "fixture" }));
      build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export default '/ghostty.wasm';` }));
      for (const [file, component] of [["git-pane", "GitPane"], ["subagents-pane", "SubagentsPane"], ["workflows-pane", "default"]]) {
        build.onLoad({ filter: new RegExp("/" + file + "\\.tsx$") }, () => ({
          contents: component === "default" ? "export default function() { return null; }" : `export function ${component}() { return null; }`,
          loader: "tsx",
        }));
      }
    },
  }],
});
const styles = await viteBuild({
  configFile: `${root}/web/vite.config.ts`,
  logLevel: "silent",
  build: { write: false, rollupOptions: { input: `${root}/web/src/index.css` } },
});
const css = styles.output.filter(file => file.type === "asset" && file.fileName.endsWith(".css"))
  .map(file => file.source).join("\n");

describe("Shell fills its Dock tab", () => {
  let browser;
  before(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    });
  });
  after(async () => { await browser?.close(); });

  for (const theme of ["light", "dark"]) {
    for (const placement of ["right", "bottom", "mobile"]) {
      it(`${theme}: ${placement} Shell fills, grows, and shrinks without reopening`, async () => {
        const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
        try {
          await page.route("http://shell-layout.test/**", route => {
            if (route.request().url().endsWith("/ghostty.wasm")) {
              return route.fulfill({ path: `${root}/node_modules/ghostty-web/ghostty-vt.wasm`, contentType: "application/wasm" });
            }
            return route.fulfill({ contentType: "text/html", body: `<html class="${theme}"><body><div id="root"></div></body></html>` });
          });
          await page.goto("http://shell-layout.test/", { waitUntil: "domcontentloaded" });
          await page.evaluate(placement => {
            window.fixture = { side: placement === "bottom" ? "bottom" : "right", mobile: placement === "mobile" };
          }, placement);
          await page.addStyleTag({ content: css });
          await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith(".js")).text });
          await page.waitForFunction(() => window.shellSizes?.length >= 2);

          const assertFills = async () => {
            const panel = await page.getByRole("tabpanel").boundingBox();
            const shell = await page.locator("[data-shell-pane]").boundingBox();
            const mount = await page.locator("[data-shell-pane] > div").boundingBox();
            assert.ok(panel.height > 150, "fixture must offer substantial vertical space");
            for (const bounds of [shell, mount]) {
              assert.ok(Math.abs(bounds.y - panel.y) <= 1, "Shell starts at the top of the tab body");
              assert.ok(Math.abs(bounds.height - panel.height) <= 1,
                `Shell must fill the tab body: ${bounds.height} vs ${panel.height}`);
              assert.ok(Math.abs(bounds.width - panel.width) <= 1, "Shell fills the tab width");
            }
          };
          await assertFills();
          const initialRows = await page.evaluate(() => window.shellSizes.at(-1).rows);
          for (const [height, direction] of [[760, "grow"], [500, "shrink"]]) {
            // Ghostty briefly guards against recursive resizes after fitting its canvas.
            await page.waitForTimeout(100);
            const previousRows = await page.evaluate(() => window.shellSizes.at(-1).rows);
            await page.locator("#frame").evaluate((frame, { height, placement }) => {
              frame.style.height = `${height}px`;
              if (placement === "bottom") frame.style.gridTemplateRows = `minmax(0,1fr) ${height - 300}px`;
            }, { height, placement });
            await assertFills();
            await page.waitForFunction(({ previousRows, direction }) => {
              const rows = window.shellSizes.at(-1).rows;
              return direction === "grow" ? rows > previousRows : rows < previousRows;
            }, { previousRows, direction });
          }
          assert.ok(await page.evaluate(initialRows => window.shellSizes.at(-1).rows < initialRows, initialRows));
          assert.equal(await page.evaluate(() => window.shellOpens), 1, "resizing must not reopen the Shell");
        } finally {
          await page.close();
        }
      });
    }
  }
});
