// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/workflow-builder.browser.test.mjs
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
assert.ok(stylesheets.some(file => /^index-.*\.css$/.test(file)), 'The product stylesheet must be built before browser checks');
assert.ok(stylesheets.some(file => /^workflows-.*\.css$/.test(file)), 'The workflow stylesheet must be loaded for layout checks');
const bundle = await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import WorkflowsSettings from './web/src/components/settings-workflows.tsx';
    import { HostProvider } from './web/src/host.tsx';
    import { TooltipProvider } from './web/src/components/ui/tooltip.tsx';
    createRoot(document.getElementById('root')).render(<HostProvider><TooltipProvider>
      <main className="min-w-0 bg-background p-4 text-foreground"><WorkflowsSettings /></main>
    </TooltipProvider></HostProvider>);`, loader: 'tsx', resolveDir: root },
  tsconfig: `${root}/web/tsconfig.json`, bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'empty-agent-sessions', setup(build) {
    build.onLoad({ filter: /\/agent-sessions\.tsx$/ }, () => ({ contents: 'export function useAgentSessions() { return { sessions: [] }; }', loader: 'tsx' }));
  } }],
});
const original = { version: 1, id: 'example', name: 'Original workflow', backend: 'pi', permission: 'auto-accept', inputSchema: { type: 'object', fields: {} }, steps: [], edges: [] };
const other = { ...original, id: 'other', name: 'Other workflow' };

describe('workflow builder editor', () => {
  let browser, page, view, calls, saved, slowStop, rejectSend, rejectAbort, pageErrors, keyWarnings, mcpListGate;
  const input = () => page.getByRole('textbox', { name: 'Builder message', exact: true });
  const draftText = () => input().evaluate(element => [...element.querySelectorAll('.cm-line')].map(line => {
    const copy = line.cloneNode(true);
    copy.querySelectorAll('.cm-placeholder').forEach(placeholder => placeholder.remove());
    return copy.textContent;
  }).join('\n'));
  const conversation = () => page.getByRole('log', { name: 'Builder conversation' });
  const builder = () => page.getByRole('region', { name: 'Workflow builder agent' });
  const messageCalls = () => calls.filter(call => call.path.endsWith('/messages'));
  const deletions = () => calls.filter(call => call.method === 'DELETE' && call.path === '/api/workflow-builders/builder');
  const waitEditable = () => page.waitForFunction(() => document.querySelector('[aria-label="Builder message"]')?.getAttribute('contenteditable') === 'true');
  const waitPinned = () => page.waitForFunction(() => {
    const element = document.querySelector('[aria-label="Builder conversation"] .transcript-scroller');
    return element && element.scrollHeight > element.clientHeight && element.scrollHeight - element.scrollTop - element.clientHeight < 2;
  });
  const assertNoOverflow = async () => {
    const widths = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('.workflow-editor-pane, .workflow-builder-sidebar')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .map(element => ({ name: element.className, width: element.clientWidth, scroll: element.scrollWidth })));
    for (const width of widths) assert.ok(width.scroll <= width.width + 1, `Horizontal overflow: ${JSON.stringify(width)}`);
  };
  before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    calls = []; saved = undefined; view = undefined; slowStop = false; rejectSend = false; rejectAbort = false; pageErrors = []; keyWarnings = []; mcpListGate = undefined;
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.text().includes('same key')) keyWarnings.push(message.text()); });
    const mockAPI = async route => {
      const request = route.request(); const path = new URL(request.url()).pathname;
      const method = request.method();
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheets.map(file => `<link rel="stylesheet" href="/assets/${file}">`).join('')}</head><body><div id="root"></div></body></html>` });
      if (path.startsWith('/assets/')) return route.fulfill({ path: `${root}/web/dist${path}` });
      calls.push({ path, method, body: request.postData() ? request.postDataJSON() : undefined });
      let body;
      if (path === '/api/config') body = { scope: '/tmp/root', backends: ['pi'], providers: { defaultBackend: 'pi', defaults: { pi: 'reasoner' }, efforts: { pi: 'high' } } };
      else if (path === '/api/models') body = [{ backend: 'pi', models: [{ id: 'reasoner', label: 'Reasoner', effortLevels: ['off', 'high'], acceptsImages: true }] }];
      else if (path === '/api/workflows') body = { workflows: [saved ?? original, other] };
      else if (path === '/api/secrets') body = { names: [] };
      else if (path === '/api/workflow-mcp') body = { scope: '/tmp/root', connections: [{ id: 'local', name: 'Local tools', transport: 'stdio', enabledByDefault: true }] };
      else if (path === '/api/workflow-mcp/local') body = { tools: [{ connectionId: 'local', connectionName: 'Local tools', identity: 'a'.repeat(64), serverIdentity: 'b'.repeat(64), toolName: 'lookup', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } }], errors: [] };
      else if (path === '/api/workflows/example' && method === 'PUT') { saved = request.postDataJSON(); body = { workflow: saved }; }
      else if (path === '/api/workflow-builders' && method === 'POST') {
        view = { id: 'builder', scope: '/tmp/root', status: 'idle', definition: request.postDataJSON().definition, messages: [] }; body = view;
      } else if (path === '/api/workflow-builders/builder/messages') {
        if (rejectSend) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Builder send unavailable' }) });
        const text = request.postDataJSON().text;
        view = { ...view, status: text === 'Keep running' ? 'running' : 'idle', definition: { ...view.definition, name: 'Agent-built workflow', steps: [{ id: 'test', name: 'Tests', kind: 'shell', command: 'npm test' }] }, messages: [
          ...view.messages, { id: `user-${messageCalls().length}`, role: 'user', text }, { id: `reply-${messageCalls().length}`, role: 'assistant', text: 'Updated the workflow draft.' },
        ] }; body = view;
      } else if (path === '/api/workflow-builders/builder/abort') {
        if (rejectAbort) return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Builder stop unavailable' }) });
        view = { ...view, status: 'idle', stopping: slowStop }; body = view;
      }
      else if (path === '/api/workflow-builders/builder' && method === 'DELETE') body = { closed: true };
      else if (path === '/api/workflow-builders/builder') body = view;
      else return route.fulfill({ contentType: 'application/json', body: '{}' });
      if (path === '/api/workflow-mcp' && mcpListGate) await mcpListGate;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    };
    await page.route('https://flow.test/**', mockAPI);
    await page.goto('https://flow.test/', { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole('combobox', { name: 'Workflow definition' }).click();
    await page.getByRole('option', { name: 'Original workflow' }).click();
    await page.getByRole('button', { name: 'Build with agent' }).click();
    await builder().getByRole('combobox', { name: 'Effort', exact: true }).waitFor();
    await waitEditable();
    await page.evaluate(() => document.fonts.ready);
  });
  afterEach(async () => {
    try {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(keyWarnings, []);
      assert.equal(calls.some(call => /^\/api\/sessions(?:\/|$)/.test(call.path)), false, 'The builder must not issue Agent Session requests');
      assert.equal(calls.some(call => /\/(?:skills|attachments|branches)(?:\/|$)/.test(call.path)), false, 'The builder must not list Skills, Attachments, or branches');
    } finally { await page?.close(); }
  });
  const ask = async () => {
    await input().fill('Rename this workflow');
    await page.getByRole('button', { name: 'Send this message' }).click();
    await conversation().getByText('Updated the workflow draft.', { exact: true }).waitFor();
    await waitEditable();
  };
  for (const [theme, width] of [['light', 1440], ['dark', 1100], ['dark', 390]])
  it(`adds an MCP step and keeps one stable inspector in ${theme} mode at ${width}px`, async () => {
    await page.getByRole('button', { name: 'Hide builder agent', exact: true }).click();
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    let releaseMcp;
    mcpListGate = new Promise(resolve => { releaseMcp = resolve; });
    await page.getByRole('button', { name: 'Add MCP', exact: true }).click();
    const inspector = page.locator('.workflow-inspector');
    await inspector.getByRole('button', { name: 'Loading servers…', exact: true }).waitFor();
    await inspector.getByRole('textbox', { name: 'Name', exact: true }).fill('Lookup');
    assert.equal(await inspector.getByRole('combobox', { name: 'MCP server', exact: true }).count(), 1);
    releaseMcp();
    await inspector.getByText('Scope: /tmp/root', { exact: true }).waitFor();
    await inspector.getByRole('combobox', { name: 'MCP server', exact: true }).click();
    await page.getByRole('option', { name: 'Local tools · stdio', exact: true }).click();
    await inspector.getByRole('status').filter({ hasText: '1 compatible tool available.' }).waitFor();
    await inspector.getByRole('combobox', { name: 'MCP tool', exact: true }).click();
    await page.getByRole('option', { name: 'lookup', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[aria-label="MCP tool"]')?.getAttribute('aria-expanded') === 'false');
    await inspector.locator('[aria-label="Include Arguments.query"]').click();
    await inspector.getByRole('textbox', { name: 'Arguments.query', exact: true }).fill('Saved query');
    const height = await inspector.evaluate(element => element.scrollHeight);
    await page.waitForTimeout(6500);
    assert.equal(await inspector.count(), 1);
    assert.equal(await inspector.getByRole('combobox', { name: 'MCP server', exact: true }).count(), 1);
    assert.equal(await inspector.getByRole('textbox', { name: 'Arguments.query', exact: true }).inputValue(), 'Saved query');
    assert.equal(await inspector.evaluate(element => element.scrollHeight), height);
    assert.equal(calls.filter(call => call.path === '/api/workflow-mcp').length, 1);
    await assertNoOverflow();
    if (width >= 1024) {
      await page.locator('.workflow-canvas .react-flow__pane').click({ position: { x: 20, y: 20 } });
      await inspector.getByText('Select a step to edit its settings.', { exact: true }).waitFor();
      assert.equal(await page.locator('.react-flow__node.selected').count(), 0);
    } else {
      await inspector.getByRole('button', { name: 'Back to workflow graph', exact: true }).click();
    }
    await page.locator('.workflow-step').filter({ hasText: 'Lookup' }).click();
    await inspector.getByRole('textbox', { name: 'Arguments.query', exact: true }).waitFor();
    assert.equal(await inspector.getByRole('textbox', { name: 'Arguments.query', exact: true }).inputValue(), 'Saved query');
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(saved.steps[0].tool.toolName, 'lookup');
    assert.equal(saved.steps[0].mapping.template.fields.query.value, 'Saved query');
  });
  it('uses selected model/Effort, applies explicitly, and saves through the normal editor', async () => {
    await ask();
    const creation = calls.find(call => call.path === '/api/workflow-builders');
    assert.equal(creation.body.modelId, 'reasoner'); assert.equal(creation.body.effort, 'high');
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Original workflow');
    assert.equal(saved, undefined);
    assert.equal(await builder().getByRole('combobox', { name: 'Effort', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: 'Apply draft to editor' }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Agent-built workflow');
    assert.equal(saved, undefined);
    await page.getByRole('button', { name: 'Save workflow', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
    assert.equal(saved.name, 'Agent-built workflow');
    assert.equal(deletions().length, 1);
  });
  it('stops an active builder with the bounded API request and enables the composer again', async () => {
    await input().fill('Keep running');
    await page.getByRole('button', { name: 'Send this message' }).click();
    await page.getByRole('button', { name: 'Stop builder', exact: true }).waitFor();
    assert.equal(await input().isEditable(), false);
    await page.getByRole('button', { name: 'Stop builder', exact: true }).click();
    await waitEditable();
    assert.deepEqual(calls.find(call => call.path.endsWith('/abort')).body, {});
  });
  it('reports a failed Stop without settling the turn or an unhandled rejection, then permits retry', async () => {
    await input().fill('Keep running');
    await page.getByRole('button', { name: 'Send this message' }).click();
    rejectAbort = true;
    await page.getByRole('button', { name: 'Stop builder', exact: true }).click();
    await builder().getByRole('alert').filter({ hasText: 'Builder stop unavailable' }).waitFor();
    assert.equal(view.status, 'running');
    assert.equal(await input().isEditable(), false);
    assert.equal(await page.getByRole('button', { name: 'Stop builder', exact: true }).isEnabled(), true);
    rejectAbort = false;
    await page.getByRole('button', { name: 'Stop builder', exact: true }).click();
    await waitEditable();
  });
  it('keeps the composer and Apply disabled until slow retirement actually finishes', async () => {
    slowStop = true;
    await input().fill('Keep running');
    await page.getByRole('button', { name: 'Send this message' }).click();
    await page.getByRole('button', { name: 'Stop builder', exact: true }).click();
    const stopping = page.getByRole('button', { name: 'Stopping builder…', exact: true });
    await stopping.waitFor();
    assert.equal(await input().isEditable(), false);
    assert.equal(await page.getByRole('button', { name: 'Apply draft to editor' }).isDisabled(), true);
    assert.equal(await stopping.isDisabled(), true);
    const aborts = calls.filter(call => call.path.endsWith('/abort')).length;
    await input().press('Enter');
    assert.equal(calls.filter(call => call.path.endsWith('/abort')).length, aborts);
    assert.equal(messageCalls().length, 1);
    view = { ...view, stopping: false };
    await waitEditable();
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
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/workflow-builders/builder') && response.request().method() === 'DELETE'),
      page.getByRole('button', { name: 'New workflow', exact: true }).click(),
    ]);
    assert.equal(await builder().count(), 0);
    assert.equal(deletions().length, 1);
  });
  it('uses native CodeMirror Enter to send and Shift+Enter to keep a multiline draft', async () => {
    assert.equal(await input().evaluate(element => element.tagName), 'DIV');
    assert.equal(await builder().locator('textarea').count(), 0);
    await input().click();
    await page.keyboard.type('First line');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Second line');
    assert.equal(await draftText(), 'First line\nSecond line');
    assert.equal(messageCalls().length, 0);
    await page.keyboard.press('Enter');
    await conversation().getByText('Updated the workflow draft.', { exact: true }).waitFor();
    await waitEditable();
    assert.deepEqual(messageCalls().map(call => call.body), [{ text: 'First line\nSecond line' }]);
    assert.equal(await draftText(), '');
  });
  it('restores the draft after an HTTP send failure and retries without creating another builder', async () => {
    await ask();
    rejectSend = true;
    await input().fill('Keep this draft');
    await input().press('Enter');
    await builder().getByRole('alert').filter({ hasText: 'Builder send unavailable' }).waitFor();
    await waitEditable();
    assert.equal(await draftText(), 'Keep this draft');
    assert.equal(await conversation().locator('.transcript-scroller').getByText('Keep this draft', { exact: true }).count(), 0);
    rejectSend = false;
    await input().press('Enter');
    await conversation().locator('.transcript-scroller').getByText('Keep this draft', { exact: true }).waitFor();
    await waitEditable();
    assert.equal(await draftText(), '');
    assert.equal(calls.filter(call => call.path === '/api/workflow-builders' && call.method === 'POST').length, 1);
    assert.deepEqual(messageCalls().slice(-2).map(call => call.body), [{ text: 'Keep this draft' }, { text: 'Keep this draft' }]);
  });
  it('omits branch/permission controls, Skills and Attachments, and sends command text only to the builder', async () => {
    assert.equal(await builder().getByRole('combobox', { name: /branch|permission/i }).count(), 0);
    assert.equal(await builder().getByRole('button', { name: /attach|skill|permission|branch/i }).count(), 0);
    assert.equal(await builder().locator('input[type="file"]').count(), 0);
    await input().fill('/compact keep the workflow');
    assert.equal(await builder().getByRole('listbox').count(), 0);
    await input().evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.items.add(new File(['image'], 'draft.png', { type: 'image/png' }));
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }));
    });
    assert.equal(await builder().getByRole('img').count(), 0);
    await input().press('Enter');
    await conversation().getByText('/compact keep the workflow', { exact: true }).waitFor();
    await waitEditable();
    assert.deepEqual(messageCalls().map(call => call.body), [{ text: '/compact keep the workflow' }]);
  });
  for (const theme of ['light', 'dark']) {
    it(`keeps the builder beside the editor with no horizontal overflow in ${theme} mode`, async () => {
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      await ask();
      for (const width of [1440, 1050]) {
        await page.setViewportSize({ width, height: 1000 });
        const editor = await page.getByRole('region', { name: 'Workflow editor', exact: true }).boundingBox();
        const sidebar = await page.getByRole('complementary', { name: 'Workflow builder sidebar' }).boundingBox();
        assert.ok(editor && sidebar);
        assert.ok(sidebar.x >= editor.x + editor.width, 'The builder must sit beside, not below, the editor');
        assert.ok(Math.abs(sidebar.y - editor.y) < 1);
        assert.ok(editor.width > 250 && sidebar.width >= 350);
        assert.ok(sidebar.height >= 480 && sidebar.height <= 1000);
        await assertNoOverflow();
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole('group', { name: 'Workflow view' }).waitFor();
      await input().waitFor();
      assert.equal(await page.getByRole('region', { name: 'Workflow editor', exact: true }).isVisible(), false);
      await assertNoOverflow();
      await page.getByRole('button', { name: 'Editor', exact: true }).click();
      await page.getByRole('region', { name: 'Workflow editor', exact: true }).waitFor();
      await assertNoOverflow();
    });
  }
  it('keeps the mounted builder and unsent draft across mobile tabs, then deletes only on Close', async () => {
    await ask();
    await input().fill('Unsent builder draft');
    await page.evaluate(() => { window.builderElement = document.querySelector('[aria-label="Workflow builder agent"]'); });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('group', { name: 'Workflow view' }).waitFor();
    for (let index = 0; index < 2; index++) {
      await page.getByRole('button', { name: 'Editor', exact: true }).click();
      await builder().waitFor({ state: 'hidden' });
      assert.equal(deletions().length, 0);
      await page.getByRole('button', { name: 'Builder', exact: true }).click();
      await input().waitFor();
      assert.equal(await draftText(), 'Unsent builder draft');
      assert.equal(await page.evaluate(() => window.builderElement === document.querySelector('[aria-label="Workflow builder agent"]')), true);
      assert.equal(await conversation().getByText('Updated the workflow draft.', { exact: true }).count(), 1);
    }
    assert.equal(calls.filter(call => call.path === '/api/workflow-builders' && call.method === 'POST').length, 1);
    assert.equal(deletions().length, 0);
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/workflow-builders/builder') && response.request().method() === 'DELETE'),
      page.getByRole('button', { name: 'Close builder' }).click(),
    ]);
    assert.equal(await builder().count(), 0);
    assert.equal(deletions().length, 1);
    assert.equal(await page.getByRole('region', { name: 'Workflow editor', exact: true }).isVisible(), true);
  });
  it('deletes the hidden mobile builder when selecting another Workflow Definition', async () => {
    await ask();
    await input().fill('Do not retain this conversation');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Editor', exact: true }).click();
    await builder().waitFor({ state: 'hidden' });
    assert.equal(deletions().length, 0);
    await page.getByRole('combobox', { name: 'Workflow definition' }).click();
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/workflow-builders/builder') && response.request().method() === 'DELETE'),
      page.getByRole('option', { name: 'Other workflow' }).click(),
    ]);
    assert.equal(await builder().count(), 0);
    assert.equal(deletions().length, 1);
    assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Other workflow');
  });
  it('uses the shared transcript scroller, follows output only while pinned, and reserves composer space', async () => {
    await ask();
    const scroller = conversation().locator('.transcript-scroller');
    assert.equal(await scroller.count(), 1);
    assert.equal(await scroller.evaluate(element => getComputedStyle(element).overflowY), 'auto');
    const append = text => { view = { ...view, messages: [...view.messages, { id: `extra-${view.messages.length}`, role: 'assistant', text }] }; };
    for (let index = 0; index < 45; index++) append(`Long response ${index}.\n\n${'Workflow details. '.repeat(15)}`);
    await conversation().getByText(/^Long response 44\./).waitFor();
    await waitPinned();
    const initialHeight = await scroller.evaluate(element => element.scrollHeight);
    append('Pinned new response.\n\n' + 'Additional workflow details. '.repeat(20));
    await conversation().getByText(/^Pinned new response\./).waitFor();
    await waitPinned();
    assert.ok(await scroller.evaluate(element => element.scrollHeight) > initialHeight);
    await scroller.evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event('scroll')); });
    await page.getByRole('button', { name: 'Jump to latest' }).waitFor();
    const readerTop = await scroller.evaluate(element => element.scrollTop);
    append('Unpinned new response.\n\n' + 'More workflow details. '.repeat(20));
    await conversation().getByText(/^Unpinned new response\./).waitFor();
    assert.ok(Math.abs(await scroller.evaluate(element => element.scrollTop) - readerTop) < 2, 'New output must not move the reader away from earlier entries');
    await page.getByRole('button', { name: 'Jump to latest' }).click();
    await waitPinned();
    assert.equal(await page.getByRole('button', { name: 'Jump to latest' }).count(), 0);
    const inset = await conversation().evaluate(element => Number.parseFloat(element.style.getPropertyValue('--composer-inset')));
    const padding = await scroller.evaluate(element => Number.parseFloat(getComputedStyle(element).paddingBottom));
    assert.ok(inset > 0 && padding > inset, 'The shared composer must reserve transcript space');
    const last = await conversation().getByText(/^Unpinned new response\./).boundingBox();
    const composer = await input().boundingBox();
    assert.ok(last && composer && last.y + last.height <= composer.y, 'The last response must not be hidden behind the composer');
    await assertNoOverflow();
  });
});
