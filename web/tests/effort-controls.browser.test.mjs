// Real DOM interaction coverage for the three web Effort picker contexts.
// Run with an existing Playwright installation (no project dependency required):
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/effort-controls.browser.test.mjs
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { EffortPicker } from './web/src/components/model-picker.tsx';
      import { ConfiguredEffortSelect } from './web/src/components/effort-select.tsx';

      const supported = { id: 'reasoner', label: 'Reasoner', effortLevels: ['off', 'low', 'high', 'xhigh', 'max'] };
      const noControl = { id: 'plain', label: 'Plain' };
      const capabilities = { providers: ['test'], models: [supported, noControl], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false };
      function Harness() {
        const [composer, setComposer] = useState('high');
        const [saved, setSaved] = useState('max');
        const [workflow, setWorkflow] = useState('off');
        window.values = { composer, saved, workflow };
        return <main>
          <section aria-label="Agent Session composer">
            <EffortPicker capabilities={capabilities} model={supported} effort={composer} onSelect={setComposer} />
          </section>
          <section aria-label="Settings Default Effort">
            <ConfiguredEffortSelect ariaLabel="pi Default Effort" value={saved} levels={['low', 'medium', 'high']} allowUnset onChange={setSaved} />
          </section>
          <section aria-label="Workflow Effort">
            <ConfiguredEffortSelect ariaLabel="Workflow Effort" value={workflow} levels={['off', 'low', 'high']} onChange={setWorkflow} />
          </section>
          <section aria-label="No-control model">
            <EffortPicker capabilities={capabilities} model={noControl} effort={undefined} onSelect={() => {}} />
          </section>
          <section aria-label="Loading model">
            <EffortPicker capabilities={undefined} model={supported} effort={undefined} onSelect={() => {}} />
          </section>
        </main>;
      }
      createRoot(document.getElementById('root')).render(<Harness />);
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

describe("web Effort controls", () => {
  let browser;
  let page;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    page = await browser.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('main').waitFor();
  });

  it("constrains the Agent Session composer to complete confirmed levels", async () => {
    const section = page.getByRole('region', { name: 'Agent Session composer' });
    await section.getByRole('combobox', { name: 'Effort' }).click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['off', 'low', 'high', 'xhigh', 'max']);
    await page.getByRole('option', { name: 'max', exact: true }).click();
    assert.equal(await page.evaluate(() => window.values.composer), 'max');
  });

  it("shows an invalid saved Default Effort without making it selectable, then corrects explicitly", async () => {
    const control = page.getByRole('combobox', { name: 'pi Default Effort' });
    assert.equal(await control.getAttribute('aria-invalid'), 'true');
    await control.click();
    const invalid = page.getByRole('option', { name: 'max (saved — unsupported)' });
    assert.equal(await invalid.getAttribute('aria-disabled'), 'true');
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Use backend default', 'max (saved — unsupported)', 'low', 'medium', 'high']);
    await page.getByRole('option', { name: 'medium', exact: true }).click();
    assert.equal(await page.evaluate(() => window.values.saved), 'medium');
  });

  it("uses only the workflow model's restricted confirmed set", async () => {
    await page.getByRole('combobox', { name: 'Workflow Effort' }).click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['off', 'low', 'high']);
    await page.getByRole('option', { name: 'high', exact: true }).click();
    assert.equal(await page.evaluate(() => window.values.workflow), 'high');
  });

  it("hides confirmed no-control and disables unknown/loading without conflating them", async () => {
    assert.equal(await page.getByRole('region', { name: 'No-control model' }).getByRole('combobox').count(), 0);
    const loading = page.getByRole('region', { name: 'Loading model' }).getByRole('combobox', { name: 'Effort' });
    assert.equal(await loading.isDisabled(), true);
    assert.match(await loading.textContent(), /effort unavailable/);
  });
});
