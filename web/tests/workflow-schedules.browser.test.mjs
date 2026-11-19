// PLAYWRIGHT_MODULE=/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs node --test web/tests/workflow-schedules.browser.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { before, after, beforeEach, afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../../', import.meta.url));
execFileSync(process.execPath, [`${root}/scripts/build-web.mjs`], { cwd: root, timeout: 120000, stdio: 'pipe' });
const assets = new Map(await Promise.all((await readdir(`${root}/web/dist/assets`)).map(async file => [file, await readFile(`${root}/web/dist/assets/${file}`)])));
const stylesheets = [...assets.keys()].filter(file => file.endsWith('.css'));
const stubs = {
  'agent-sessions.tsx': `const sessions = [{ id: 'existing', name: 'Existing work', backend: 'pi', status: 'idle', activeSubagents: 0, activeBackgroundCalls: 0 }]; export function useAgentSessions() { return { sessions, loaded: true }; } export function useCommand() { return async () => {}; }`,
  'agent-session-view.tsx': `export function useAgentSessionChrome() { return undefined; }`,
  'components/agent-session-pane.tsx': `export function AgentSessionPane() { return <h1>Existing Agent Session</h1>; }`,
  'components/agent-session-nav.tsx': `export function AgentSessionNav({onNew, onSchedules}) { return <nav><button onClick={onNew}>New Agent Session</button><button onClick={onSchedules}>Schedules</button></nav>; }`,
  'components/new-agent-session-page.tsx': `export function NewAgentSessionPage() { return <h1>New Agent Session form</h1>; }`,
  'components/settings-dialog.tsx': `export function SettingsDialog() { return null; }`,
};
const bundle = await build({
  stdin: { contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AppShell } from './web/src/components/app-shell.tsx';
    import WorkflowsPane from './web/src/components/workflows-pane.tsx';
    import { HostProvider } from './web/src/host.tsx';
    import { TooltipProvider } from './web/src/components/ui/tooltip.tsx';
    createRoot(document.getElementById('root')).render(<HostProvider><TooltipProvider>{location.search.includes('manual') ? <WorkflowsPane sessionId="existing" /> : <AppShell />}</TooltipProvider></HostProvider>);`, loader: 'tsx', resolveDir: root },
  tsconfig: `${root}/web/tsconfig.json`, bundle: true, write: false, format: 'iife', platform: 'browser',
  loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"development"' },
  plugins: [{ name: 'session-fixtures', setup(build) {
    build.onLoad({ filter: /\/web\/src\/.*\.tsx$/ }, args => {
      const stub = stubs[args.path.split('/web/src/')[1]];
      if (stub) return { contents: stub, loader: 'tsx' };
    });
  } }],
});
const schema = { type: 'object', fields: {} };
const definition = { version: 1, id: 'check', name: 'Saved check', backend: 'pi', permission: 'ask', inputSchema: schema, steps: [{ id: 'call', name: 'Call check', kind: 'workflow', workflowId: 'child', contract: { inputSchema: schema, outputSchema: schema } }], edges: [] };
const child = { ...definition, id: 'child', name: 'Called check', steps: [{ id: 'work', name: 'Inspect work', kind: 'agent', model: 'reasoner', effort: 'high', instructions: 'Inspect', outputSchema: schema }] };
const attempt = { number: 1, action: 'execute', startedAt: 1000, finishedAt: 2000, input: { original: true }, partialOutput: { diagnostic: 'retained output' }, error: { kind: 'failure', message: 'Retained failure' }, loops: [{ headerId: 'work', activation: 1, try: 3 }] };
const execution = { version: 1, sessionId: 'existing', id: 'execution', scope: '/project', definition, input: { retained: 'launch' }, startedAt: 1000, status: 'recovery-required', steps: { call: { status: 'failed', attempts: [attempt] } }, loops: { call: { phase: 'limit', activation: 1, try: 3, grants: [] } }, retainedDefinitions: { child }, invocations: { nested: { id: 'nested', definitionId: 'child', callStepId: 'call', callAttempt: 1, status: 'recovery-required', startedAt: 1000, input: { called: true }, steps: { work: { status: 'failed', attempts: [attempt, { ...attempt, number: 2, action: 'retry' }] } } } } };
const spend = { costUSD: 0.25, tokens: 42, cached: 0, models: [] };
const enquiries = [{ invocationId: 'nested', stepId: 'work', subagentId: 'worker', askId: 'ask', questions: [] }];
const permissions = [{ invocationId: 'nested', stepId: 'work', subagentId: 'worker', callId: 'tool', tool: 'Read' }];
const view = { execution, historyComplete: true, enquiries, permissions, spend, stepSpend: {}, activity: [] };
const nestedView = { ...view, execution: { ...execution, ...execution.invocations.nested, id: execution.id, definition: child }, stepSpend: { work: spend }, invocationId: 'nested' };
const initial = { version: 1, id: 'one', name: 'Original schedule', workflowId: 'check', input: {}, projectId: '/project', mcpConnectionIds: [], timing: { kind: 'interval', value: 5, unit: 'minutes' }, concurrency: 3, activation: 1, revision: 1, enabled: true, nextDue: 300000, createdAt: 0, updatedAt: 0 };

describe('workflow schedules', () => {
  let browser, page, current, calls, pending, defer, errors;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    current = structuredClone(initial); calls = []; pending = []; defer = false; errors = [];
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://flow.test/**', async route => {
      const request = route.request(); const url = new URL(request.url()); const path = url.pathname; const method = request.method();
      if (path === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${stylesheets.map(file => `<link rel="stylesheet" href="/assets/${file}">`).join('')}</head><body class="bg-background text-foreground"><div id="root" style="height:100vh"></div></body></html>` });
      if (path.startsWith('/assets/')) return route.fulfill({ body: assets.get(path.slice('/assets/'.length)), contentType: path.endsWith('.css') ? 'text/css' : 'font/woff2' });
      const body = request.postData() ? request.postDataJSON() : undefined;
      calls.push({ path, method, body, query: url.search });
      const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
      if (defer && method !== 'GET' && path !== '/api/workflow-schedules/preview') {
        pending.push({ reply, body, path }); return;
      }
      if (path === '/api/config') return reply({ scope: '/project', backends: ['pi'], projectList: [{ path: '/project', name: 'Project' }], mcp: [{ id: 'tools', name: 'Tools' }] });
      if (path === '/api/workflows') return reply({ workflows: [definition] });
      if (path === '/api/workflow-schedules/preview') return reply({ nextDue: 600000 });
      if (path.endsWith('/history') || path === '/api/workflow-occurrences') return reply({ occurrences: [] });
      if (path === '/api/workflow-schedules') return reply({ schedules: [current], cleanupWarnings: [] });
      if (path === '/api/workflow-schedules/one') {
        if (method === 'PUT') {
          if (body.revision !== current.revision) return reply({ error: 'Schedule revision conflict. Reload before saving.' }, 409);
          current = { ...current, ...body.settings, enabled: body.enabled, revision: current.revision + 1 };
        }
        return reply({ schedule: current });
      }
      if (path.endsWith('/activity')) return reply({ activity: [{ invocationId: 'nested', stepId: 'work', attempt: 1, sequence: 1, at: 2000, subagentId: 'worker', event: { type: 'message', id: 'message', text: 'Retained attempt transcript', final: true } }], historyComplete: true });
      if (path.endsWith('/execution') || path.endsWith('/workflows/execution')) return reply(url.searchParams.has('invocationId') ? nestedView : view);
      if (path === '/api/sessions/existing/workflows') return reply({ occupied: true, executions: [{ id: execution.id, name: 'Saved check', status: execution.status, startedAt: 1000 }] });
      if (path === '/api/workflow-occurrences/occurrence') return reply({ occurrence: { id: 'occurrence', revision: 1, settings: initial, status: 'recovery-required', scheduledAt: 1000, executionId: 'execution', association: 'attached', sessionId: 'existing' } });
      return reply({});
    });
  });
  afterEach(async () => { try { assert.deepEqual(errors, []); } finally { await page?.close(); } });
  const open = async (hash = '#/schedules/one', search = '') => {
    await page.goto(`https://flow.test/${search}${hash}`, { waitUntil: 'domcontentloaded' });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
  };
  const waitPending = () => page.waitForFunction(() => document.querySelector('button') !== null).then(async () => {
    for (let i = 0; i < 100 && !pending.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(pending.length, 1);
  });
  it('does not auto-open an existing Agent Session after leaving a schedules bookmark', async () => {
    await open('#/schedules');
    await page.getByRole('heading', { name: 'Schedules', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New Agent Session', exact: true }).click();
    await page.getByRole('heading', { name: 'New Agent Session form' }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await page.getByRole('heading', { name: 'Existing Agent Session' }).count(), 0);
  });
  for (const action of ['save', 'pause', 'delete']) for (const destination of ['new form', 'Agent Session']) it(`ignores a late ${action} response after opening ${destination}`, async () => {
    await open();
    await page.getByRole('button', { name: 'Edit', exact: true }).waitFor();
    defer = true;
    if (action === 'save') {
      await page.getByRole('button', { name: 'Edit', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Old editor');
      await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
    } else if (action === 'pause') await page.getByRole('button', { name: 'Pause', exact: true }).click();
    else {
      await page.getByRole('button', { name: 'Delete', exact: true }).click();
      await page.getByRole('alertdialog').getByRole('button', { name: 'Delete schedule', exact: true }).click();
    }
    await waitPending();
    if (destination === 'new form') {
      await page.getByRole('button', { name: 'New schedule', exact: true }).click();
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Keep this form');
    } else await page.getByRole('button', { name: 'New Agent Session', exact: true }).click();
    await pending[0].reply({ schedule: { ...initial, id: 'saved' } });
    await page.waitForTimeout(100);
    if (destination === 'new form') assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue(), 'Keep this form');
    else await page.getByRole('heading', { name: 'New Agent Session form' }).waitFor();
    assert.equal(new URL(page.url()).hash, destination === 'new form' ? '#/schedules/one' : '');
  });
  it('keeps the original editor revision after polling sees a pause', async () => {
    await open();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    current = { ...initial, enabled: false, revision: 2, nextDue: undefined };
    await page.waitForTimeout(3200);
    await page.getByRole('button', { name: 'Save schedule', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Schedule revision conflict' }).waitFor();
    const save = calls.find(call => call.method === 'PUT');
    assert.equal(save.body.revision, 1);
    assert.equal(save.body.enabled, true);
    assert.equal(current.enabled, false);
  });
  for (const manual of [false, true]) it(`uses the full read-only inspector for ${manual ? 'manual' : 'scheduled'} work`, async () => {
    await open('#/schedules/occurrences/occurrence', manual ? '?manual' : '');
    const inspector = page.getByRole('region', { name: 'Workflow execution inspection' });
    await inspector.getByText('Question · pending', { exact: false }).waitFor();
    await inspector.getByText('Permission · Read · pending', { exact: false }).waitFor();
    await inspector.getByText('Spend: $0.2500 · 42 tokens', { exact: true }).waitFor();
    await inspector.getByText('Call check: Try 3 of 3 · Loop limit reached', { exact: true }).waitFor();
    assert.equal(await inspector.getByRole('button', { name: /Cancel|parent chat|Agent Session/ }).count(), 0);
    await inspector.getByRole('button', { name: 'Call check · Called check', exact: true }).first().click();
    await inspector.getByText('Called check · awaiting input', { exact: true }).waitFor();
    await inspector.locator('.react-flow__node').filter({ hasText: 'Inspect work' }).click();
    await inspector.getByText('Model: reasoner · Effort: high', { exact: true }).waitFor();
    await inspector.getByRole('combobox', { name: 'Attempt', exact: true }).click();
    await page.getByRole('option', { name: 'Attempt 1 · execute · failed', exact: true }).click();
    await inspector.getByText('Loop · Inspect work · Try 3 · Activation 1', { exact: true }).waitFor();
    await inspector.getByRole('region', { name: 'Step transcript' }).getByText('Retained attempt transcript', { exact: true }).waitFor();
    assert.ok(calls.some(call => call.path.endsWith('/activity') && call.query.includes('invocationId=nested') && call.query.includes('attempt=1')));
  });
  for (const [theme, width] of [['light', 1440], ['dark', 1100], ['dark', 390]]) it(`uses shared controls without overflow in ${theme} at ${width}px`, async () => {
    await page.setViewportSize({ width, height: 1100 });
    await open();
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), theme === 'dark');
    await page.getByRole('button', { name: 'New schedule', exact: true }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('New schedule');
    await page.getByRole('combobox', { name: 'Workflow', exact: true }).click();
    await page.getByRole('option', { name: 'Saved check', exact: true }).click();
    await page.getByRole('combobox', { name: 'Recurrence', exact: true }).click();
    await page.getByRole('option', { name: 'Daily (local civil time)', exact: true }).click();
    await page.getByRole('switch', { name: 'Enabled (never runs immediately)', exact: true }).click();
    assert.equal(await page.locator('select').count(), 0);
    assert.equal(await page.getByRole('switch').count(), 3);
    assert.equal(await page.getByRole('checkbox').count(), 0);
    const widths = await page.getByRole('main', { name: 'Workflow schedules' }).evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(widths.scroll <= widths.width + 1, JSON.stringify(widths));
    const colors = await page.getByRole('textbox', { name: 'Name', exact: true }).evaluate(element => ({ text: getComputedStyle(element).color, surface: getComputedStyle(element).backgroundColor }));
    assert.notEqual(colors.text, colors.surface);
  });
});
