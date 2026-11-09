// Runs Chromium, Firefox, and touch/mobile-emulated WebKit by default.
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/composer-activity.browser.test.mjs
// Set PLAYWRIGHT_BROWSER=chromium|firefox|webkit to select one engine.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as buildWeb } from "vite";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browsers = process.env.PLAYWRIGHT_BROWSER ? [process.env.PLAYWRIGHT_BROWSER] : ["chromium", "firefox", "webkit"];
const root = fileURLToPath(new URL("../../", import.meta.url));
const output = await buildWeb({
  configFile: `${root}/web/vite.config.ts`,
  logLevel: "silent",
  build: { write: false },
});
const css = (Array.isArray(output) ? output : [output])
  .flatMap(result => result.output)
  .filter(asset => asset.fileName.endsWith(".css"))
  .map(asset => asset.source).join("\n");
assert.ok(css.includes(".composer-activity"));
const bundle = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { ComposerActivity } from './web/src/components/status-indicator.tsx';
      import { Composer } from './web/src/components/composer.tsx';
      import { AgentSessionPaneHeader } from './web/src/components/agent-session-pane-header.tsx';
      import { HostProvider } from './web/src/host.tsx';
      import { SessionsProvider } from './web/src/agent-sessions.tsx';
      import { TooltipProvider } from './web/src/components/ui/tooltip.tsx';
      import { useDraftStash } from './web/src/drafts.ts';
      const statuses = ['running', 'awaiting', 'idle', 'dormant', 'settled', 'ended'];
      const actions = {
        send: async () => ({}), abort: async () => { window.aborted = true; },
        listSkills: async () => [], setModel() {}, setEffort() {},
      };
      function Harness() {
        const [status, setStatus] = useState('running');
        const [floating, setFloating] = useState(true);
        window.renderStatus = (status, floating = true) => flushSync(() => {
          setStatus(status); setFloating(floating);
        });
        const drafts = useDraftStash(['fixture']);
        const chrome = {
          status, backend: 'pi', scope: '/tmp/project', queueDepth: 0,
          activeSubagents: 0, activeBackgroundCalls: 0, compacting: false, spoken: false,
          model: { id: 'fixture', label: 'Fixture model' },
        };
        return <>
          <section aria-label="Component fixtures">
            {statuses.map(status => <div key={status} data-fixture={status}
              className="relative pane-measure rounded-xl border h-12">
              <ComposerActivity status={status} />
            </div>)}
          </section>
          <main data-pane className="relative h-96" aria-label="Agent Session pane">
            <header><AgentSessionPaneHeader sessionId="fixture" title="Fixture Agent Session" chrome={chrome} /></header>
            <Composer id="fixture" chrome={chrome} actions={actions} drafts={drafts}
              floating={floating} authorisingSummary={undefined} onShowSubagents={() => {}} />
          </main>
        </>;
      }
      createRoot(document.getElementById('root')).render(
        <HostProvider><SessionsProvider><TooltipProvider><Harness /></TooltipProvider></SessionsProvider></HostProvider>
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

for (const browserName of browsers) describe(`${browserName}: Composer activity border`, () => {
  let browser;
  let page;
  let errors;
  const fixture = status => page.locator(`[data-fixture="${status}"] .composer-activity`);
  const pane = () => page.getByRole('main', { name: 'Agent Session pane' });
  const activity = () => pane().locator('.composer-activity');
  const rect = () => activity().locator(':scope > .composer-activity-outline');
  const shapes = () => activity().locator('.composer-activity-shape');
  const style = (locator, property) => locator.evaluate((element, property) => getComputedStyle(element)[property], property);
  const offset = () => style(rect(), 'strokeDashoffset');
  const render = (status, floating = true) => page.evaluate(([status, floating]) => window.renderStatus(status, floating), [status, floating]);
  before(async () => {
    browser = await playwright[browserName].launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    errors = [];
    page = await browser.newPage({
      reducedMotion: 'no-preference',
      ...(browserName === 'webkit' ? { isMobile: true, hasTouch: true } : {}),
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://flow.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' });
      } else if (path === '/api/config' || path === '/api/sessions') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(
          path === '/api/config' ? { scope: '/tmp/project', backends: ['pi'] } : [],
        ) });
      } else {
        await route.abort();
      }
    });
    await page.goto('http://flow.test/', { waitUntil: 'domcontentloaded' });
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await pane().getByRole('button', { name: 'Abort the current turn' }).waitFor();
  });
  afterEach(async () => {
    await page?.close();
    assert.deepEqual(errors, []);
  });

  it("keeps mobile input text large enough to avoid focus zoom", async () => {
    for (const width of [390, 820, 1023, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        const input = pane().locator('.cm-content');
        await input.click();
        assert.equal(await style(input, 'fontSize'), width < 1024 ? '16px' : '14px');
      }
    }
  });

  it("uses the active and awaiting tokens in both themes", async () => {
    const colors = {};
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      colors[theme] = [];
      for (const status of ['running', 'awaiting']) {
        await render(status);
        const svg = fixture(status);
        assert.equal(await svg.getAttribute('data-status'), status);
        assert.equal(await svg.getAttribute('aria-hidden'), 'true');
        assert.equal(await svg.locator(':scope > .composer-activity-outline').getAttribute('pathLength'), '100');
        const expected = await page.evaluate(token => {
          const probe = document.createElement('span');
          probe.style.color = `var(${token})`;
          document.body.append(probe);
          const color = getComputedStyle(probe).color;
          probe.remove();
          return color;
        }, status === 'running' ? '--status-active' : '--status-awaiting');
        const color = await style(svg, 'color');
        assert.equal(color, expected);
        for (const shape of await svg.locator('.composer-activity-shape').all()) {
          assert.equal(await style(shape, 'stroke'), color);
        }
        assert.equal(await style(activity(), 'color'), color);
        assert.equal(await pane().locator('header').evaluate(element => element.getAnimations({ subtree: true })
          .filter(animation => animation instanceof CSSAnimation).length), 0);
        colors[theme].push(color);
      }
      assert.notEqual(...colors[theme]);
    }
    assert.notDeepEqual(colors.light, colors.dark);
  });

  it("uses unique rounded exterior masks and separate soft glow layers", async () => {
    const ids = [];
    for (const svg of [fixture('running'), fixture('awaiting'), activity()]) {
      const mask = svg.locator('defs > mask');
      const filter = svg.locator('defs > filter');
      const filterId = await filter.getAttribute('id');
      assert.ok(filterId);
      ids.push(filterId);
      assert.equal(await filter.getAttribute('color-interpolation-filters'), 'sRGB');
      assert.equal(await filter.getAttribute('filterUnits'), 'userSpaceOnUse');
      for (const [attribute, value] of [['x', '-50%'], ['y', '-50%'], ['width', '200%'], ['height', '200%']]) {
        assert.equal(await filter.getAttribute(attribute), value);
      }
      assert.equal(await filter.locator('feGaussianBlur').getAttribute('stdDeviation'), '4');
      assert.equal(await svg.locator('.composer-activity-glow').getAttribute('filter'), `url(#${filterId})`);
      const id = await mask.getAttribute('id');
      assert.ok(id);
      ids.push(id);
      assert.equal(await svg.locator(':scope > .composer-activity-glow').getAttribute('mask'), `url(#${id})`);
      assert.equal(await svg.locator(':scope > .composer-activity-glow').count(), 1);
      const cutout = mask.locator('.composer-activity-cutout');
      const exterior = mask.locator('rect:not(.composer-activity-cutout)');
      assert.equal(await style(exterior, 'fill'), 'rgb(255, 255, 255)');
      assert.equal(await style(cutout, 'fill'), 'rgb(0, 0, 0)');
      const geometry = await svg.evaluate(element => {
        const cutout = element.querySelector('.composer-activity-cutout');
        // Firefox may return an empty getBBox() for a definition that is not directly painted.
        return {
          x: cutout.x.baseVal.value, y: cutout.y.baseVal.value,
          width: cutout.width.baseVal.value, height: cutout.height.baseVal.value,
          svgWidth: element.clientWidth, svgHeight: element.clientHeight,
          radius: getComputedStyle(cutout).rx,
          outlineRadius: getComputedStyle(element.querySelector('.composer-activity-outline')).rx,
        };
      });
      assert.equal(geometry.x, 0);
      assert.equal(geometry.y, 0);
      assert.equal(geometry.width, geometry.svgWidth);
      assert.equal(geometry.height, geometry.svgHeight);
      assert.equal(geometry.radius, geometry.outlineRadius);
      const glow = svg.locator('.composer-activity-glow');
      const outline = svg.locator(':scope > .composer-activity-outline');
      assert.equal(await style(glow, 'strokeWidth'), '6px');
      assert.ok((await style(glow, 'filter')).includes(`#${filterId}`));
      assert.equal(await style(glow, 'opacity'), '0.45');
      assert.equal(await style(outline, 'strokeWidth'), '0.8px');
      assert.equal(await style(outline, 'filter'), 'none');
      assert.equal(await style(outline, 'opacity'), '0.65');
      assert.equal(await outline.getAttribute('mask'), null);
    }
    assert.equal(new Set(ids).size, ids.length);
  });

  it("paints a soft exterior glow and moving dashes on desktop and phone widths", async () => {
    // Inspect actual page pixels, not just computed CSS or a re-serialized SVG: WebKit reports
    // CSS blur() on an SVG rect even when it paints an unblurred stroke.
    await page.addStyleTag({ content: `
      [data-fixture], [data-pane] { display: none !important; }
      [data-fixture].paint-target { display: block !important; margin: 40px; width: calc(100% - 80px); }
      .paint-target .composer-activity-outline { visibility: hidden; }
    ` });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 400 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
        for (const status of ['awaiting', 'running']) {
          await page.locator('[data-fixture]').evaluateAll((elements, status) => {
            elements.forEach(element => element.classList.toggle('paint-target', element.dataset.fixture === status));
          }, status);
          const profiles = [];
          for (const time of [0, 1250]) {
            await fixture(status).evaluate((element, time) => {
              element.getAnimations({ subtree: true }).forEach(animation => { animation.pause(); animation.currentTime = time; });
            }, time);
            const bounds = await fixture(status).boundingBox();
            const png = await page.screenshot();
            const pixels = await page.evaluate(async ({ image, bounds }) => {
              const img = new Image();
              img.src = image;
              await img.decode();
              const canvas = document.createElement('canvas');
              canvas.width = img.width; canvas.height = img.height;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(img, 0, 0);
              const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
              const chroma = (x, y) => {
                const i = (Math.round(y) * canvas.width + Math.round(x)) * 4;
                return Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
              };
              const { x, y, width, height } = bounds;
              const exterior = [];
              let interior = 0;
              for (let dx = 20; dx < width - 20; dx++) {
                exterior.push(chroma(x + dx, y - 6), chroma(x + dx, y + height + 5));
                interior = Math.max(interior, chroma(x + dx, y + 8), chroma(x + dx, y + height - 8));
              }
              for (let dy = 20; dy < height - 20; dy++) {
                exterior.push(chroma(x - 6, y + dy), chroma(x + width + 5, y + dy));
              }
              return { exterior, interior };
            }, { image: `data:image/png;base64,${png.toString('base64')}`, bounds });
            assert.ok(Math.max(...pixels.exterior) > 2, `${width}/${theme}/${status}: soft glow missing six pixels outside the border`);
            assert.equal(pixels.interior, 0, `${width}/${theme}/${status}: glow leaked inside`);
            profiles.push(pixels.exterior);
          }
          if (status === 'running') assert.notDeepEqual(profiles[0], profiles[1], 'the painted dash must move');
          else assert.deepEqual(profiles[0], profiles[1], 'Awaiting must stay static');
        }
      }
    }
  });

  it("moves aligned normalized dashes around the border", async () => {
    assert.equal(await shapes().count(), 2);
    for (const shape of await shapes().all()) {
      assert.equal(await shape.getAttribute('pathLength'), '100');
      assert.equal(await style(shape, 'strokeDasharray'), '12px, 88px');
      assert.equal(await style(shape, 'animationName'), 'composer-orbit');
      assert.equal(await style(shape, 'animationDuration'), '5s');
      assert.equal(await style(shape, 'animationTimingFunction'), 'linear');
      assert.equal(await style(shape, 'animationIterationCount'), 'infinite');
      const frames = await shape.evaluate(element => element.getAnimations()[0].effect.getKeyframes().map(frame => frame.strokeDashoffset));
      assert.deepEqual(frames, ['0px', '-100px']);
    }
    const initial = await offset();
    await page.waitForFunction(initial => getComputedStyle(document.querySelector('main .composer-activity > .composer-activity-outline')).strokeDashoffset !== initial, initial);
    const layers = await shapes().evaluateAll(elements => elements.map(element => ({
      offset: getComputedStyle(element).strokeDashoffset,
      start: element.getAnimations()[0].startTime,
      time: element.getAnimations()[0].currentTime,
    })));
    assert.deepEqual(layers[0], layers[1]);
  });

  it("shows a static full border while awaiting and no border for other statuses", async () => {
    await render('awaiting');
    assert.equal(await activity().getAttribute('data-status'), 'awaiting');
    for (const shape of await shapes().all()) {
      assert.equal(await style(shape, 'strokeDasharray'), 'none');
      assert.equal(await style(shape, 'fill'), 'none');
      assert.equal(await style(shape, 'animationName'), 'none');
    }
    const initial = await offset();
    await page.waitForTimeout(150);
    assert.equal(await offset(), initial);
    for (const status of ['idle', 'dormant', 'settled', 'ended']) {
      assert.equal(await fixture(status).count(), 0);
      await render(status);
      assert.equal(await activity().count(), 0);
    }
    await render('running');
    assert.equal(await activity().count(), 1);
    assert.equal(await pane().locator('header .composer-activity').count(), 0);
  });

  it("freezes running animation when reduced motion is requested", async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const shape of await shapes().all()) {
      assert.equal(await style(shape, 'animationName'), 'none');
      assert.equal(await shape.evaluate(element => element.getAnimations().length), 0);
    }
    const initial = await offset();
    await page.waitForTimeout(150);
    assert.equal(await offset(), initial);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    for (const shape of await shapes().all()) {
      assert.equal(await style(shape, 'animationName'), 'composer-orbit');
    }
  });

  it("fits wide and phone panels without intercepting composer controls", async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const floating of [true, false]) {
        await render('running', floating);
        const panel = activity().locator('..');
        const box = await panel.boundingBox();
        const svgBox = await activity().boundingBox();
        const shapeBoxes = await shapes().evaluateAll(elements => elements.map(element => {
          const { x, y, width, height } = element.getBBox();
          return { x, y, width, height };
        }));
        const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.5, `${actual} != ${expected}`);
        assert.equal(await style(panel, 'position'), 'relative');
        assert.equal(await style(activity(), 'position'), 'absolute');
        assert.equal(await style(activity(), 'top'), '-1px');
        assert.equal(await style(activity(), 'left'), '-1px');
        assert.equal(await style(activity(), 'overflow'), 'visible');
        assert.equal(await style(activity(), 'pointerEvents'), 'none');
        close(box.width, width === 1440 ? 896 : width - (floating ? 24 : 0));
        for (const key of ['x', 'y', 'width', 'height']) close(svgBox[key], box[key]);
        assert.equal(shapeBoxes.length, 2);
        for (const shapeBox of shapeBoxes) {
          close(shapeBox.x, 1);
          close(shapeBox.y, 1);
          close(shapeBox.width, svgBox.width - 2);
          close(shapeBox.height, svgBox.height - 2);
        }
        for (const shape of await shapes().all()) {
          assert.equal(await style(shape, 'rx'), await style(panel, 'borderTopLeftRadius'));
        }
        const cutoutBox = await activity().locator('.composer-activity-cutout').evaluate(element => {
          return { x: element.x.baseVal.value, y: element.y.baseVal.value,
            width: element.width.baseVal.value, height: element.height.baseVal.value };
        });
        close(cutoutBox.x, 0);
        close(cutoutBox.y, 0);
        close(cutoutBox.width, svgBox.width);
        close(cutoutBox.height, svgBox.height);
        const editor = pane().locator('.cm-content');
        await editor.click();
        await page.keyboard.type('Draft');
        assert.match(await editor.textContent(), /Draft/);
        await page.evaluate(() => { window.aborted = false; });
        await pane().getByRole('button', { name: 'Abort the current turn' }).click();
        assert.equal(await page.evaluate(() => window.aborted), true);
      }
    }
  });
});
