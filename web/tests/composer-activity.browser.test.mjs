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

describe("Composer activity border", () => {
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
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    errors = [];
    page = await browser.newPage({ reducedMotion: 'no-preference' });
    page.on('pageerror', error => errors.push(error.message));
    await page.route('http://flow.test/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
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
      const id = await mask.getAttribute('id');
      assert.ok(id);
      ids.push(id);
      assert.equal(await svg.locator(':scope > g').getAttribute('mask'), `url(#${id})`);
      assert.equal(await svg.locator(':scope > g > .composer-activity-glow').count(), 1);
      const cutout = mask.locator('.composer-activity-cutout');
      const exterior = mask.locator('rect:not(.composer-activity-cutout)');
      assert.equal(await style(exterior, 'fill'), 'rgb(255, 255, 255)');
      assert.equal(await style(cutout, 'fill'), 'rgb(0, 0, 0)');
      const geometry = await svg.evaluate(element => {
        const cutout = element.querySelector('.composer-activity-cutout');
        const { x, y, width, height } = cutout.getBBox();
        return {
          x, y, width, height,
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
      assert.equal(await style(glow, 'filter'), 'blur(4px)');
      assert.equal(await style(glow, 'opacity'), '0.45');
      assert.equal(await style(outline, 'strokeWidth'), '0.8px');
      assert.equal(await style(outline, 'filter'), 'none');
      assert.equal(await style(outline, 'opacity'), '0.65');
      assert.equal(await outline.getAttribute('mask'), null);
    }
    assert.equal(new Set(ids).size, ids.length);
  });

  it("renders glow pixels outside the border but masks interior pixels", async () => {
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      const pixels = await fixture('awaiting').evaluate(async element => {
        const width = Math.ceil(element.clientWidth);
        const height = Math.ceil(element.clientHeight);
        const padding = 20;
        const clone = element.cloneNode(true);
        const properties = ['width', 'height', 'rx', 'fill', 'stroke', 'stroke-width',
          'stroke-linecap', 'stroke-dasharray', 'stroke-dashoffset', 'filter', 'opacity'];
        const originals = [element, ...element.querySelectorAll('*')];
        const copies = [clone, ...clone.querySelectorAll('*')];
        originals.forEach((original, index) => {
          const computed = getComputedStyle(original);
          for (const property of properties) copies[index].style.setProperty(property, computed.getPropertyValue(property));
        });
        clone.querySelector('.composer-activity-outline').remove();
        clone.setAttribute('x', padding);
        clone.setAttribute('y', padding);
        clone.setAttribute('width', width);
        clone.setAttribute('height', height);
        clone.style.width = `${width}px`;
        clone.style.height = `${height}px`;
        clone.style.overflow = 'visible';
        const wrapper = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        wrapper.setAttribute('width', width + padding * 2);
        wrapper.setAttribute('height', height + padding * 2);
        wrapper.append(clone);
        const canvas = document.createElement('canvas');
        canvas.width = width + padding * 2;
        canvas.height = height + padding * 2;
        const context = canvas.getContext('2d');
        async function sample() {
          const image = new Image();
          image.src = `data:image/svg+xml,${encodeURIComponent(new XMLSerializer().serializeToString(wrapper))}`;
          await image.decode();
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0);
          const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
          const alpha = (x, y) => data[((y + padding) * canvas.width + x + padding) * 4 + 3];
          let interior = 0;
          for (let y = 1; y < height - 1; y++) {
            for (let x = Math.ceil(width / 3); x < width * 2 / 3; x++) interior = Math.max(interior, alpha(x, y));
          }
          return { interior, exterior: alpha(Math.floor(width / 2), -3) };
        }
        const masked = await sample();
        clone.querySelector('g').removeAttribute('mask');
        return { masked, unmasked: await sample() };
      });
      assert.equal(pixels.masked.interior, 0, `${theme}: glow entered the interior`);
      assert.ok(pixels.masked.exterior > 0, `${theme}: exterior glow is missing`);
      assert.ok(pixels.unmasked.interior > 0, `${theme}: mask did not remove visible glow`);
      assert.equal(pixels.masked.exterior, pixels.unmasked.exterior);
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
        const panel = pane().locator('.pane-measure');
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
          const { x, y, width, height } = element.getBBox();
          return { x, y, width, height };
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
