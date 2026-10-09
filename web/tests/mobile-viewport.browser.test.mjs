import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as buildWeb } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = await buildWeb({
  configFile: `${root}/web/vite.config.ts`,
  logLevel: "silent",
  build: { write: false },
});
const css = (Array.isArray(output) ? output : [output]).flatMap(result => result.output)
  .filter(asset => asset.fileName.endsWith(".css")).map(asset => asset.source).join("\n");
const bundle = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useMobileViewport } from './web/src/lib/use-mobile-viewport.ts';
      function Frame() {
        const [mounted, setMounted] = useState(true);
        window.unmountViewport = () => setMounted(false);
        return <>{mounted && <Viewport />}</>;
      }
      function Viewport() {
        useMobileViewport();
        return <main className="mobile-safe-frame flex h-full min-h-0 flex-col">
          <header>Agent Session</header>
          <section className="transcript-scroller flex-1">Presentation Transcript</section>
          <footer>Composer</footer>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Frame />);
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});

describe("Mobile keyboard viewport", () => {
  let browser;
  let page;
  const bounds = async () => ({
    header: await page.locator('header').boundingBox(),
    footer: await page.locator('footer').boundingBox(),
    frame: await page.locator('#root').boundingBox(),
  });
  const viewport = (patch, event = 'resize') => page.evaluate(([patch, event]) => {
    Object.assign(window.visualViewport, patch);
    window.visualViewport.dispatchEvent(new Event(event));
  }, [patch, event]);
  before(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>');
    await page.evaluate(() => {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), {
        height: 844, offsetTop: 0, scale: 1,
      }) });
    });
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('header').waitFor();
  });
  afterEach(async () => { await page?.close(); });

  for (const theme of ['light', 'dark']) {
    it(`${theme}: keeps the header visible and moves the composer above the keyboard`, async () => {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      const initial = await bounds();
      await viewport({ height: 480 });
      const keyboard = await bounds();
      assert.equal(keyboard.header.y, initial.header.y);
      assert.equal(keyboard.footer.y + keyboard.footer.height, 480);
      await viewport({ offsetTop: 120 }, 'scroll');
      const panned = await bounds();
      assert.equal(panned.header.y - 120, initial.header.y);
      assert.equal(panned.footer.y + panned.footer.height - 120, 480);
      await viewport({ height: 844, offsetTop: 0 });
      assert.deepEqual(await bounds(), initial);
    });
  }

  it("disables double-tap zoom while allowing scrolling and pinch zoom", async () => {
    for (const width of [390, 820, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        assert.equal(await page.evaluate(() => getComputedStyle(document.body).touchAction), 'manipulation');
      }
    }
  });

  it("does not resize the frame during manual pinch zoom", async () => {
    const initial = await bounds();
    await viewport({ height: 422, offsetTop: 100, scale: 2 });
    assert.deepEqual(await bounds(), initial);
    await viewport({ height: 844, offsetTop: 0, scale: 1 });
    assert.deepEqual(await bounds(), initial);
  });

  it("leaves desktop layout unchanged and removes mobile listeners", async () => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--mobile-viewport-height'));
    const initial = await bounds();
    await viewport({ height: 480, offsetTop: 120 });
    assert.deepEqual(await bounds(), initial);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--mobile-viewport-height') === '480px');
    await page.evaluate(() => window.unmountViewport());
    await page.waitForFunction(() => !document.documentElement.style.getPropertyValue('--mobile-viewport-height'));
    await viewport({ height: 300, offsetTop: 80 });
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-viewport-top')), '');
  });
});
