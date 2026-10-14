// PLAYWRIGHT_MODULE=/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs node --test web/tests/git-tabs.browser.test.mjs
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { build as viteBuild } from 'vite';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { GitPane } from './web/src/components/git-pane.tsx';
      createRoot(document.getElementById('root')).render(
        <main className="bg-background p-4 text-foreground">
          <button data-reference="active" className="bg-muted text-foreground">Active reference</button>
          <button data-reference="inactive" className="text-muted-foreground hover:bg-muted/50">Inactive reference</button>
          <input aria-label="Composer" />
          <GitPane sessionId="git-tabs" />
        </main>
      );
    `,
    resolveDir: root,
    loader: 'tsx',
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  outfile: 'git-tabs-fixture.js',
  write: false,
  format: 'iife',
  platform: 'browser',
  define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{
    name: 'git-tabs-fixture',
    setup(build) {
      build.onLoad({ filter: /\/host\.tsx$/ }, () => ({
        contents: `
          const connection = {
            async command() {
              return { repository: true, branch: { name: 'feature', detached: false }, files: [] };
            },
          };
          export function useHost() { return { connection }; }
        `,
        loader: 'tsx',
      }));
      for (const [file, component] of [['stack-pane', 'StackPane'], ['pull-request-pane', 'PullRequestPane']]) {
        build.onLoad({ filter: new RegExp('/' + file + '\\.tsx$') }, () => ({
          contents: `
            import React, { useEffect } from 'react';
            export function ${component}({ onAvailable }) {
              useEffect(() => { onAvailable(true); }, [onAvailable]);
              return <p>${component}</p>;
            }
          `,
          loader: 'tsx',
          resolveDir: `${root}/web/src/components`,
        }));
      }
    },
  }],
});
const styles = await viteBuild({
  configFile: `${root}/web/vite.config.ts`,
  logLevel: 'silent',
  build: { write: false, rollupOptions: { input: `${root}/web/src/index.css` } },
});
const themeCSS = styles.output.filter(file => file.type === 'asset' && file.fileName.endsWith('.css'))
  .map(file => file.source).join('\n');

const face = locator => locator.evaluate(async element => {
  await Promise.all(element.getAnimations().map(animation => animation.finished));
  const style = getComputedStyle(element);
  return {
    background: style.backgroundColor,
    color: style.color,
    shadow: (style.boxShadow.match(/-?[\d.]+px/g) ?? []).some(length => parseFloat(length) !== 0),
    outline: style.outlineStyle,
  };
});

describe('GitPane tab selection material', () => {
  let browser;
  let page;
  before(async () => {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROMIUM_PATH ?? process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    page.setDefaultTimeout(10000);
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({ content: themeCSS });
    await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
    await page.getByRole('tab', { name: 'Stack', exact: true }).waitFor();
    await page.getByRole('tab', { name: 'PR', exact: true }).waitFor();
  });
  afterEach(async () => { await page?.close(); });

  for (const mode of ['light', 'dark']) {
    it(`${mode}: matches parent tabs through selection and hover`, async () => {
      await page.evaluate(mode => document.documentElement.classList.toggle('dark', mode === 'dark'), mode);
      const list = page.getByRole('tablist', { name: 'Git views' });
      const tab = name => list.getByRole('tab', { name, exact: true });
      const composer = page.getByRole('textbox', { name: 'Composer' });
      const activeReference = page.locator('[data-reference="active"]');
      const inactiveReference = page.locator('[data-reference="inactive"]');
      const active = await face(activeReference);
      const inactive = await face(inactiveReference);
      assert.notEqual(active.background, 'rgba(0, 0, 0, 0)');
      assert.notEqual(active.color, inactive.color);

      for (const selected of ['Diff', 'Stack', 'PR', 'Diff']) {
        await tab(selected).click();
        await composer.focus();
        await composer.hover();
        assert.equal((await face(list)).background, 'rgba(0, 0, 0, 0)');
        for (const name of ['Diff', 'Stack', 'PR']) {
          assert.equal(await tab(name).getAttribute('aria-selected'), String(name === selected));
          assert.equal(await page.getByRole('tabpanel', { name, exact: true }).isVisible(), name === selected);
          const style = await face(tab(name));
          assert.equal(style.background, name === selected ? active.background : 'rgba(0, 0, 0, 0)');
          assert.equal(style.color, name === selected ? active.color : inactive.color);
          if (name === selected) {
            assert.equal(style.shadow, false);
            assert.equal(style.outline, 'none');
          }
        }
        await tab(selected).hover();
        const hoveredActive = await face(tab(selected));
        assert.equal(hoveredActive.background, active.background);
        assert.equal(hoveredActive.color, active.color);
        assert.equal(hoveredActive.shadow, false);
        await inactiveReference.hover();
        const hoveredReference = await face(inactiveReference);
        assert.notEqual(hoveredReference.background, inactive.background);
        const other = selected === 'Diff' ? 'Stack' : 'Diff';
        await tab(other).hover();
        assert.equal((await face(tab(other))).background, hoveredReference.background);
        assert.equal(await tab(selected).getAttribute('aria-selected'), 'true');
        await composer.focus();
        await page.keyboard.press('Tab');
        assert.equal(await tab(selected).evaluate(element => element.matches(':focus-visible')), true);
        assert.equal((await face(tab(selected))).shadow, true);
      }
    });
  }
});
