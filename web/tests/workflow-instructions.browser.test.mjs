// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/workflow-instructions.browser.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { before, after, beforeEach, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
execFileSync(process.execPath, [`${root}/scripts/build-web.mjs`], { cwd: root, timeout: 120000, stdio: 'pipe' });
const stylesheets = (await readdir(`${root}/web/dist/assets`)).filter(file => file.endsWith('.css'));
const bundle = await build({
  stdin: { contents: `import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { WorkflowInstructions } from './web/src/components/workflow-instructions.tsx';
    import { HostProvider } from './web/src/host.tsx';
    function App() {
      const [value, setValue] = useState('');
      return <main className="bg-background p-4 text-foreground">
        <WorkflowInstructions value={value} project={window.project} backend="pi" onChange={setValue} />
      </main>;
    }
    createRoot(document.getElementById('root')).render(<HostProvider><App /></HostProvider>);`, loader: 'tsx', resolveDir: root },
  tsconfig: `${root}/web/tsconfig.json`, bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
});
const skills = {
  '/tmp/root': [{ name: 'global-skill', description: 'Global' }],
  '/tmp/alpha': [{ name: 'alpha-skill', description: 'Alpha' }],
};

describe('Workflow Instructions Skill menu', () => {
  let browser, page, skillCalls, pageErrors;
  const mount = async project => {
    await page.goto('https://flow.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(project => { window.project = project; }, project);
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('textbox', { name: 'Instructions' }).waitFor();
  };
  const openMenu = async () => {
    await page.getByRole('textbox', { name: 'Instructions' }).click();
    await page.keyboard.type('/');
  };
  before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    skillCalls = []; pageErrors = [];
    page = await browser.newPage();
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('https://flow.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>${stylesheets.map(file => `<link rel="stylesheet" href="/assets/${file}">`).join('')}</head><body><div id="root"></div></body></html>` });
      if (url.pathname.startsWith('/assets/')) return route.fulfill({ path: `${root}/web/dist${url.pathname}` });
      if (url.pathname === '/api/config') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ scope: '/tmp/root', backends: ['pi'] }) });
      if (url.pathname === '/api/skills') {
        const scope = url.searchParams.get('scope');
        skillCalls.push(scope);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ backend: 'pi', scope, skills: skills[scope] ?? [] }) });
      }
      return route.fulfill({ status: 404, body: '{}' });
    });
  });
  afterEach(async () => {
    try { assert.deepEqual(pageErrors, []); } finally { await page?.close(); }
  });

  it('offers Skills from the Default Scope when the Workflow has no Project', async () => {
    await mount(undefined);
    await openMenu();
    await page.getByRole('option', { name: /global-skill/ }).waitFor();
    assert.deepEqual([...new Set(skillCalls)], ['/tmp/root']);
  });

  it('offers Skills from the Project when the Workflow has one', async () => {
    await mount('/tmp/alpha');
    await openMenu();
    await page.getByRole('option', { name: /alpha-skill/ }).waitFor();
    assert.deepEqual([...new Set(skillCalls)], ['/tmp/alpha']);
  });
});
