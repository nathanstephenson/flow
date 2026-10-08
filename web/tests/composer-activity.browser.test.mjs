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
  const rect = () => activity().locator('rect');
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
        assert.equal(await svg.locator('rect').getAttribute('pathLength'), '100');
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
        assert.equal(await style(svg.locator('rect'), 'stroke'), color);
        assert.equal(await style(activity(), 'color'), color);
        assert.equal(await pane().locator('header').evaluate(element => element.getAnimations({ subtree: true })
          .filter(animation => animation instanceof CSSAnimation).length), 0);
        colors[theme].push(color);
      }
      assert.notEqual(...colors[theme]);
    }
    assert.notDeepEqual(colors.light, colors.dark);
  });

  it("moves a normalized running dash around the border", async () => {
    assert.equal(await style(rect(), 'strokeDasharray'), '12px, 88px');
    assert.equal(await style(rect(), 'strokeWidth'), '1.5px');
    assert.equal(await style(rect(), 'animationName'), 'composer-orbit');
    assert.equal(await style(rect(), 'animationDuration'), '5s');
    assert.equal(await style(rect(), 'animationTimingFunction'), 'linear');
    assert.equal(await style(rect(), 'animationIterationCount'), 'infinite');
    const initial = await offset();
    await page.waitForFunction(initial => getComputedStyle(document.querySelector('main .composer-activity rect')).strokeDashoffset !== initial, initial);
    const frames = await rect().evaluate(element => element.getAnimations()[0].effect.getKeyframes().map(frame => frame.strokeDashoffset));
    assert.deepEqual(frames, ['0px', '-100px']);
  });

  it("shows a static full border while awaiting and no border for other statuses", async () => {
    await render('awaiting');
    assert.equal(await activity().getAttribute('data-status'), 'awaiting');
    assert.equal(await style(rect(), 'strokeDasharray'), 'none');
    assert.equal(await style(rect(), 'fill'), 'none');
    assert.equal(await style(rect(), 'animationName'), 'none');
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
    assert.equal(await style(rect(), 'animationName'), 'none');
    assert.equal(await rect().evaluate(element => element.getAnimations().length), 0);
    const initial = await offset();
    await page.waitForTimeout(150);
    assert.equal(await offset(), initial);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    assert.equal(await style(rect(), 'animationName'), 'composer-orbit');
  });

  it("fits wide and phone panels without intercepting composer controls", async () => {
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      for (const floating of [true, false]) {
        await render('running', floating);
        const panel = pane().locator('.pane-measure');
        const box = await panel.boundingBox();
        const svgBox = await activity().boundingBox();
        const rectBox = await rect().evaluate(element => {
          const { x, y, width, height } = element.getBBox();
          return { x, y, width, height };
        });
        const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 0.5, `${actual} != ${expected}`);
        assert.equal(await style(panel, 'position'), 'relative');
        assert.equal(await style(activity(), 'position'), 'absolute');
        assert.equal(await style(activity(), 'top'), '-1px');
        assert.equal(await style(activity(), 'left'), '-1px');
        assert.equal(await style(activity(), 'overflow'), 'visible');
        assert.equal(await style(activity(), 'pointerEvents'), 'none');
        close(box.width, width === 1440 ? 896 : width - (floating ? 24 : 0));
        for (const key of ['x', 'y', 'width', 'height']) close(svgBox[key], box[key]);
        close(rectBox.x, 1);
        close(rectBox.y, 1);
        close(rectBox.width, svgBox.width - 2);
        close(rectBox.height, svgBox.height - 2);
        assert.equal(await style(rect(), 'rx'), await style(panel, 'borderTopLeftRadius'));
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
