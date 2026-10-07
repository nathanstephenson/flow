// Exercise the production client on scripts/visual-fixture-host.ts. Never starts a
// host/build, changes host Settings, sends a turn, or uses operator state.
// FLOW_STATE_DIR=/tmp/<fixture> [FLOW_WEB_URL=http://127.0.0.1:<port>]
// [SCREENSHOT_DIR=/tmp/<captures>] node scripts/check-visual-alignment.mjs
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

assert.ok(process.env.FLOW_STATE_DIR, 'FLOW_STATE_DIR must name the isolated visual fixture');
const root = await realpath(resolve(process.env.FLOW_STATE_DIR));
assert.ok(root.startsWith('/tmp/'), 'Only isolated /tmp state is allowed');
const daemon = JSON.parse(await readFile(join(root, 'daemon.json'), 'utf8'));
const token = (await readFile(join(root, 'token'), 'utf8')).trim();
const { ids, settledId } = JSON.parse(await readFile(join(root, 'study.json'), 'utf8'));
assert.ok(ids?.length === 5 && settledId, 'study.json must come from visual-fixture-host.ts');
assert.equal(daemon.token, token, 'Token and daemon descriptor must belong to the same fixture');
const url = new URL(process.env.FLOW_WEB_URL ?? daemon.url);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Only loopback fixture URLs are allowed');
assert.equal(url.protocol, 'http:');
const out = process.env.SCREENSHOT_DIR ? resolve(process.env.SCREENSHOT_DIR) : undefined;
if (out) {
  assert.ok(out.startsWith('/tmp/'), 'Screenshots/reports must stay under /tmp');
  await mkdir(out, { recursive: true });
  assert.ok((await realpath(out)).startsWith('/tmp/'), 'Screenshot directory must not symlink outside /tmp');
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH, args: ['--no-sandbox'] });
const report = { root, url: url.origin, checks: [], screenshots: [], errors: [], mutations: [], httpErrors: [], measurements: [] };
const failures = [];
const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
// Count observer construction without installing an observer or adding DOM.
// Native popup lifecycle observers are allowed; pointer-only gloss must not
// start a discovery/mutation-observer renderer on every frame.
await context.addInitScript(() => {
  const NativeObserver = window.MutationObserver;
  let observers = 0;
  window.MutationObserver = new Proxy(NativeObserver, {
    construct(target, args, newTarget) { observers++; return Reflect.construct(target, args, newTarget); },
  });
  Object.defineProperty(window, '__visualObserverCount', { get: () => observers });
});
await context.addInitScript(id => localStorage.setItem('flow.docks', JSON.stringify({
  [id]: { bottom: { tabs: [], size: 300, minimised: true }, right: {
    tabs: [{ id: 'git', content: { kind: 'git' } }, { id: 'agents', content: { kind: 'subagents' } }],
    activeId: 'git', size: 380, minimised: false,
  } },
})), ids[0]);
function observePage(page) {
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.errors.push(message.text()); });
  page.on('response', response => {
    if (response.status() >= 400) report.httpErrors.push(`${response.status()} ${new URL(response.url()).pathname}`);
  });
}
let page = await context.newPage(); observePage(page);

// A deny-by-default write guard is installed BEFORE authentication or UI mounts.
// Even an accidental autosave/acknowledgement is a failure, not a mock success.
const readOnlyCommands = new Set(['list', 'git_status', 'stack_status', 'pull_request', 'list_skills']);
await context.route('**/*', async route => {
  const request = route.request(), address = new URL(request.url()), method = request.method();
  const safeOrigin = address.origin === url.origin;
  let allowed = safeOrigin && ['GET', 'HEAD', 'OPTIONS'].includes(method) && !/\/(?:oauth|logout)(?:\/|$)/.test(address.pathname);
  if (safeOrigin && address.pathname === '/api/command' && method === 'POST') {
    try { allowed = readOnlyCommands.has(request.postDataJSON()?.type); } catch { allowed = false; }
  }
  if (!allowed) {
    report.mutations.push(`${method} ${address.pathname} ${request.postData() ?? ''}`);
    return route.abort('blockedbyclient');
  }
  if (address.pathname === '/api/command' && method === 'POST') {
    const command = request.postDataJSON();
    if (command.type === 'stack_status') return route.fulfill({ json: { result: {
      available: false, conflicts: [], rebasing: false,
      graph: { currentBranch: 'rail-refinement', trunk: 'main', branches: [{ name: 'rail-refinement', parent: 'main', isCurrent: true, availability: 'local' }], explicit: true },
    } } });
    if (command.type === 'pull_request') return route.fulfill({ json: { result: {
      repo: 'example/fixture', id: 'visual-fixture', number: 1, url: 'https://github.com/example/fixture/pull/1',
      title: 'Read-only visual fixture', isDraft: false, body: 'Browser-local discovery fixture', state: 'CLOSED',
      author: 'Fixture', headRefName: 'rail-refinement', baseRefName: 'main', createdAt: '', updatedAt: '',
      mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', viewerCanComment: false,
      comments: [], reviews: [], threads: [], reviewDecision: '', statusCheckRollup: [],
    } } });
  }
  // Browser-local GET discovery only: the fake host has no curated Projects,
  // model catalogue or MCP Settings. Native controls still render in web/dist.
  if (method === 'GET' && address.pathname === '/api/config') {
    const response = await route.fetch();
    assert.ok(response.ok(), 'Fixture config must be readable');
    const config = await response.json();
    assert.deepEqual(config.backends, ['fake'], 'Do not run against an operator Session Host');
    return route.fulfill({ response, json: {
      ...config,
      projectList: config.projectList?.length ? config.projectList : [
        { path: join(root, 'workspace', 'flow'), name: 'Visual fixture' },
        { path: join(root, 'workspace', 'fixture-1', 'flow'), name: 'Adapter fixture' },
      ],
      mcp: config.mcp?.length ? config.mcp : [
        { id: 'visual-readonly-a', name: 'Visual tools A', transport: 'stdio', command: 'never-execute-visual-fixture', args: [], enabledByDefault: true },
        { id: 'visual-readonly-b', name: 'Visual tools B', transport: 'stdio', command: 'never-execute-visual-fixture', args: [], enabledByDefault: false },
      ],
    } });
  }
  // Optional services are deliberately absent from the inert fixture host.
  if (method === 'GET' && address.pathname === '/api/shells') return route.fulfill({ json: [] });
  if (method === 'GET' && address.pathname === '/api/workflows') return route.fulfill({ json: { workflows: [] } });
  if (method === 'GET' && address.pathname === '/api/update') return route.fulfill({ json: {
    installedVersion: 'fixture', updateAvailable: false,
    eligibility: { state: 'unsupported', reason: 'Read-only visual fixture' },
  } });
  if (method === 'GET' && address.pathname === '/api/models') {
    return route.fulfill({ json: [{ backend: 'fake', models: [
      { id: 'visual-readonly-a', label: 'Visual model A', provider: 'Fixture', effortLevels: ['low', 'medium', 'high'] },
      { id: 'visual-readonly-b', label: 'Visual model B', provider: 'Fixture', effortLevels: ['low', 'medium', 'high'] },
    ] }] });
  }
  return route.continue();
});

async function check(label, action) {
  try { await action(); report.checks.push({ label, passed: true }); }
  catch (error) {
    failures.push(`${label}: ${error.stack ?? error}`);
    report.checks.push({ label, passed: false, error: error.message });
    // Escape outside a popup is the Agent Session Abort shortcut. Never use
    // it as generic test cleanup, even with the deny-by-default write guard.
    const popups = page.locator('[data-slot="select-content"], [data-slot="combobox-content"], [data-slot="dropdown-menu-content"]').filter({ visible: true });
    if (await popups.count()) await page.keyboard.press('Escape').catch(() => {});
  }
}
async function frames() {
  await page.evaluate(async () => { await document.fonts.ready; for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame); });
}
async function theme(name) {
  await page.emulateMedia({ colorScheme: name, reducedMotion: 'no-preference' });
  await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), name === 'dark');
  await frames();
}
async function capture(name) {
  if (!out) return;
  const path = join(out, `${name}.png`);
  await page.screenshot({ path }); report.screenshots.push(path);
}
async function navigate(hash) {
  await page.evaluate(hash => { location.hash = hash; }, hash);
}
const rows = () => page.locator('[data-sidebar="menu-button"]');
const titles = ['Refine the session rail', 'Review the adapter contract', 'Polish keyboard navigation', 'Inspect workflow retries', 'Confirm migration'];
const rowFor = index => rows().filter({ hasText: titles[index] });
async function surface(locator, pseudo) {
  return locator.evaluate((node, pseudo) => {
    const css = getComputedStyle(node, pseudo), box = node.getBoundingClientRect();
    return { fill: css.backgroundColor, image: css.backgroundImage, ink: css.color,
      radius: [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomRightRadius, css.borderBottomLeftRadius],
      shadow: css.boxShadow, border: css.borderLeftColor, borderWidth: css.borderLeftWidth,
      animation: css.animationName, duration: css.animationDuration, opacity: css.opacity,
      pointerEvents: css.pointerEvents, content: css.content,
      x: box.x, y: box.y, width: box.width, height: box.height };
  }, pseudo);
}
const transparent = color => color === 'rgba(0, 0, 0, 0)' || color === 'transparent';
// Production CSS may shorten decimals in custom properties (.97), while CSSOM
// serializes computed colours with leading zeroes (0.97). No probe DOM needed.
const color = value => value.trim()
  .replace(/(okl(?:ab|ch)\()(-?(?:\d+\.?\d*|\.\d+))%/g, (_, prefix, lightness) => prefix + Number(lightness) / 100)
  .replace(/-?(?:\d+\.?\d*|\.\d+)/g, number => String(Number(Number(number).toFixed(6)))).replace(/\s+/g, ' ');

// Pointer comparison is inside an already-hovered target: crossing an option's
// boundary legitimately changes native highlight/focus. Moving within it must
// change only the delegated CSS coordinates, not fill, ink, geometry or DOM.
async function gloss(locator, label, reduced = false, fractions = [.25, .75]) {
  await locator.hover();
  // Native hover/focus transitions are legitimate; settle the entry transition
  // before testing that movement *within* a face changes only local gloss.
  await page.waitForTimeout(220); await frames();
  const bounds = await locator.boundingBox(); assert.ok(bounds && bounds.width > 10);
  const sample = async fraction => {
    await page.mouse.move(bounds.x + bounds.width * fraction, bounds.y + bounds.height / 2);
    await frames();
    return locator.evaluate(node => ({
      x: node.style.getPropertyValue('--gloss-x'), y: node.style.getPropertyValue('--gloss-y'),
      active: node.hasAttribute('data-gloss-active'), observers: window.__visualObserverCount,
      dom: node.innerHTML, count: node.querySelectorAll('*').length,
      styleKeys: [...node.style].filter(key => !key.startsWith('--gloss-')),
      after: { opacity: getComputedStyle(node, '::after').opacity, events: getComputedStyle(node, '::after').pointerEvents },
      parts: [node, ...node.querySelectorAll('span, svg')].map(part => {
        const css = getComputedStyle(part);
        return [css.backgroundColor, css.backgroundImage, css.color, css.borderRadius, css.font, css.boxShadow];
      }),
    }));
  };
  const first = await sample(fractions[0]), second = await sample(fractions[1]);
  assert.ok(first.active && second.active, `${label}: shared gloss must be active`);
  assert.ok(first.x && first.y, `${label}: missing local coordinates`);
  if (reduced) assert.equal(first.x, second.x, `${label}: reduced motion must be static`);
  else assert.notEqual(first.x, second.x, `${label}: pointer must move local gloss`);
  assert.equal(first.y, second.y);
  assert.deepEqual(first.parts, second.parts, `${label}: pointer must not repaint native fill/ink/corners`);
  assert.equal(first.dom, second.dom, `${label}: no injected hover DOM`);
  assert.equal(first.count, second.count);
  assert.equal(first.observers, second.observers, `${label}: no pointer-frame mutation observer`);
  assert.deepEqual(first.styleKeys, second.styleKeys);
  assert.equal(second.after.events, 'none');
  assert.ok(Number(second.after.opacity) > 0);
  report.measurements.push({ label, gloss: [first.x, second.x], surface: await surface(locator) });
}
async function popup(trigger, slot, itemSlot, label, role) {
  const value = await trigger.textContent();
  await trigger.focus(); await trigger.press('Space');
  const content = page.locator(`[data-slot="${slot}"]`).filter({ visible: true });
  await content.waitFor(); await page.waitForTimeout(220); await frames();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  const geometry = await surface(content);
  assert.ok(geometry.radius.every(radius => parseFloat(radius) >= 16), `${label}: native rounded popup geometry`);
  assert.equal(geometry.image, 'none', `${label}: no selected rail material on popup`);
  const items = content.locator(`[data-slot="${itemSlot}"]`);
  assert.ok(await items.count());
  const options = await items.evaluateAll(nodes => nodes.map(node => ({ role: node.getAttribute('role'), name: node.textContent.trim() })));
  assert.ok(options.every(option => option.role === role && option.name), `${label}: accessible native options`);
  const item = items.filter({ visible: true }).first();
  await gloss(item, `${label} option`);
  const after = await surface(content);
  assert.deepEqual(after, geometry, `${label}: popup fill/ink/corners remain stable on pointer`);
  await capture(label);
  await page.keyboard.press('Escape'); await content.waitFor({ state: 'hidden' });
  assert.equal(await trigger.textContent(), value, `${label}: Escape must not save a choice`);
  assert.ok(await trigger.evaluate(node => node === document.activeElement), `${label}: Escape restores focus`);
}
async function bounds(locator, width, label) {
  const box = await locator.boundingBox();
  assert.ok(box && box.x >= -.5 && box.x + box.width <= width + .5, `${label}: ${JSON.stringify(box)}`);
}
async function newModes(label, width) {
  const track = page.getByRole('tablist', { name: 'New Agent Session mode', exact: true });
  await track.waitFor(); await bounds(track, width, label);
  for (const name of ['Chat', 'Workflow']) {
    const tab = track.getByRole('tab', { name, exact: true });
    await tab.click(); await page.mouse.move(width - 5, 5); await frames();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    const state = await track.evaluate(node => {
      const tabs = [...node.querySelectorAll('[role="tab"]')], selected = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
      const css = getComputedStyle(selected), box = node.getBoundingClientRect();
      return { selectedCount: tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length,
        muted: getComputedStyle(document.documentElement).getPropertyValue('--muted').trim(), fill: css.backgroundColor,
        image: css.backgroundImage, radius: css.borderRadius,
        inactive: getComputedStyle(tabs.find(tab => tab !== selected)).backgroundColor,
        track: getComputedStyle(node).backgroundColor,
        widths: tabs.map(tab => tab.getBoundingClientRect().width), width: box.width };
    });
    assert.equal(state.selectedCount, 1); assert.equal(color(state.fill), color(state.muted));
    assert.equal(state.image, 'none'); assert.equal(state.radius, '0px');
    assert.ok(transparent(state.inactive) && transparent(state.track));
    assert.ok(Math.abs(state.widths[0] + state.widths[1] - state.width) < 1, 'Tabs fill the whole strip');
    const panels = page.locator('[data-new-session]').getByRole('tabpanel');
    // This page has separate native panels for the mode's explanation and body.
    assert.ok(await panels.count());
    const panelIds = await panels.evaluateAll(nodes => nodes.map(node => node.id));
    assert.ok(panelIds.includes(await tab.getAttribute('aria-controls')));
    for (const panel of await panels.all()) assert.equal(await panel.getAttribute('aria-labelledby'), await tab.getAttribute('id'));
    await capture(`${label}-${name.toLowerCase()}`);
  }
  await track.getByRole('tab', { name: 'Workflow', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  const chat = track.getByRole('tab', { name: 'Chat', exact: true });
  assert.equal(await chat.getAttribute('aria-selected'), 'true');
  assert.ok(await chat.evaluate(node => node === document.activeElement && node.matches(':focus-visible')));
}
async function footer(label, width) {
  const back = page.getByRole('button', { name: 'Back to Agent Sessions', exact: true });
  await back.waitFor(); await page.waitForTimeout(250); await frames();
  const geometry = await back.evaluate(node => {
    const footer = node.closest('[data-sidebar="footer"]'), box = node.getBoundingClientRect(), parent = footer.getBoundingClientRect(), css = getComputedStyle(footer);
    return { x: box.x, width: box.width, height: box.height, bottom: box.bottom, parentX: parent.x, parentWidth: parent.width, parentBottom: parent.bottom, padding: css.padding, gap: css.gap, radius: getComputedStyle(node).borderRadius };
  });
  assert.equal(geometry.padding, '0px'); assert.equal(geometry.gap, '0px'); assert.equal(geometry.radius, '0px');
  assert.ok(Math.abs(geometry.width - geometry.parentWidth) < 1 && Math.abs(geometry.x - geometry.parentX) < 1);
  assert.ok(geometry.height >= 42 && Math.abs(geometry.bottom - geometry.parentBottom) < 1);
  await bounds(back, width, label);
  await back.focus(); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab'); await frames();
  assert.ok(await back.evaluate(node => node === document.activeElement && node.matches(':focus-visible') && getComputedStyle(node).boxShadow !== 'none'), 'Back keeps native focus ring');
  await gloss(back, label);
  await capture(label);
}

async function accentContrast(mode) {
  const values = await page.evaluate(() => {
    const css = getComputedStyle(document.documentElement), context = new OffscreenCanvas(1, 1).getContext('2d', { willReadFrequently: true });
    const pixel = token => { context.clearRect(0, 0, 1, 1); context.fillStyle = css.getPropertyValue(token).trim(); context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map(value => value / 255); };
    const luminance = rgb => rgb.map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
    const ratio = (a, b) => (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    return ['--status-active', '--status-awaiting', '--trigger-command', '--trigger-skill', '--diff-added'].map(token => {
      const ink = pixel(token), inkLuminance = luminance(ink);
      const contrasts = ['--background', '--sidebar', '--card'].flatMap(base => {
        const background = pixel(base), tint = token === '--diff-added' ? .10 : .18;
        return [ratio(inkLuminance, luminance(background)), ratio(inkLuminance, luminance(background.map((value, index) => value * (1 - tint) + ink[index] * tint)))];
      });
      return { token, value: css.getPropertyValue(token).trim(), minimum: Math.min(...contrasts) };
    });
  });
  report.measurements.push({ label: `${mode} rich accent contrast`, values });
  for (const value of values) assert.ok(value.minimum >= 4.5, `${mode}: ${value.token} small-text contrast ${value.minimum.toFixed(2)} is below 4.5`);
}
async function dockAndGit(mode) {
  // Many retained Agent Session event streams can exhaust Chromium's HTTP/1
  // connection pool. Release the rail-check page before the separate Dock phase.
  // Context-level guards, cookies, init scripts and browser-local layout remain.
  await page.close(); page = await context.newPage(); observePage(page);
  await page.goto(`${url.origin}/auth?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  await page.goto(`${url.origin}/#/s/${ids[0]}`, { waitUntil: 'domcontentloaded' });
  await rowFor(0).waitFor(); await theme(mode);
  const dock = page.getByRole('tablist', { name: 'right Dock tabs', exact: true }); await dock.waitFor();
  const strips = dock.locator(':scope > div'), faces = await strips.evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, radius: getComputedStyle(node).borderRadius, gloss: node.classList.contains('cursor-gloss') })));
  const geometry = await surface(dock);
  assert.equal(faces.length, 2); assert.ok(faces.every(face => face.radius === '0px' && face.gloss));
  assert.ok(Math.abs(faces.reduce((sum, face) => sum + face.width, 0) - geometry.width) < 1);
  assert.ok(Math.abs(faces[0].width - faces[1].width) < 1);
  await gloss(strips.first(), `${mode} full-tab gloss`, false, [.2, .5]);
  const agents = dock.getByRole('tab', { name: 'Agents', exact: true }), git = dock.getByRole('tab', { name: 'Git', exact: true });
  await agents.focus(); await agents.press('Space'); assert.equal(await agents.getAttribute('aria-selected'), 'true');
  await git.focus(); await git.press('Space'); assert.equal(await git.getAttribute('aria-selected'), 'true');
  assert.ok(await git.evaluate(node => node.matches(':focus-visible') && getComputedStyle(node).boxShadow !== 'none'));
  const views = page.getByRole('tablist', { name: 'Git views', exact: true });
  await views.getByRole('tab', { name: 'PR', exact: true }).waitFor();
  await views.getByRole('tab', { name: 'Diff', exact: true }).click();
  // Refresh is a read-only handler, unlike Publish/Pull. Wait for both optional
  // views' discovery before measuring a three-way strip.
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await views.getByRole('tab', { name: 'Stack', exact: true }).waitFor();
  const viewBox = await surface(views), paneBox = await surface(views.locator('..').locator('..'));
  assert.ok(Math.abs(viewBox.width - paneBox.width) < 1 && Math.abs(viewBox.x - paneBox.x) < 1);
  const tabs = await views.getByRole('tab').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, radius: getComputedStyle(node).borderRadius })));
  assert.equal(tabs.length, 3); assert.ok(tabs.every(tab => tab.radius === '0px' && tab.height === 36));
  assert.ok(tabs.every(tab => Math.abs(tab.width - viewBox.width / 3) < 1));
  await views.getByRole('tab', { name: 'Diff', exact: true }).click();
  const publish = page.getByRole('button', { name: 'Publish', exact: true }), actions = publish.locator('..');
  const actionBox = await surface(actions), actionFaces = await actions.getByRole('button').evaluateAll(nodes => nodes.map(node => ({ width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height, radius: getComputedStyle(node).borderRadius })));
  assert.equal(actionFaces.length, 3); assert.ok(actionFaces.every(face => face.height === 34 && face.radius === '0px'));
  assert.ok(Math.abs(actionFaces.reduce((sum, face) => sum + face.width, 0) - actionBox.width) < 1);
  // Never Publish/Pull or close a Shell: those are actual host writes.
  await capture(`dock-git-accents-${mode}`);
}

try {
  await page.goto(`${url.origin}/auth?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  await page.goto(`${url.origin}/#/s/${ids[0]}`, { waitUntil: 'domcontentloaded' });
  await rowFor(0).waitFor(); await page.getByRole('button', { name: 'More actions', exact: true }).waitFor();
  await check('Normal built bundle, no spike runtime', async () => {
    const native = await page.evaluate(() => ({
      globals: Object.getOwnPropertyNames(window).filter(name => /nat91/i.test(name)),
      nodes: document.querySelectorAll('canvas, [class*="nat91"], [id*="nat91"], [data-nat91-material], [data-material-ready]').length,
      scripts: [...document.scripts].map(script => script.src).filter(Boolean),
      notes: document.querySelectorAll('.preview-note, .nat91-note, [data-preview-note]').length,
    }));
    assert.deepEqual(native.globals, []); assert.equal(native.nodes, 0); assert.equal(native.notes, 0);
    assert.ok(native.scripts.some(src => new URL(src).pathname.startsWith('/assets/')), 'Must exercise built assets');
    assert.ok(native.scripts.every(src => !/@vite|spikes\/|live-material|mockup/.test(src)), 'No Vite or spike injection');
  });

  for (const mode of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 980 }); await theme(mode);
    await check(`${mode}: rich accents keep small-text contrast`, () => accentContrast(mode));
    await check(`${mode}: native rail status edges and invariant selection`, async () => {
      // Current agent rows are selected by native navigation, never test-only classes.
      const selectedImages = new Map();
      const statusRule = await page.evaluate(() => {
        const rules = sheets => sheets.flatMap(sheet => [...(sheet.cssRules ?? [])].flatMap(rule => [rule, ...(rule.cssRules?.length ? rules([rule]) : [])]));
        return rules([...document.styleSheets]).find(rule => rule.selectorText === '.agent-session-row[data-sidebar="menu-button"][data-active]::before')?.style.backgroundImage;
      });
      assert.ok(statusRule?.includes('var(--agent-session-status)'), 'Selected flow derives its hue from the status edge');
      for (const [index, id] of ids.entries()) {
        await navigate(`#/s/${id}`); const row = rowFor(index);
        await page.waitForFunction(title => [...document.querySelectorAll('[data-sidebar="menu-button"][aria-current]')].some(node => node.textContent.includes(title)), titles[index]);
        await page.mouse.move(1000, 5); await frames();
        assert.equal(await row.getAttribute('aria-current'), 'true');
        assert.notEqual(await row.getAttribute('data-active'), null);
        const before = await surface(row, '::before'), face = await surface(row);
        assert.notEqual(before.image, 'none', 'Selection is a native CSS ::before layer');
        assert.equal(before.pointerEvents, 'none'); assert.notEqual(before.content, 'none');
        assert.ok(before.animation !== 'none', 'Selected face breathes under normal motion');
        assert.ok(parseFloat(face.borderWidth) >= 2 && !transparent(face.border), 'Full-height status edge is retained');
        const edgeToken = ['--foreground', '--status-active', '--foreground', '--muted-foreground', '--status-awaiting'][index];
        const expectedEdge = await row.evaluate((node, token) => getComputedStyle(node).getPropertyValue(token).trim(), edgeToken);
        assert.equal(color(face.border), color(expectedEdge), `Status edge uses ${edgeToken}`);
        assert.equal(await row.evaluate(node => node.style.getPropertyValue('--agent-session-status')), `var(${edgeToken})`);
        if (selectedImages.has(edgeToken)) assert.equal(before.image, selectedImages.get(edgeToken), 'Same status uses the same selected tint');
        else assert.ok(![...selectedImages.values()].includes(before.image), 'Different statuses retain distinct selected tints');
        selectedImages.set(edgeToken, before.image);
        const selected = page.locator('[data-sidebar="menu-button"][aria-current]');
        assert.equal(await selected.count(), 1, 'Exactly one native current row');
        for (const other of await page.locator('[data-sidebar="menu-button"]:not([aria-current])').all()) {
          assert.equal((await surface(other, '::before')).image, 'none', 'Only the selected row has a flowing layer');
        }
        assert.ok((await row.textContent()).toLowerCase().includes(['idle', 'running', 'idle', 'dormant', 'awaiting'][index]), 'Accessible status remains');
        await row.hover(); await frames();
        const hovered = await surface(row);
        report.measurements.push({ label: `${mode} selected ${index}`, before, face });
        await capture(`rail-${mode}-${index}`);
        if (index === 1 || index === 4) await capture(`accents-${mode}-${index === 1 ? 'working' : 'awaiting'}`);
        await navigate(`#/s/${ids[(index + 1) % ids.length]}`);
        await page.waitForFunction(title => ![...document.querySelectorAll('[data-sidebar="menu-button"][aria-current]')].some(node => node.textContent.includes(title)), titles[index]);
        const deselected = await surface(row);
        for (const key of ['fill', 'ink', 'border', 'radius']) {
          assert.deepEqual(hovered[key], face[key], `Hover keeps ${key} invariant`);
          assert.deepEqual(deselected[key], face[key], `Deselection keeps ${key} invariant`);
        }
        assert.equal((await surface(row, '::before')).image, 'none');
      }
      const labels = await page.locator('[data-sidebar="group-label"]').evaluateAll(nodes => nodes
        .filter(node => { const box = node.getBoundingClientRect(); return box.width > 1 && box.height > 1 && getComputedStyle(node).visibility !== 'hidden'; })
        .map(node => node.textContent.trim()));
      assert.ok(labels.some(label => /Settled/.test(label)), `Settled disclosure stays visible: ${labels}`);
      assert.ok(labels.some(label => /Needs input/.test(label)), 'Newer attention heading is preserved');
      assert.ok(labels.every(label => /Settled|Needs input|Unread/.test(label)), `Ordinary Band headings have no layout space: ${labels}`);
      const menuLabels = await page.locator('[data-sidebar="menu"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
      assert.ok(menuLabels.length >= 4 && menuLabels.every(Boolean), 'Accessible Band menu names are retained');
      await page.emulateMedia({ reducedMotion: 'reduce' }); await frames();
      await navigate(`#/s/${ids[4]}`);
      await page.waitForFunction(title => document.querySelector('[aria-current="true"]')?.textContent.includes(title), titles[4]);
      const row = rowFor(4), before = await surface(row, '::before');
      const durations = before.duration.split(',').map(value => parseFloat(value) / (value.trim().endsWith('ms') ? 1000 : 1));
      assert.ok(before.animation === 'none' || durations.every(seconds => seconds <= .00001), 'Reduced-motion face is static');
      await gloss(row, `${mode} reduced row`, true);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    });
    await check(`${mode}: Settled native disclosure keyboard`, async () => {
      // Keep the cursor outside Settled before collapsing, otherwise the native
      // rail correctly forces the cursor's group open to avoid stranding focus.
      const cursor = page.locator('[data-sidebar="menu-button"][data-cursor="true"]');
      if (await cursor.count()) { await cursor.focus(); await page.keyboard.press('Home'); }
      const details = page.locator('[data-sidebar="content"] details'), summary = details.locator('summary');
      await summary.waitFor();
      if (await details.getAttribute('open') !== null) { await summary.focus(); await summary.press('Enter'); await frames(); }
      assert.equal(await details.getAttribute('open'), null);
      assert.equal(await details.locator('[data-cursor="true"]').count(), 0, 'No cursor may be stranded inside collapsed disclosure');
      await summary.focus(); await summary.press('Space');
      await page.waitForFunction(() => document.querySelector('[data-sidebar="content"] details')?.open); await frames();
      assert.ok(await summary.evaluate(node => node === document.activeElement));
      await summary.press('Enter');
      await page.waitForFunction(() => !document.querySelector('[data-sidebar="content"] details')?.open); await frames();
      await summary.press('Enter'); await frames();
      await navigate(`#/s/${settledId}`);
      const settledRow = page.locator('[data-sidebar="menu-button"][aria-current]').filter({ hasText: 'Review complete' });
      await settledRow.waitFor();
      // A newly acquired view begins with an Idle chrome snapshot until its
      // actual Lifecycle loads. Do not capture that initial loading frame.
      await page.waitForFunction(() => document.querySelector('[data-sidebar="menu-button"][aria-current]')?.style.getPropertyValue('--agent-session-status').includes('color-mix'));
      await frames();
      const settledFace = await surface(settledRow, '::before'), idleFace = await surface(rowFor(0), '::before');
      assert.notEqual(settledFace.image, 'none', 'Settled selection has a status-hued flow layer');
      assert.notEqual(settledFace.image, report.measurements.find(sample => sample.label === `${mode} selected 0`)?.before.image, 'Settled keeps its own muted tint, not Idle ink');
      assert.equal(idleFace.image, 'none', 'Former selection stops flowing');
      await capture(`rail-${mode}-settled`);
    });
    await navigate(`#/s/${ids[0]}`); await rowFor(0).waitFor();
    await check(`${mode}: full-width native Dock and Git controls`, () => dockAndGit(mode));
    await check(`${mode}: transparent Settle routes gloss to whole row`, async () => {
      const row = rowFor(0), action = row.locator('..').locator('[data-sidebar="menu-action"]');
      await row.hover(); await action.waitFor(); await action.hover(); await frames();
      assert.ok(transparent((await surface(action)).fill), 'Settle hover has no standalone tile fill');
      assert.ok(await row.evaluate(node => node.hasAttribute('data-gloss-active')), 'Settle lights the whole row');
      assert.ok(Number((await surface(row, '::after')).opacity) > 0);
      assert.equal(await action.getAttribute('data-gloss-active'), null);
      await row.focus(); await page.keyboard.press('ArrowRight');
      assert.ok(await action.evaluate(node => node === document.activeElement));
      await page.keyboard.press('ArrowLeft'); assert.ok(await row.evaluate(node => node === document.activeElement));
    });
    await check(`${mode}: native action menu`, () => popup(page.getByRole('button', { name: 'More actions', exact: true }), 'dropdown-menu-content', 'dropdown-menu-item', `menu-${mode}`, 'menuitem'));
    await page.locator('[data-sidebar="header"]').getByRole('button', { name: 'New Agent Session', exact: true }).click();
    await page.getByRole('heading', { name: 'New Agent Session', exact: true }).waitFor();
    await check(`${mode}: full-strip modes and panel keyboard`, () => newModes(`new-${mode}`, 1440));
    await check(`${mode}: native Select`, () => popup(page.locator('[data-slot="select-trigger"][aria-label="Backend"]'), 'select-content', 'select-item', `select-${mode}`, 'option'));
    await check(`${mode}: native Combobox`, () => popup(page.locator('[data-slot="combobox-trigger"][aria-label="Project"]'), 'combobox-content', 'combobox-item', `combobox-${mode}`, 'option'));
    await check(`${mode}: MCP disclosure stays flat and keyboard accessible`, async () => {
      const trigger = page.getByRole('button', { name: /^MCP connections/ }); await trigger.waitFor();
      await trigger.hover(); await frames(); assert.equal(await trigger.getAttribute('data-gloss-active'), null);
      await trigger.focus(); await trigger.press('Enter'); assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
      assert.equal(await page.getByRole('switch').count(), 2);
      await capture(`mcp-${mode}`); await trigger.press('Enter'); assert.equal(await trigger.getAttribute('aria-expanded'), 'false');
    });
    await check(`${mode}: full-width Settings and dedicated Back footer`, async () => {
      const settings = page.locator('[data-sidebar="footer"]').getByRole('button', { name: 'Settings', exact: true });
      await bounds(settings, 1440, 'Rail Settings shortcut');
      await settings.click(); await page.locator('[data-sidebar="menu"][aria-label="Settings sections"]').waitFor();
      const selectedSettings = page.locator('[data-sidebar="menu-button"][aria-current="page"]');
      assert.equal((await surface(selectedSettings, '::before')).image, 'none', 'Settings keeps native selection, not rail Flow material');
      await gloss(rows().filter({ hasText: 'Which models to use' }), `${mode} delegated Settings row`);
      await footer(`settings-footer-${mode}`, 1440);
      await page.getByRole('button', { name: 'Back to Agent Sessions', exact: true }).press('Space');
      await page.waitForFunction(() => !location.hash.includes('/settings/'));
    });
    await check(`${mode}: mobile drawer and narrow bounds`, async () => {
      await navigate('#/new/fake'); await page.getByRole('heading', { name: 'New Agent Session', exact: true }).waitFor();
      await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(250); await frames();
      const drawer = page.locator('[data-sidebar="sidebar"][data-mobile="true"]');
      if (!await drawer.isVisible()) await page.locator('[data-sidebar="trigger"]').click();
      await drawer.waitFor(); await page.waitForTimeout(250);
      await bounds(drawer, 390, 'Mobile drawer'); await capture(`drawer-${mode}`);
      await drawer.locator('[data-sidebar="header"]').getByRole('button', { name: 'New Agent Session', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' }); await newModes(`mobile-${mode}`, 390);
      await page.locator('[data-sidebar="trigger"]').click(); await drawer.waitFor();
      await drawer.getByRole('button', { name: 'Settings', exact: true }).click(); await drawer.waitFor({ state: 'hidden' });
      await page.locator('[data-sidebar="trigger"]').click(); await drawer.waitFor(); await footer(`mobile-settings-footer-${mode}`, 390);
      await drawer.getByRole('button', { name: 'Back to Agent Sessions', exact: true }).press('Space'); await drawer.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 320, height: 720 }); await newModes(`narrow-${mode}`, 320);
      assert.ok(await page.locator('body').evaluate(node => node.scrollWidth <= node.clientWidth), 'No horizontal overflow at 320px');
      await capture(`narrow-${mode}`);
      await navigate(`#/s/${ids[0]}`);
      const views = page.getByRole('tablist', { name: 'Agent Session content', exact: true }); await views.waitFor();
      await views.getByRole('tab', { name: 'Transcript', exact: true }).click(); await bounds(views, 320, 'Mobile Agent Session views');
      const title = page.getByText('Contrast audit', { exact: true }); await title.waitFor();
      const notice = title.locator('..'), description = notice.getByText('Check selected controls in both themes', { exact: true });
      assert.equal(await notice.evaluate(node => getComputedStyle(node).display), 'grid');
      assert.ok((await description.boundingBox()).y > (await title.boundingBox()).y, 'Narrow Subagent description sits below its title');
      await capture(`mobile-agent-session-${mode}`);
    });
  }
} catch (error) {
  failures.push(`Setup/navigation: ${error.stack ?? error}`);
} finally {
  if (report.mutations.length) failures.push(`Unexpected/blocked writes: ${JSON.stringify(report.mutations)}`);
  if (report.errors.length) failures.push(`Browser errors: ${JSON.stringify(report.errors)}`);
  if (report.httpErrors.length) failures.push(`HTTP errors: ${JSON.stringify(report.httpErrors)}`);
  report.failures = failures;
  if (out) await writeFile(join(out, 'visual-alignment-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
console.log(`${failures.length ? 'FAILED' : 'Passed'}: ${report.checks.filter(check => check.passed).length}/${report.checks.length} checks; ${report.screenshots.length} screenshots${out ? `; report: ${out}/visual-alignment-report.json` : ''}`);
for (const failure of failures) console.error(failure);
if (failures.length) process.exitCode = 1;
