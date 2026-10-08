// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/workflow-mcp-authoring.browser.test.mjs
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
assert.ok(stylesheets.some(file => /^index-.*\.css$/.test(file)));
assert.ok(stylesheets.some(file => /^workflows-.*\.css$/.test(file)));
const bundle = await build({
  stdin: { contents: `import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { McpStepEditor } from './web/src/components/workflow-mcp.tsx';
    import { HostProvider } from './web/src/host.tsx';
    import { TooltipProvider } from './web/src/components/ui/tooltip.tsx';
    function App() {
      const [definition, setDefinition] = useState(window.initialDefinition);
      const [mounted, setMounted] = useState(true);
      window.currentDefinition = definition;
      window.setDefinition = setDefinition;
      window.setMounted = setMounted;
      return <main className="min-w-0 bg-background p-4 text-foreground">
        {mounted && <McpStepEditor definition={definition} step={definition.steps[0]}
          onChange={step => setDefinition(current => ({ ...current, steps: [step] }))} />}
      </main>;
    }
    createRoot(document.getElementById('root')).render(<HostProvider><TooltipProvider><App /></TooltipProvider></HostProvider>);`, loader: 'tsx', resolveDir: root },
  tsconfig: `${root}/web/tsconfig.json`, bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
});
const tool = {
  connectionId: 'local', connectionName: 'Local tools', identity: 'a'.repeat(64), serverIdentity: 'b'.repeat(64), toolName: 'lookup',
  inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Search text' } }, required: ['query'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { found: { type: 'boolean' } }, required: ['found'] },
};
const remoteTool = { ...tool, connectionId: 'remote', connectionName: 'Remote tools', toolName: 'remote_lookup' };
const initialDefinition = {
  version: 1, id: 'example', name: 'Workflow', projectId: 'alpha', backend: 'pi', permission: 'ask',
  inputSchema: { type: 'object', fields: {} }, edges: [],
  steps: [{ id: 'lookup', name: 'Lookup', kind: 'mcp', tool: { connectionId: '', connectionName: '', identity: '', serverIdentity: '', toolName: 'unselected', inputSchema: { type: 'object' } }, mapping: { kind: 'template', template: { kind: 'object', fields: {} } } }],
};
const servers = [
  { id: 'local', name: 'Local tools', transport: 'stdio', enabledByDefault: false },
  { id: 'remote', name: 'Remote tools', transport: 'http', enabledByDefault: true },
];
const diagnostic = { toolName: 'broken', message: 'output schema: unknown format "custom-format" ignored in schema at path "#/properties/result"' };

describe('MCP workflow authoring without an Agent Session', () => {
  let browser, page, calls, responses, held, pageErrors, failedRequests;
  const serverPicker = () => page.getByRole('combobox', { name: 'MCP server', exact: true });
  const toolPicker = () => page.getByRole('combobox', { name: 'MCP tool', exact: true });
  const discoveryCalls = () => calls.filter(call => call.path.startsWith('/api/workflow-mcp/'));
  const currentStep = () => page.evaluate(() => window.currentDefinition.steps[0]);
  const selectServer = async name => {
    await serverPicker().click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  const selectTool = async name => {
    await toolPicker().click();
    await page.getByRole('option', { name, exact: true }).click();
  };
  const mount = async (definition = initialDefinition, ignoreAbort = false) => {
    await page.goto('https://flow.test/', { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ definition, ignoreAbort }) => {
      window.initialDefinition = definition;
      const originalFetch = window.fetch.bind(window);
      window.fetch = (input, options) => originalFetch(input, ignoreAbort ? { ...options, signal: undefined } : options);
    }, { definition, ignoreAbort });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await serverPicker().waitFor();
  };
  const changeScope = async projectId => {
    await page.evaluate(projectId => window.setDefinition(current => ({ ...current, projectId })), projectId);
  };
  const hold = key => {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    held.set(key, promise);
    return release;
  };
  before(async () => { browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    calls = []; held = new Map(); pageErrors = []; failedRequests = [];
    responses = new Map([
      ['/api/workflow-mcp?projectId=alpha', { scope: '/tmp/alpha', connections: servers }],
      ['/api/workflow-mcp?projectId=beta', { scope: '/tmp/beta', connections: servers }],
      ['/api/workflow-mcp', { scope: '/tmp/root', connections: servers }],
      ['/api/workflow-mcp/local?projectId=alpha', { tools: [tool], errors: [] }],
      ['/api/workflow-mcp/local?projectId=beta', { tools: [{ ...tool, toolName: 'beta_lookup' }], errors: [] }],
      ['/api/workflow-mcp/remote?projectId=alpha', { tools: [remoteTool], errors: [] }],
    ]);
    page = await browser.newPage({ viewport: { width: 900, height: 1000 } });
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('requestfailed', request => failedRequests.push(new URL(request.url()).pathname));
    await page.route('https://flow.test/**', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheets.map(file => `<link rel="stylesheet" href="/assets/${file}">`).join('')}</head><body><div id="root"></div></body></html>` });
      if (url.pathname.startsWith('/assets/')) return route.fulfill({ path: `${root}/web/dist${url.pathname}` });
      const key = url.pathname + url.search;
      calls.push({ path: url.pathname, key, method: request.method() });
      url.searchParams.delete('refresh');
      const lookup = url.pathname + url.search;
      let body = url.pathname === '/api/config' ? { scope: '/tmp/root', backends: ['pi'] } : responses.get(lookup);
      const status = body?.error ? 503 : body ? 200 : 404;
      if (held.has(lookup)) await held.get(lookup);
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body ?? { error: `Unexpected API: ${key}` }) }).catch(() => {});
    });
  });
  afterEach(async () => {
    try {
      assert.deepEqual(pageErrors, []);
      assert.equal(calls.some(call => /^\/api\/sessions(?:\/|$)/.test(call.path)), false, 'No Agent Session API is used');
      assert.ok(calls.every(call => call.method === 'GET'), 'Discovery must not call execution APIs');
      assert.ok(calls.every(call => call.path === '/api/config' || call.path.startsWith('/api/workflow-mcp')), 'Only authoring metadata APIs are used');
    } finally { await page?.close(); }
  });

  it('lists all configured servers on mount, including disabled defaults, and discovers on selection', async () => {
    await mount();
    await page.getByText('Scope: /tmp/alpha', { exact: true }).waitFor();
    assert.equal(discoveryCalls().length, 0);
    assert.equal(await page.getByRole('combobox', { name: /Agent Session/ }).count(), 0);
    await serverPicker().click();
    assert.equal(await page.getByRole('option', { name: 'Local tools · stdio', exact: true }).isVisible(), true);
    assert.equal(await page.getByRole('option', { name: 'Remote tools · http', exact: true }).isVisible(), true);
    await page.getByRole('option', { name: 'Local tools · stdio', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '1 compatible tool available.' }).waitFor();
    assert.deepEqual(discoveryCalls().map(call => call.key), ['/api/workflow-mcp/local?projectId=alpha']);
    assert.equal((await currentStep()).tool.toolName, 'unselected');
    await page.getByText(/Execution and step testing require this connection/).waitFor();
    await page.getByText(/Metadata discovery can start a local stdio server/).waitFor();
  });

  it('pins the exact snapshot on selection, resets arguments, and preserves it through refreshed server drift', async () => {
    responses.set('/api/workflow-mcp/local?projectId=alpha', { tools: [tool], errors: [diagnostic] });
    await mount();
    await selectServer('Local tools · stdio');
    await page.getByRole('status').filter({ hasText: '1 compatible tool available. 1 incompatible tool cannot be selected.' }).waitFor();
    await page.getByText('broken · incompatible', { exact: true }).click();
    await page.getByText(diagnostic.message, { exact: true }).waitFor();
    await toolPicker().click();
    assert.equal(await page.getByRole('option', { name: 'broken', exact: true }).count(), 0);
    await page.getByRole('option', { name: 'lookup', exact: true }).click();
    assert.deepEqual((await currentStep()).tool, tool);
    assert.deepEqual((await currentStep()).mapping, { kind: 'template', template: { kind: 'object', fields: {} } });
    await page.locator('[aria-label="Include Arguments.query"]').click();
    await page.getByRole('textbox', { name: 'Arguments.query', exact: true }).fill('Find this');
    assert.deepEqual((await currentStep()).mapping, { kind: 'template', template: { kind: 'object', fields: { query: { kind: 'literal', value: 'Find this' } } } });
    const pinned = await currentStep();
    const changed = { ...tool, identity: 'c'.repeat(64), inputSchema: { ...tool.inputSchema, default: { query: 'new default' } } };
    responses.set('/api/workflow-mcp/local?projectId=alpha', { tools: [changed], errors: [] });
    await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '1 compatible tool available.' }).waitFor();
    assert.deepEqual(await currentStep(), pinned);
    await selectTool('lookup');
    assert.deepEqual((await currentStep()).tool, changed);
    assert.equal((await currentStep()).mapping.template.fields.query.value, 'new default');
  });

  it('restores the pinned server on mount without changing the saved snapshot or mapping', async () => {
    const pinnedStep = { ...initialDefinition.steps[0], tool, mapping: { kind: 'template', template: { kind: 'object', fields: { query: { kind: 'literal', value: 'Saved query' } } } } };
    await mount({ ...initialDefinition, steps: [pinnedStep] });
    await page.getByRole('status').filter({ hasText: '1 compatible tool available.' }).waitFor();
    assert.equal(await serverPicker().innerText(), 'Local tools');
    assert.deepEqual(await currentStep(), pinnedStep);
    assert.equal(await page.getByRole('textbox', { name: 'Arguments.query', exact: true }).inputValue(), 'Saved query');
  });

  it('shows list failures without automatic retry, permits Retry, and reports an empty configuration', async () => {
    responses.set('/api/workflow-mcp?projectId=alpha', { error: 'Scope is unavailable' });
    await mount();
    await page.getByRole('alert').filter({ hasText: 'Scope is unavailable' }).waitFor();
    assert.equal(await serverPicker().isDisabled(), true);
    await page.waitForTimeout(3200);
    assert.equal(calls.filter(call => call.key === '/api/workflow-mcp?projectId=alpha').length, 1);
    responses.set('/api/workflow-mcp?projectId=alpha', { scope: '/tmp/alpha', connections: [] });
    await page.getByRole('button', { name: 'Retry servers', exact: true }).click();
    await page.getByText('No MCP servers configured. Add a connection in MCP Settings.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(discoveryCalls().length, 0);
  });

  it('shows discovery failures without automatic retry and distinguishes incompatible tools from no tools', async () => {
    responses.set('/api/workflow-mcp/local?projectId=alpha', { error: 'MCP service unavailable' });
    await mount();
    await selectServer('Local tools · stdio');
    await page.getByRole('alert').filter({ hasText: 'MCP service unavailable' }).waitFor();
    assert.equal(await toolPicker().isDisabled(), true);
    await page.waitForTimeout(3200);
    assert.equal(discoveryCalls().length, 1);
    responses.set('/api/workflow-mcp/local?projectId=alpha', { tools: [], errors: [diagnostic] });
    await page.getByRole('button', { name: 'Retry discovery', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'No compatible tools. All 1 discovered tool is incompatible.' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await toolPicker().isDisabled(), true);
    responses.set('/api/workflow-mcp/local?projectId=alpha', { tools: [], errors: [] });
    await page.getByRole('button', { name: 'Refresh tools', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'This server reported no tools.' }).waitFor();
    assert.equal(await page.getByRole('region', { name: 'Incompatible MCP tools' }).count(), 0);
  });

  it('rejects late discovery after a server change even when the transport ignores AbortSignal', async () => {
    responses.set('/api/workflow-mcp/local?projectId=alpha', { tools: [tool], errors: [diagnostic] });
    const release = hold('/api/workflow-mcp/local?projectId=alpha');
    await mount(initialDefinition, true);
    await selectServer('Local tools · stdio');
    await page.getByRole('button', { name: 'Discovering…', exact: true }).waitFor();
    await selectServer('Remote tools · http');
    await page.getByRole('status').filter({ hasText: '1 compatible tool available.' }).waitFor();
    release();
    await page.waitForResponse(response => response.url().includes('/api/workflow-mcp/local?'));
    await toolPicker().click();
    assert.equal(await page.getByRole('option', { name: 'lookup', exact: true }).count(), 0);
    await page.getByRole('option', { name: 'remote_lookup', exact: true }).click();
    assert.deepEqual((await currentStep()).tool, remoteTool);
    assert.equal(await page.getByText('broken · incompatible', { exact: true }).count(), 0);
  });

  it('clears Scope results and rejects old discovery without changing the pinned tool', async () => {
    const pinnedStep = { ...initialDefinition.steps[0], tool };
    const release = hold('/api/workflow-mcp/local?projectId=alpha');
    await mount({ ...initialDefinition, steps: [pinnedStep] }, true);
    await page.getByRole('button', { name: 'Discovering…', exact: true }).waitFor();
    await changeScope('beta');
    await page.getByText('Scope: /tmp/beta', { exact: true }).waitFor();
    assert.equal(await toolPicker().isDisabled(), true);
    assert.equal(await serverPicker().innerText(), 'Select configured MCP server');
    await selectServer('Local tools · stdio');
    await page.getByRole('status').filter({ hasText: '1 compatible tool available.' }).waitFor();
    release();
    await page.waitForResponse(response => response.url().includes('/api/workflow-mcp/local?projectId=alpha'));
    await toolPicker().click();
    assert.equal(await page.getByRole('option', { name: 'lookup', exact: true }).count(), 0);
    await page.getByRole('option', { name: 'beta_lookup', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.deepEqual(await currentStep(), pinnedStep);
  });

  it('rejects a late server list after Scope changes and uses the default Scope when no Project is selected', async () => {
    const release = hold('/api/workflow-mcp?projectId=alpha');
    await mount(initialDefinition, true);
    await changeScope('beta');
    await page.getByText('Scope: /tmp/beta', { exact: true }).waitFor();
    release();
    await page.waitForResponse(response => response.url().endsWith('/api/workflow-mcp?projectId=alpha'));
    assert.equal(await page.getByText('Scope: /tmp/alpha', { exact: true }).count(), 0);
    await changeScope(undefined);
    await page.getByText('Scope: /tmp/root', { exact: true }).waitFor();
    assert.ok(calls.some(call => call.key === '/api/workflow-mcp'));
  });

  it('aborts pending network discovery when the inspector unmounts', async () => {
    const release = hold('/api/workflow-mcp/local?projectId=alpha');
    await mount();
    await selectServer('Local tools · stdio');
    await page.getByRole('button', { name: 'Discovering…', exact: true }).waitFor();
    await page.evaluate(() => window.setMounted(false));
    await page.waitForFunction(() => !document.querySelector('[aria-label="MCP server"]'));
    await page.waitForTimeout(100);
    assert.ok(failedRequests.includes('/api/workflow-mcp/local'));
    release();
  });

  for (const theme of ['light', 'dark']) {
    it(`uses existing controls without horizontal overflow in ${theme} mode`, async () => {
      responses.set('/api/workflow-mcp/local?projectId=alpha', { tools: [tool], errors: [diagnostic] });
      await mount();
      await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
      await selectServer('Local tools · stdio');
      await page.getByRole('status').filter({ hasText: '1 compatible tool available.' }).waitFor();
      await page.getByText('broken · incompatible', { exact: true }).click();
      await selectTool('lookup');
      await page.evaluate(() => document.fonts.ready);
      for (const width of [900, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const widths = await page.evaluate(() => [document.documentElement, ...document.querySelectorAll('main, fieldset')].map(element => ({ width: element.clientWidth, scroll: element.scrollWidth })));
        for (const size of widths) assert.ok(size.scroll <= size.width + 1, `Horizontal overflow: ${JSON.stringify(size)}`);
      }
      assert.ok(await serverPicker().getAttribute('data-slot'));
      assert.ok(await toolPicker().getAttribute('data-slot'));
    });
  }
});
