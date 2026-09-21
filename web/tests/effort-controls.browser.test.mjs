// Real DOM interaction coverage for the three web Effort picker contexts.
// Run with an existing Playwright installation (no project dependency required):
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/effort-controls.browser.test.mjs
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
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
      import { ProvidersSettings } from './web/src/components/settings-providers.tsx';
      import { HostProvider } from './web/src/host.tsx';

      const supported = { id: 'reasoner', label: 'Reasoner', effortLevels: ['off', 'low', 'high', 'xhigh', 'max'] };
      const noControl = { id: 'plain', label: 'Plain' };
      const capabilities = { providers: ['test'], models: [supported, noControl], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false };
      function Harness() {
        const [composer, setComposer] = useState('high');
        const [saved, setSaved] = useState('max');
        const [workflow, setWorkflow] = useState('off');
        window.values = { composer, saved, workflow };
        return <main aria-label="Effort control fixtures">
          <section aria-label="Agent Session composer">
            <EffortPicker capabilities={capabilities} model={supported} effort={composer} onSelect={setComposer} />
          </section>
          <section aria-label="Settings Default Effort">
            <ConfiguredEffortSelect ariaLabel="fixture Default Effort" value={saved} levels={['low', 'medium', 'high']} allowUnset onChange={setSaved} />
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
      createRoot(document.getElementById('root')).render(<>
        <Harness />
        <HostProvider>
          <section aria-label="Provider Settings">
            <ProvidersSettings />
          </section>
        </HostProvider>
      </>);
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
  let savedSettings;
  let resolveSavedSettings;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    savedSettings = new Promise((resolve) => { resolveSavedSettings = resolve; });
    page = await browser.newPage();
    await page.route('http://flow.test/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/') {
        await route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      } else if (url.pathname === '/api/config' && request.method() === 'GET') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({
            scope: '/tmp/project',
            backends: ['pi'],
            providers: {
              defaultBackend: 'pi',
              defaults: { pi: 'full' },
              efforts: { pi: 'high' },
            },
          }),
        });
      } else if (url.pathname === '/api/config' && request.method() === 'PUT') {
        const patch = request.postDataJSON();
        resolveSavedSettings(patch);
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ providers: patch.providers }),
        });
      } else if (url.pathname === '/api/models') {
        await route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify([{
            backend: 'pi',
            models: [
              { id: 'full', provider: 'test', label: 'Full', effortLevels: ['low', 'medium', 'high'] },
              { id: 'restricted', provider: 'test', label: 'Restricted', effortLevels: ['low'] },
              { id: 'plain', provider: 'test', label: 'Plain' },
            ],
          }]),
        });
      } else {
        await route.abort();
      }
    });
    await page.goto('http://flow.test/');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('main', { name: 'Effort control fixtures' }).waitFor();
  });
  afterEach(async () => { await page?.close(); });

  it("constrains the Agent Session composer to complete confirmed levels", async () => {
    const section = page.getByRole('region', { name: 'Agent Session composer' });
    await section.getByRole('combobox', { name: 'Effort' }).click();
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['off', 'low', 'high', 'xhigh', 'max']);
    await page.getByRole('option', { name: 'max', exact: true }).click();
    assert.equal(await page.evaluate(() => window.values.composer), 'max');
  });

  it("shows an invalid saved Default Effort without making it selectable, then corrects explicitly", async () => {
    const control = page.getByRole('combobox', { name: 'fixture Default Effort' });
    assert.equal(await control.getAttribute('aria-invalid'), 'true');
    await control.click();
    const invalid = page.getByRole('option', { name: 'max (saved — unsupported)' });
    assert.equal(await invalid.getAttribute('aria-disabled'), 'true');
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Use backend default', 'max (saved — unsupported)', 'low', 'medium', 'high']);
    await page.getByRole('option', { name: 'medium', exact: true }).click();
    assert.equal(await page.evaluate(() => window.values.saved), 'medium');
  });

  it("preserves Default Effort when Provider Settings switches to a restricted model", async () => {
    const settings = page.getByRole('region', { name: 'Provider Settings' });
    const card = settings.locator('details').filter({ hasText: 'Pi' });
    await card.locator('summary').click();
    const effort = card.getByRole('combobox', { name: 'pi Default Effort' });
    await effort.waitFor();
    assert.match(await effort.textContent(), /high/);

    await card.getByRole('combobox', { name: 'pi Default Model' }).click();
    await page.getByRole('option', { name: 'test / Restricted' }).click();

    assert.match(await effort.textContent(), /high/);
    assert.equal(await effort.getAttribute('aria-invalid'), 'true');
    await card.getByText('Saved Effort “high” is not confirmed for this model. Choose a supported level or use the backend default.').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.equal(await card.getByRole('button', { name: 'Discard', exact: true }).isEnabled(), true);

    await effort.click();
    const invalid = page.getByRole('option', { name: 'high (saved — unsupported)' });
    assert.equal(await invalid.getAttribute('aria-disabled'), 'true');
    assert.deepEqual(await page.getByRole('option').allTextContents(), ['Use backend default', 'high (saved — unsupported)', 'low']);
    await page.getByRole('option', { name: 'low', exact: true }).click();
    const save = card.getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    assert.equal((await savedSettings).providers.efforts.pi, 'low');
  });

  it("preserves Default Effort when Provider Settings switches to a no-control model", async () => {
    const settings = page.getByRole('region', { name: 'Provider Settings' });
    const card = settings.locator('details').filter({ hasText: 'Pi' });
    await card.locator('summary').click();
    await card.getByRole('combobox', { name: 'pi Default Effort' }).waitFor();

    await card.getByRole('combobox', { name: 'pi Default Model' }).click();
    await page.getByRole('option', { name: 'test / Plain' }).click();

    assert.equal(await card.getByRole('combobox', { name: 'pi Default Effort' }).count(), 0);
    await card.getByText('high (saved — unsupported)', { exact: true }).waitFor();
    await card.getByText('Saved Effort “high” is invalid because this model has no Effort control. Use the backend default.').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.equal(await card.getByRole('button', { name: 'Discard', exact: true }).isEnabled(), true);

    await card.getByRole('button', { name: 'Use backend default', exact: true }).click();
    await card.getByText('This model has no Effort control.').waitFor();
    const save = card.getByRole('button', { name: 'Save', exact: true });
    assert.equal(await save.isEnabled(), true);
    await save.click();
    assert.equal((await savedSettings).providers.efforts.pi, '');
  });

  it("uses only the workflow model's restricted confirmed set", async () => {
    await page.getByRole('combobox', { name: 'Workflow Effort' }).click();
    await page.getByRole('option', { name: 'high', exact: true }).waitFor();
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
