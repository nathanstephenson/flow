// PLAYWRIGHT_MODULE=/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs node --test web/tests/workflow-builder.browser.test.mjs
import assert from 'node:assert/strict';
import { before, after, beforeEach, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
const bundle = await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import WorkflowsSettings from './web/src/components/settings-workflows.tsx';
    import { HostProvider } from './web/src/host.tsx';
    createRoot(document.getElementById('root')).render(<HostProvider><WorkflowsSettings /></HostProvider>);`, loader: 'tsx', resolveDir: root },
  tsconfig: `${root}/web/tsconfig.json`, bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
});
const original = { version: 1, id: 'example', name: 'Original workflow', backend: 'pi', permission: 'auto-accept', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] };

describe('workflow builder editor', () => {
  let browser, page, view, calls, saved, slowStop;
  before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    calls = []; saved = undefined; view = undefined; slowStop = false;
    page = await browser.newPage();
    await page.route('http://flow.test/**', async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' });
      calls.push({ path, method, body: request.postData() ? request.postDataJSON() : undefined });
      let body;
      if (path === '/api/config') body = { scope: '/tmp/root', backends: ['pi'], providers: { defaultBackend: 'pi', defaults: { pi: 'reasoner' }, efforts: { pi: 'high' } } };
      else if (path === '/api/models') body = [{ backend: 'pi', models: [{ id: 'reasoner', label: 'Reasoner', effortLevels: ['off', 'high'] }] }];
      else if (path === '/api/workflows') body = { workflows: [saved ?? original] };
      else if (path === '/api/secrets') body = { names: [] };
      else if (path === '/api/workflows/example' && method === 'PUT') { saved = request.postDataJSON(); body = { workflow: saved }; }
      else if (path === '/api/workflow-builders' && method === 'POST') {
        view = { id: 'builder', scope: '/tmp/root', status: 'idle', definition: request.postDataJSON().definition, messages: [] }; body = view;
      } else if (path === '/api/workflow-builders/builder/messages') {
        view = { ...view, status: request.postDataJSON().text === 'Keep running' ? 'running' : 'idle', definition: { ...view.definition, name: 'Agent-built workflow', steps: [{ id: 'test', name: 'Tests', kind: 'shell', command: 'npm test' }] }, messages: [
          { id: 'user', role: 'user', text: request.postDataJSON().text }, { id: 'reply', role: 'assistant', text: 'Updated the workflow draft.' },
        ] }; body = view;
      } else if (path === '/api/workflow-builders/builder/abort') { view = { ...view, status: 'idle', stopping: slowStop }; body = view; }
      else if (path === '/api/workflow-builders/builder' && method === 'DELETE') body = { closed: true };
      else if (path === '/api/workflow-builders/builder') body = view;
      else return route.fulfill({ contentType: 'application/json', body: '{}' });
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('http://flow.test/', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('combobox', { name: 'Workflow definition' }).click();
    await page.getByRole('option', { name: 'Original workflow' }).click();
    await page.getByRole('button', { name: 'Build with agent' }).click();
    await page.getByRole('combobox', { name: 'Builder Effort' }).waitFor();
  });
  afterEach(async () => { await page?.close(); });
  const ask = async () => {
    await page.getByRole('textbox', { name: 'Builder message' }).fill('Rename this workflow');
    await page.getByRole('button', { name: 'Send to builder' }).click();
    await page.getByRole('log', { name: 'Builder conversation' }).getByText('Updated the workflow draft.').waitFor();
  };
  it('uses selected model/Effort, applies explicitly, and saves through the normal editor', async () => {
    await ask();
    const creation = calls.find(call => call.path === '/api/workflow-builders');
    assert.equal(creation.body.modelId, 'reasoner'); assert.equal(creation.body.effort, 'high');
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Original workflow');
    assert.equal(saved, undefined);
    await page.getByRole('button', { name: 'Apply draft to editor' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Agent-built workflow');
    assert.equal(saved, undefined);
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(saved.name, 'Agent-built workflow');
    assert.ok(calls.some(call => call.path === '/api/workflow-builders/builder' && call.method === 'DELETE'));
  });
  it('stops an active builder with the bounded API request and enables the composer again', async () => {
    await page.getByRole('textbox', { name: 'Builder message' }).fill('Keep running');
    await page.getByRole('button', { name: 'Send to builder' }).click();
    await page.getByRole('button', { name: 'Stop builder' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Builder message' }).isDisabled(), true);
    await page.getByRole('button', { name: 'Stop builder' }).click();
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Builder message"]').disabled);
    assert.deepEqual(calls.find(call => call.path.endsWith('/abort')).body, {});
  });
  it('keeps the composer and Apply disabled until slow retirement actually finishes', async () => {
    slowStop = true;
    await page.getByRole('textbox', { name: 'Builder message' }).fill('Keep running');
    await page.getByRole('button', { name: 'Send to builder' }).click();
    await page.getByRole('button', { name: 'Stop builder' }).click();
    await page.getByRole('button', { name: 'Stopping…', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Builder message' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Apply draft to editor' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Stop builder' }).isDisabled(), true);
    view = { ...view, stopping: false };
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="Builder message"]').disabled);
    assert.equal(await page.getByRole('button', { name: 'Apply draft to editor' }).isDisabled(), false);
  });
  it('does not overwrite newer visual edits with an older builder draft', async () => {
    await ask();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Human edit');
    assert.equal(await page.getByRole('button', { name: 'Apply draft to editor' }).isDisabled(), true);
    await page.getByRole('alert').filter({ hasText: 'The editor changed' }).waitFor();
    await page.getByRole('button', { name: 'Close builder' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Human edit');
  });
  it('cleans up when switching definitions or leaving the builder', async () => {
    await ask();
    await page.getByRole('button', { name: 'New workflow', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Workflow builder agent' }).count(), 0);
    assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/api/workflow-builders/builder'));
  });
});
