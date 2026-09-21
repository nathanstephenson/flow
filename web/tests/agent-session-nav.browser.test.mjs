// Real DOM coverage: node's presentation tests cannot model focus loss during React mutations.
// Run with an existing Playwright installation (no project dependency required):
// PLAYWRIGHT_MODULE=/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs \
//   node --test web/tests/agent-session-nav.browser.test.mjs
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { AgentSessionNav } from './web/src/components/agent-session-nav.tsx';
      import { SidebarProvider } from './web/src/components/ui/sidebar.tsx';
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
        flushSync(() => root.render(<React.StrictMode><SidebarProvider>
          <AgentSessionNav {...props} />
          <input aria-label="Composer" />
        </SidebarProvider></React.StrictMode>));
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
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});

describe("Agent Session rail DOM focus", () => {
  let browser;
  let page;
  const cursor = () => page.locator('[data-cursor="true"]');
  const focusedIs = async (locator) => assert.equal(
    await locator.evaluate(element => document.activeElement === element), true,
  );
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
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

  it("restores a focused row after group reparenting, including Filed away", async () => {
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
