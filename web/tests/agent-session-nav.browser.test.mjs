// Real DOM coverage: node's presentation tests cannot model focus loss during React mutations.
// Run with an existing Playwright installation (no project dependency required):
// PLAYWRIGHT_MODULE=/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs \
//   node --test web/tests/agent-session-nav.browser.test.mjs
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as viteBuild } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { AgentSessionNav } from './web/src/components/agent-session-nav.tsx';
      import { KeyboardLayer } from './web/src/components/keyboard-layer.tsx';
      import { SidebarProvider } from './web/src/components/ui/sidebar.tsx';
      import { statusIndicatorColor } from './web/src/components/status-indicator.tsx';
      import { installCursorGloss } from './web/src/lib/cursor-gloss.ts';
      window.statusColor = statusIndicatorColor;
      window.paneFocuses = 0;
      installCursorGloss(document);
      const root = createRoot(document.getElementById('root'));
      const summary = (id, status = 'idle') => ({
        id, title: id, status, backend: 'pi', scope: '/tmp/project',
        restingAt: Date.now(), createdAt: Date.now(),
        activeSubagents: 0, activeBackgroundCalls: 0,
      });
      let props = {
        sessions: [summary('a'), summary('b'), summary('filed', 'settled')],
        cursorId: 'a', focusedId: 'a',
        onFocus() {}, onSettle() {}, onNew() {}, onOpenSettings() {},
      };
      window.renderRail = (patch = {}) => {
        props = { ...props, ...patch };
        flushSync(() => root.render(<React.StrictMode>
          <KeyboardLayer view="session" handlers={{ 'focus-pane': () => window.paneFocuses++ }}>
            <SidebarProvider>
              <AgentSessionNav {...props} />
              <input aria-label="Composer" />
            </SidebarProvider>
          </KeyboardLayer>
        </React.StrictMode>));
      };
      window.reparent = (status) => window.renderRail({
        sessions: props.sessions.map(s => s.id === props.cursorId ? { ...s, status } : s),
      });
      window.attention = (group) => window.renderRail({
        sessions: props.sessions.map(s => s.id === props.cursorId ? {
          ...s, attention: group ? { group, reason: 'Needs review', at: Date.now() } : undefined,
        } : s),
      });
      // The app shell owns vertical movement; reproduce its cursor prop update rather than
      // introducing a second vertical key handler into the component under test.
      window.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          window.renderRail({ cursorId: props.cursorId === 'a' ? 'b' : 'a' });
        }
      });
      window.renderRail();
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  outfile: 'rail-fixture.js',
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});

// Compile the real theme/utilities too: state utilities must not defeat the scoped rail CSS.
const styles = await viteBuild({
  configFile: `${root}/web/vite.config.ts`,
  logLevel: 'silent',
  build: { write: false, rollupOptions: { input: `${root}/web/src/index.css` } },
});
const themeCSS = styles.output.filter(file => file.type === 'asset' && file.fileName.endsWith('.css'))
  .map(file => file.source).join('\n');

describe("Agent Session rail DOM focus and material", () => {
  let browser;
  let page;
  const cursor = () => page.locator('[data-cursor="true"]');
  const focusedIs = async (locator) => assert.equal(
    await locator.evaluate(element => document.activeElement === element), true,
  );
  before(async () => { browser = await chromium.launch({
    headless: true, executablePath: process.env.CHROMIUM_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: themeCSS });
    await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
    await cursor().waitFor();
  });
  afterEach(async () => { await page?.close(); });

  it("moves DOM focus with repeated arrow cursor changes", async () => {
    await cursor().focus();
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowDown']) {
      await page.keyboard.press(key);
      await focusedIs(cursor());
    }
  });

  it("restores a focused row after group reparenting, including Settled", async () => {
    await cursor().focus();
    for (const status of ['running', 'dormant', 'settled', 'idle']) {
      await page.evaluate(status => window.reparent(status), status);
      await focusedIs(cursor());
      assert.equal(await cursor().isVisible(), true);
    }
  });

  it("keeps focus when attention reparents a row without changing its cursor or status", async () => {
    await cursor().focus();
    for (const group of ['needs-input', 'unread', undefined]) {
      await page.evaluate(group => window.attention(group), group);
      await focusedIs(cursor());
    }
  });

  it("preserves the row action until movement and restores focus when it is removed", async () => {
    await cursor().focus();
    await page.keyboard.press('ArrowRight');
    const action = page.locator('[data-sidebar="menu-item"]').filter({ has: cursor() })
      .locator('[data-sidebar="menu-action"]');
    await focusedIs(action);
    await page.evaluate(() => window.renderRail({ focusedId: 'b' }));
    await focusedIs(action);
    await page.keyboard.press('ArrowDown');
    await focusedIs(cursor());
    await page.keyboard.press('ArrowRight');
    await page.evaluate(() => window.reparent('settled'));
    await focusedIs(cursor());
  });

  it("does not steal focus from the composer after the user leaves the rail", async () => {
    await cursor().focus();
    const composer = page.getByRole('textbox', { name: 'Composer' });
    await composer.focus();
    await page.evaluate(() => window.renderRail({ cursorId: 'b' }));
    await page.evaluate(() => window.reparent('running'));
    await focusedIs(composer);
  });

  it("keeps native status colors, including independent work and stale counts", async () => {
    const colors = await page.evaluate(() => {
      const statuses = ['awaiting', 'running', 'idle', 'dormant', 'ended', 'settled'];
      return statuses.map(status => [window.statusColor(status), window.statusColor(status, true)]);
    });
    assert.deepEqual(colors, [
      ['var(--status-awaiting)', 'var(--status-awaiting)'],
      ['var(--status-active)', 'var(--status-active)'],
      ['var(--foreground)', 'var(--status-active)'],
      ['var(--muted-foreground)', 'var(--muted-foreground)'],
      ['var(--destructive)', 'var(--destructive)'],
      ['color-mix(in srgb, var(--muted-foreground) 55%, transparent)', 'color-mix(in srgb, var(--muted-foreground) 55%, transparent)'],
    ]);
    for (const count of ['activeSubagents', 'activeBackgroundCalls', 'activeWorkflows']) {
      await page.evaluate(count => window.renderRail({ sessions: [{
        id: 'a', title: 'a', status: 'idle', backend: 'pi', scope: '/tmp', restingAt: Date.now(),
        activeSubagents: 0, activeBackgroundCalls: 0, activeWorkflows: 0, [count]: 1,
      }] }), count);
      assert.equal(await cursor().evaluate(node => node.style.getPropertyValue('--agent-session-status')), 'var(--status-active)');
    }
  });

  it("hides only ordinary Band headings without losing list names or attention", async () => {
    assert.equal(await page.locator('.agent-session-band > [data-sidebar="group-label"]').isVisible(), false);
    assert.equal(await page.getByRole('list', { name: 'Idle Agent Sessions' }).count(), 1);
    assert.match(await page.locator('summary').textContent(), /Settled/);
    for (const group of ['needs-input', 'unread']) {
      await page.evaluate(group => window.attention(group), group);
      const label = group === 'needs-input' ? 'Needs input' : 'Unread';
      assert.equal(await page.getByRole('list', { name: `${label} Agent Sessions` }).count(), 1);
      assert.equal(await page.locator('[data-sidebar="group-label"]').filter({ hasText: label }).isVisible(), true);
      assert.match(await cursor().textContent(), /Needs review/);
    }
    const header = page.locator('[data-sidebar="header"]');
    const action = header.getByRole('button', { name: 'New Agent Session' });
    assert.equal((await action.boundingBox()).height, 42);
    assert.equal((await action.boundingBox()).width, (await header.boundingBox()).width);
    assert.equal(await action.evaluate(node => getComputedStyle(node).borderRadius), '0px');
  });

  it("preserves native disclosure Enter and Space alongside the global pane shortcut", async () => {
    const summary = page.locator('summary');
    await summary.focus();
    await summary.press('Space');
    await page.waitForFunction(() => document.querySelector('details').open);
    await summary.press('Enter');
    await page.waitForFunction(() => !document.querySelector('details').open);
    await summary.press('Enter');
    await page.waitForFunction(() => document.querySelector('details').open);
    await focusedIs(summary);
    assert.equal(await page.evaluate(() => window.paneFocuses), 0);
    await cursor().focus(); await cursor().press('Enter');
    assert.equal(await page.evaluate(() => window.paneFocuses), 1);
  });

  it("names Ended rows without describing them as Settled", async () => {
    await page.evaluate(() => window.reparent('ended'));
    assert.match(await page.locator('summary').textContent(), /Settled \/ Ended/);
    assert.equal(await page.getByRole('list', { name: 'Settled and Ended Agent Sessions' }).count(), 1);
  });

  it("exposes status words when forced colours collapse the status hues", async () => {
    await page.emulateMedia({ forcedColors: 'active' });
    for (const status of ['idle', 'running', 'dormant', 'settled', 'ended']) {
      await page.evaluate(status => window.reparent(status), status);
      const word = cursor().locator('.agent-session-status-text');
      assert.equal(await word.evaluate(node => getComputedStyle(node).position), 'static');
      assert.ok((await word.boundingBox()).width > 10);
      assert.equal(await cursor().evaluate(node => getComputedStyle(node, '::before').display), 'none');
    }
  });

  it("deepens the original dark pastels without making them luminous", async () => {
    const accents = await page.evaluate(() => {
      document.documentElement.classList.add('dark');
      const css = getComputedStyle(document.documentElement);
      return ['--status-active', '--status-awaiting', '--diff-added'].map(token => {
        const match = css.getPropertyValue(token).trim().match(/^oklch\(([\d.]+)(%)?\s+([\d.]+)/);
        return { token, lightness: Number(match[1]) / (match[2] ? 100 : 1), chroma: Number(match[3]) };
      });
    });
    const pastels = [{ lightness: .83, chroma: .08 }, { lightness: .79, chroma: .10 }, { lightness: .80, chroma: .09 }];
    accents.forEach((accent, index) => {
      assert.ok(accent.lightness <= pastels[index].lightness - .08, `${accent.token}: depth rather than brightness`);
      assert.ok(accent.chroma >= pastels[index].chroma * 1.5, `${accent.token}: more pigment than the pastel`);
    });
  });

  for (const mode of ['light', 'dark']) {
    it(`${mode}: status-hued selection preserves base/ink, transparent Settle and inset focus`, async () => {
      await page.evaluate(mode => document.documentElement.classList.toggle('dark', mode === 'dark'), mode);
      const face = () => cursor().evaluate(node => {
        const style = getComputedStyle(node);
        const flow = getComputedStyle(node, '::before');
        const probe = document.createElement('span');
        const peak = style.getPropertyValue('--agent-session-flow-peak').trim() || '16%';
        probe.style.color = `color-mix(in srgb, ${style.borderLeftColor} ${peak}, transparent)`;
        document.body.append(probe);
        const tint = getComputedStyle(probe).color;
        probe.remove();
        return {
          tint, peak,
          base: style.backgroundColor, ink: style.color, weight: style.fontWeight,
          muted: getComputedStyle(node.querySelector('.text-muted-foreground')).color,
          edge: style.borderLeftColor, width: style.borderLeftWidth,
          flow: flow.backgroundImage, animation: flow.animationName,
          outlineOffset: style.outlineOffset, shadow: style.boxShadow,
        };
      });
      for (const status of ['idle', 'running', 'awaiting', 'dormant', 'settled', 'ended']) {
        await page.evaluate(status => window.reparent(status), status);
        await page.mouse.move(1000, 5);
        const selected = await face();
        assert.notEqual(selected.flow, 'none');
        assert.match(selected.animation, /agent-session-rail-flow/);
        assert.equal(selected.width, '2px');
        assert.equal(selected.peak, mode === 'dark' && ['running', 'awaiting'].includes(status) ? '24%' : '16%');
        assert.ok(selected.flow.includes(selected.tint), `Selection uses its status edge hue: ${status}`);
        await cursor().hover();
        const hovered = await face();
        await page.evaluate(() => window.renderRail({ focusedId: 'other' }));
        const deselected = await face();
        for (const key of ['base', 'ink', 'weight', 'muted', 'edge']) {
          assert.equal(hovered[key], selected[key]);
          assert.equal(deselected[key], selected[key]);
        }
        assert.equal(deselected.flow, 'none');
        await page.evaluate(() => window.renderRail({ focusedId: 'a' }));
      }
      await page.evaluate(() => window.reparent('idle'));
      await cursor().focus();
      await page.keyboard.press('ArrowRight');
      const action = cursor().locator('..').locator('[data-sidebar="menu-action"]');
      await action.hover();
      await page.waitForFunction(() => document.querySelector('[data-cursor="true"]').hasAttribute('data-gloss-active'));
      assert.equal(await action.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
      assert.equal(await action.getAttribute('data-gloss-active'), null);
      assert.equal(await action.getAttribute('class').then(value => value.includes('cursor-gloss-transparent')), true);
      await page.keyboard.press('ArrowLeft');
      await focusedIs(cursor());
      assert.equal((await face()).outlineOffset, '-4px');
      assert.equal((await face()).shadow, 'none');
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const reduced = await face();
      assert.equal(reduced.animation, 'none');
      assert.notEqual(reduced.flow, 'none');
    });
  }

  it("does not treat the disclosure or a deliberately blurred row as rail ownership", async () => {
    await cursor().focus();
    const disclosure = page.locator('summary');
    await disclosure.focus();
    await page.evaluate(() => window.renderRail({ cursorId: 'b' }));
    await focusedIs(disclosure);
    await cursor().focus();
    await cursor().evaluate(element => element.blur());
    await page.evaluate(() => window.renderRail({ cursorId: 'a' }));
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true);
  });
});
