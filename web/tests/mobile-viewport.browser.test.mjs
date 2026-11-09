import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as buildWeb } from "vite";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browsers = process.env.PLAYWRIGHT_BROWSER ? [process.env.PLAYWRIGHT_BROWSER] : ['chromium', 'firefox', 'webkit'];
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = await buildWeb({
  configFile: `${root}/web/vite.config.ts`,
  logLevel: "silent",
  build: { write: false },
});
const css = (Array.isArray(output) ? output : [output]).flatMap(result => result.output)
  .filter(asset => asset.fileName.endsWith(".css")).map(asset => asset.source).join("\n")
  // Desktop automation does not supply iPhone cutouts. Substitute only the environment inputs,
  // leaving the production selectors, cascade, and real Composer layout intact.
  .replace(/env\(safe-area-inset-(top|right|bottom|left)\)/g, (_, side) => `var(--test-safe-area-${side}, 0px)`);
const bundle = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { useMobileViewport } from './web/src/lib/use-mobile-viewport.ts';
      import { Composer } from './web/src/components/composer.tsx';
      import { HostProvider } from './web/src/host.tsx';
      import { SessionsProvider } from './web/src/agent-sessions.tsx';
      import { TooltipProvider } from './web/src/components/ui/tooltip.tsx';
      import { useDraftStash } from './web/src/drafts.ts';
      const actions = { send: async () => ({}), abort: async () => {}, listSkills: async () => [] };
      function Frame() {
        const [mounted, setMounted] = useState(true);
        window.unmountViewport = () => setMounted(false);
        window.mountViewport = () => setMounted(true);
        return <>{mounted && <Viewport />}</>;
      }
      function Viewport() {
        useMobileViewport();
        const drafts = useDraftStash(['fixture']);
        const [safeFrame, setSafeFrame] = useState(true);
        window.setSafeFrame = setSafeFrame;
        return <main className={(safeFrame ? 'mobile-safe-frame ' : '') + 'flex h-full min-h-0 flex-col'}>
          <header>Agent Session</header>
          <section data-pane className="relative min-h-0 flex-1">
            <div className="transcript-scroller">Presentation Transcript</div>
            <Composer id="fixture" chrome={{ status: 'idle', backend: 'pi', scope: '/tmp/project',
              model: { id: 'fixture', label: 'Fixture model' } }} actions={actions} drafts={drafts}
              authorisingSummary={undefined} />
          </section>
        </main>;
      }
      createRoot(document.getElementById('root')).render(
        <HostProvider><SessionsProvider><TooltipProvider><Frame /></TooltipProvider></SessionsProvider></HostProvider>
      );
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

for (const browserName of browsers) describe(`${browserName}: Mobile keyboard viewport`, () => {
  let browser;
  let page;
  const bounds = async () => ({
    header: await page.locator('header').boundingBox(),
    footer: await page.locator('[data-pane] .pane-measure').boundingBox(),
    frame: await page.locator('#root').boundingBox(),
  });
  const viewport = (patch, event = 'resize') => page.evaluate(([patch, event]) => {
    Object.assign(window.visualViewport, patch);
    window.visualViewport.dispatchEvent(new Event(event));
  }, [patch, event]);
  before(async () => {
    browser = await playwright[browserName].launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage({ viewport: { width: 390, height: 844 },
      ...(browserName === 'webkit' ? { isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : {}),
    });
    await page.route('http://flow.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') await route.fulfill({ contentType: 'text/html', body:
        '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"><div id="root"></div>' });
      else if (path === '/api/config' || path === '/api/sessions') await route.fulfill({
        contentType: 'application/json', body: JSON.stringify(path === '/api/config'
          ? { scope: '/tmp/project', backends: ['pi'] } : []),
      });
      else await route.abort();
    });
    await page.goto('http://flow.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      Object.defineProperty(window, 'visualViewport', { configurable: true, value: Object.assign(new EventTarget(), {
        height: 844, offsetTop: 0, scale: 1,
      }) });
    });
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator('.cm-content').waitFor();
  });
  afterEach(async () => { await page?.close(); });

  for (const theme of ['light', 'dark']) {
    it(`${theme}: keeps the header visible and moves the composer above the keyboard`, async () => {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      const initial = await bounds();
      await viewport({ height: 480 });
      const keyboard = await bounds();
      assert.equal(keyboard.header.y, initial.header.y);
      assert.equal(keyboard.footer.y + keyboard.footer.height, 480 - 12);
      await viewport({ offsetTop: 120 }, 'scroll');
      const panned = await bounds();
      assert.equal(panned.header.y - 120, initial.header.y);
      assert.equal(panned.footer.y + panned.footer.height - 120, 480 - 12);
      await viewport({ height: 844, offsetTop: 0 });
      assert.deepEqual(await bounds(), initial);
    });
  }

  for (const theme of ['light', 'dark']) {
    it(`${theme}: applies the PWA home-indicator inset once, and clears it above the keyboard`, async () => {
      await page.evaluate(theme => {
        document.documentElement.classList.toggle('dark', theme === 'dark');
        document.documentElement.style.setProperty('--test-safe-area-top', '59px');
        document.documentElement.style.setProperty('--test-safe-area-bottom', '34px');
      }, theme);
      const initial = await bounds();
      assert.equal(initial.header.y, 59);
      assert.equal(initial.footer.y + initial.footer.height, 844 - 34 - 12,
        'Only the frame owns the home-indicator inset; Composer keeps its normal 12px spacing');
      await page.locator('.cm-content').click();
      await page.keyboard.type('PWA draft');
      for (const offsetTop of [0, 120]) {
        await viewport({ height: 480, offsetTop });
        const opened = await bounds();
        assert.equal(opened.footer.y + opened.footer.height - offsetTop, 480 - 12,
          'The visible keyboard edge is not the home-indicator edge');
        assert.equal(opened.header.y - offsetTop, 59);
      }
      await page.locator('.cm-content').evaluate(element => element.blur());
      await viewport({ height: 844, offsetTop: 0 });
      assert.deepEqual(await bounds(), initial);
      assert.match(await page.locator('.cm-content').textContent(), /PWA draft/);
    });
  }

  it("keeps cutout protection for a Composer outside the app safe frame", async () => {
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--test-safe-area-bottom', '34px');
      window.setSafeFrame(false);
    });
    await page.waitForFunction(() => !document.querySelector('main').classList.contains('mobile-safe-frame'));
    const initial = await bounds();
    assert.equal(initial.footer.y + initial.footer.height, 844 - 34);
    await viewport({ height: 480 });
    const opened = await bounds();
    assert.equal(opened.footer.y + opened.footer.height, 480 - 12);
    await viewport({ height: 844 });
    assert.deepEqual(await bounds(), initial);
  });

  it("handles a keyboard-sized viewport on initial mount", async () => {
    await page.evaluate(() => {
      document.documentElement.style.setProperty('--test-safe-area-bottom', '34px');
      window.unmountViewport();
    });
    await page.locator('.cm-content').waitFor({ state: 'detached' });
    await viewport({ height: 480, offsetTop: 80 });
    await page.evaluate(() => window.mountViewport());
    await page.locator('.cm-content').waitFor();
    const opened = await bounds();
    assert.equal(opened.footer.y + opened.footer.height - 80, 480 - 12);
    await viewport({ height: 844, offsetTop: 0 });
    const closed = await bounds();
    assert.equal(closed.footer.y + closed.footer.height, 844 - 34 - 12);
  });

  it("keeps landscape cutouts while clearing only the keyboard's bottom inset", async () => {
    await page.setViewportSize({ width: 844, height: 390 });
    await page.evaluate(() => {
      const style = document.documentElement.style;
      style.setProperty('--test-safe-area-bottom', '21px');
      style.setProperty('--test-safe-area-left', '44px');
      style.setProperty('--test-safe-area-right', '44px');
    });
    await viewport({ height: 390, offsetTop: 0 });
    const initial = await bounds();
    assert.equal(initial.footer.x, 44 + 12);
    assert.equal(initial.footer.x + initial.footer.width, 844 - 44 - 12);
    assert.equal(initial.footer.y + initial.footer.height, 390 - 21 - 12);
    await viewport({ height: 200 });
    const opened = await bounds();
    assert.equal(opened.footer.x, initial.footer.x);
    assert.equal(opened.footer.width, initial.footer.width);
    assert.equal(opened.footer.y + opened.footer.height, 200 - 12);
    await viewport({ height: 390 });
    assert.deepEqual(await bounds(), initial);
  });

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
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-viewport-safe-bottom')), '');
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--mobile-viewport-height')), '');
  });
});
