// Browser-only regression for the real NAT-91 preview; never saves Settings or a Workflow.
// Run with the same PLAYWRIGHT_MODULE / PLAYWRIGHT_EXECUTABLE_PATH as capture.mjs.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs');
const root = resolve(process.env.MOCKUP_STATE_DIR ?? '/tmp/nat91-rebased-check');
const url = process.env.MOCKUP_URL ?? 'http://127.0.0.1:5191';
const address = new URL(url);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname), 'Use only the isolated loopback preview, not a live backend');
assert.ok(root.startsWith('/tmp/'), 'Use a temporary dev-host fixture state root, never normal Flow state');
const token = (await readFile(join(root, 'token'), 'utf8')).trim();
// study.json is intentionally mandatory: existing-backend preview mode does not create it.
const { ids } = JSON.parse(await readFile(join(root, 'study.json'), 'utf8'));
assert.ok(ids?.length, 'The isolated dev-host fixture must have seeded Agent Sessions');
const out = process.env.CAPTURE_DIR ?? '/tmp/nat91-dropdown-captures';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const failures = [], results = [], errors = [], mutations = [];
const check = (label, action) => {
  try { action(); results.push({ label, passed: true }); }
  catch (error) { failures.push(`${label}: ${error.message}`); results.push({ label, passed: false, error: error.message }); }
};
const run = async (label, action) => {
  try { await action(); }
  catch (error) { failures.push(`${label}: ${error.message}`); results.push({ label, passed: false, error: error.message }); await page.keyboard.press('Escape').catch(() => {}); }
};
const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
const page = await context.newPage();
page.setDefaultTimeout(7000);
page.on('pageerror', error => errors.push(error.message));
const popupSelector = '[data-slot="select-content"], [data-slot="combobox-content"]';
const itemSelector = '[data-slot="select-item"], [data-slot="combobox-item"]';
const report = { url, root, screenshots: [], results, geometry: [], pointer: [] };

async function settle() {
  // Structural draws caused by focus, portals or React polling are allowed. Wait
  // for three quiet frames before comparing material pixels or pointer counters.
  return page.evaluate(async () => {
    let previous = window.nat91Material.canvas.dataset.revision, quiet = 0;
    for (let i = 0; i < 40; i++) {
      await new Promise(requestAnimationFrame);
      const current = window.nat91Material.canvas.dataset.revision;
      quiet = current === previous ? quiet + 1 : 0;
      previous = current;
      if (quiet === 3) return true;
    }
    return false;
  });
}
async function theme(dark) {
  await page.emulateMedia({ colorScheme: dark ? 'dark' : 'light', reducedMotion: 'no-preference' });
  await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
  await page.evaluate(() => document.fonts.ready);
  await settle();
}
async function capture(name) {
  const path = join(out, `${name}.png`);
  await page.screenshot({ path });
  report.screenshots.push(path);
}
async function pixels(control) {
  return control.locator(':scope > .nat91-control-texture').evaluate(canvas => canvas.toDataURL());
}
async function inspectOpen(trigger, popup, label) {
  await popup.waitFor();
  await settle();
  const triggerInfo = await trigger.evaluate(node => ({
    radius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(key => getComputedStyle(node)[key]),
    expanded: node.getAttribute('aria-expanded'), label: node.getAttribute('aria-label'),
  }));
  const contentInfo = await popup.evaluate(node => ({
    radius: ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'].map(key => getComputedStyle(node)[key]),
    portalled: !document.querySelector('#root').contains(node),
    listbox: node.matches('[role="listbox"]') || !!node.querySelector('[role="listbox"]'),
  }));
  // Resolve the native rounded-2xl token instead of freezing its pixel value:
  // the current theme computes 18px; other preview revisions use 16px. Neither
  // should be replaced by the material layer's old 3px button radius.
  const nativeRadius = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'rounded-2xl';
    probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none';
    document.body.append(probe);
    const radius = getComputedStyle(probe).borderTopLeftRadius;
    probe.remove();
    return radius;
  });
  report.geometry.push({ label, nativeRadius, trigger: triggerInfo.radius, popup: contentInfo.radius });
  check(`${label}: matching native trigger/popup geometry`, () => {
    assert.ok(parseFloat(nativeRadius) >= 16, 'Expected the native rounded select/combobox geometry');
    assert.deepEqual(triggerInfo.radius, Array(4).fill(nativeRadius));
    assert.deepEqual(contentInfo.radius, triggerInfo.radius);
  });
  check(`${label}: accessible, portalled listbox`, () => {
    assert.ok(triggerInfo.label); assert.equal(triggerInfo.expanded, 'true');
    assert.ok(contentInfo.portalled); assert.ok(contentInfo.listbox);
  });
  const items = await popup.locator(itemSelector).evaluateAll(nodes => nodes.map(node => ({
    text: node.textContent.trim(), role: node.getAttribute('role'),
    material: node.classList.contains('nat91-control'),
    nativeSelected: node.hasAttribute('data-selected'), ariaSelected: node.getAttribute('aria-selected') === 'true',
    selected: node.dataset.nat91Selected === 'true',
    visible: (() => {
      const rect = node.getBoundingClientRect();
      const clip = node.closest('[data-slot="select-content"], [data-slot="combobox-content"]').getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, clip.top) && rect.top < Math.min(innerHeight, clip.bottom);
    })(),
  })));
  check(`${label}: portalled options retain roles/names and visible items have material`, () => {
    assert.ok(items.length);
    assert.ok(items.every(item => item.role === 'option' && item.text));
    const visible = items.filter(item => item.visible);
    assert.ok(visible.length);
    assert.ok(visible.every(item => item.material), `Visible options missing .nat91-control: ${visible.filter(item => !item.material).map(item => item.text).join(', ')}`);
  });
  // Base UI's data-selected denotes the value; aria-selected can denote the
  // keyboard highlight in a combobox, so prefer the value marker when present.
  const selected = items.filter(item => item.nativeSelected);
  check(`${label}: selected option[data-nat91-selected=true]`, () => {
    const native = selected.length ? selected : items.filter(item => item.ariaSelected);
    assert.ok(native.length, 'Expected a native selected value');
    assert.ok(native.every(item => item.selected), JSON.stringify(native));
  });
}
async function open(trigger, remote, label) {
  await page.mouse.move(800, 40); // no hover changes on either sampled control
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  await settle();
  const before = remote ? await pixels(remote) : undefined;
  await trigger.press('Space');
  const popup = page.locator(popupSelector).filter({ visible: true }).last();
  await inspectOpen(trigger, popup, label);
  if (remote) {
    const after = await pixels(remote);
    check(`${label}: no overlay backdrop in remote pixels`, () => assert.ok(after === before, 'An unrelated material canvas changed when the popup opened'));
  }
  return popup;
}
async function escape(trigger, label) {
  const before = await trigger.textContent();
  await page.keyboard.press('Escape');
  await page.locator(popupSelector).filter({ visible: true }).waitFor({ state: 'hidden' });
  const restored = await trigger.evaluate(node => document.activeElement === node && node.getAttribute('aria-expanded') !== 'true');
  const after = await trigger.textContent();
  check(`${label}: Escape preserves value and restores focus`, () => {
    assert.ok(restored); assert.equal(after, before, 'Escape must not change the selected value');
  });
  await settle();
}
async function keyboardSelect(trigger, remote, label, expected) {
  const popup = await open(trigger, remote, `${label}-keyboard`);
  const option = popup.getByRole('option', { name: expected, exact: true });
  await option.waitFor();
  // Select the last option with native keyboard handling, not an item click or
  // synthetic React state. All callers arrange the desired value at the end.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.locator(popupSelector).filter({ visible: true }).waitFor({ state: 'hidden' });
  await page.waitForFunction(({ label, expected }) => {
    const node = [...document.querySelectorAll('[data-slot="select-trigger"], [data-slot="combobox-trigger"]')].find(node => node.getAttribute('aria-label') === label);
    return node?.textContent.includes(expected);
  }, { label: await trigger.getAttribute('aria-label'), expected });
  check(`${label}: keyboard selection updates real trigger`, () => assert.ok(true));
}

async function pointerOnly(dark) {
  // Settings sidebar rows have no React tooltip, unlike Agent Session rows.
  // Work inside one already-hovered metadata span, never cross its edge.
  const row = page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Visual workflow definitions' }).first();
  await row.scrollIntoViewIfNeeded();
  assert.equal(await row.locator('[title]').count(), 0, 'Safe Settings row should have no native tooltips');
  assert.equal(await row.getAttribute('title'), null, 'Safe Settings row should have no native tooltip');
  const target = row.locator('span.block.truncate.text-xs');
  const bounds = await target.boundingBox();
  assert.ok(bounds && bounds.width > 30);
  await page.mouse.move(bounds.x + bounds.width * .3, bounds.y + bounds.height * .5);
  await page.waitForTimeout(250);
  await settle();
  const gloss = row.locator(':scope > .nat91-gloss');
  assert.equal(await gloss.count(), 1, 'Missing CSS .nat91-gloss overlay (implementation may not be ready)');
  const glossInfo = await gloss.evaluate(node => ({ canvas: node.querySelectorAll('canvas').length, pointerEvents: getComputedStyle(node).pointerEvents }));
  check(`${dark ? 'dark' : 'light'}: lightweight CSS gloss, not a hover canvas`, () => {
    assert.equal(glossInfo.canvas, 0, 'Gloss must not contain a canvas');
    assert.equal(glossInfo.pointerEvents, 'none', 'Gloss must not intercept interaction');
  });
  const spot = gloss.locator('.nat91-gloss-spot');
  await spot.waitFor({ state: 'attached' });
  const snapshot = () => page.evaluate(() => ({ revision: Number(window.nat91Material.canvas.dataset.revision), stats: window.nat91Material.getStats?.() }));
  let passed = false;
  // Short, bounded windows avoid unrelated React polling. Retry a structural
  // collision at most twice; a pointer-triggered renderer will fail every window.
  for (let attempt = 0; attempt < 3; attempt++) {
    await settle();
    const before = await snapshot();
    const transforms = [await spot.evaluate(node => getComputedStyle(node).transform)];
    const frameGaps = [];
    for (let i = 0; i < 6; i++) {
      const fraction = i % 2 ? .3 : .7;
      await page.mouse.move(bounds.x + bounds.width * fraction, bounds.y + bounds.height * .5);
      frameGaps.push(await page.evaluate(async () => {
        const start = performance.now(); await new Promise(requestAnimationFrame); return performance.now() - start;
      }));
      transforms.push(await spot.evaluate(node => getComputedStyle(node).transform));
    }
    const after = await snapshot();
    const measurement = { theme: dark ? 'dark' : 'light', attempt, before, after, transforms, frameGaps };
    report.pointer.push(measurement);
    const stats = before.stats && after.stats;
    passed = after.revision === before.revision && (!stats || (
      after.stats.draws === before.stats.draws && after.stats.inkBuilds === before.stats.inkBuilds
      && after.stats.materialBuilds === before.stats.materialBuilds
    ));
    if (passed) {
      check(`${measurement.theme}: every pointer move updates the gloss spot transform`, () => {
        assert.ok(transforms.slice(1).every((transform, index) => transform !== 'none' && transform !== transforms[index]), JSON.stringify(transforms));
      });
      check(`${measurement.theme}: pointer metrics`, () => {
        assert.ok(stats, 'Expected window.nat91Material.getStats()');
        for (const key of ['lastDrawMs', 'draws', 'pointerFrames', 'lastPointerMs', 'inkBuilds']) assert.ok(Number.isFinite(after.stats[key]), `Missing numeric ${key}`);
        assert.ok(after.stats.pointerFrames > before.stats.pointerFrames, 'Expected lightweight pointer frames');
      });
      break;
    }
    await page.waitForTimeout(180);
  }
  check(`${dark ? 'dark' : 'light'}: pointer-only motion has zero GPU draws / ink builds / revision changes`, () => assert.ok(passed, JSON.stringify(report.pointer.at(-1))));
  await capture(`dropdowns-${dark ? 'dark' : 'light'}-css-gloss`);
}

try {
  await page.goto(`${url}/auth?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  await page.goto(`${url}/study`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(id => location.hash.includes(id), ids[0]);
  await page.getByRole('tab', { name: 'Agents', exact: true }).waitFor();
  await page.locator('body[data-material-ready=true]').waitFor();
  // Allow a modest hot-reload window while the preview implementation is being
  // developed. Continue with detailed failures/screenshots if it is still old.
  await page.waitForFunction(() => typeof window.nat91Material?.getStats === 'function', undefined, { timeout: 20000 }).catch(() => {
    console.warn('getStats not ready after 20s; running checks against the current preview.');
  });
  const response = await context.request.get(`${url}/api/models`);
  assert.ok(response.ok(), 'Read the isolated fixture model catalogue');
  const catalogue = await response.json();
  const backend = catalogue[0]?.backend;
  assert.ok(backend, 'Fixture should expose one Backend Adapter');
  const models = Array.from({ length: 36 }, (_, index) => ({
    id: `nat91-readonly-${String(index + 1).padStart(2, '0')}`,
    label: `NAT91 Model ${String(index + 1).padStart(2, '0')}`,
    provider: 'NAT91 fixture', effortLevels: ['low', 'medium', 'high'],
  }));
  // Only GET discovery responses are mocked, in this browser context. No host
  // config, auth, transcript, or normal-state file is changed by this test.
  await page.route('**/api/models*', route => route.request().method() === 'GET'
    ? route.fulfill({ json: [{ backend, models }] }) : route.continue());
  const workflows = ['Alpha', 'Beta'].map(name => ({
    version: 1, id: `nat91-readonly-${name.toLowerCase()}`, name: `NAT91 ${name} workflow`, backend,
    inputSchema: { type: 'object', fields: {} },
    steps: [{ id: 'nat91-model-step', name: 'NAT91 model step', kind: 'agent', instructions: 'Read-only dropdown regression', model: models[0].id, effort: 'medium', outputSchema: { type: 'object', fields: {} } }], edges: [],
  }));
  await page.route('**/api/workflows', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { workflows } }) : route.continue());
  // Fail closed if a future UI refactor starts auto-saving any of these local
  // selections. Nothing in this regression needs a mutating API request.
  await page.route('**/api/**', async route => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(route.request().method())) return route.fallback();
    mutations.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    await route.abort('blockedbyclient');
  });

  for (const dark of [true, false]) {
    const mode = dark ? 'dark' : 'light';
    await page.goto(`${url}/#/settings/workflows`, { waitUntil: 'domcontentloaded' });
    const definition = page.locator('[data-slot="select-trigger"][aria-label="Workflow definition"]');
    await definition.waitFor();
    await theme(dark);
    const newWorkflow = page.getByRole('button', { name: 'New workflow', exact: true });
    await run(`${mode} Workflows`, async () => {
      await open(definition, newWorkflow, `${mode}-workflow`);
      await capture(`dropdowns-${mode}-workflow-open`);
      await escape(definition, `${mode}-workflow`);
      await keyboardSelect(definition, newWorkflow, `${mode}-workflow`, workflows[1].name);
      await open(definition, newWorkflow, `${mode}-workflow-selected`);
      await capture(`dropdowns-${mode}-workflow-selected`);
      await escape(definition, `${mode}-workflow-selected`);
      await page.locator('.workflow-step').filter({ hasText: 'NAT91 model step' }).click();
      const model = page.locator('.workflow-inspector [data-slot="combobox-trigger"][aria-label="Model"]');
      await model.waitFor();
      const remote = page.locator('.workflow-inspector [data-slot="select-trigger"][aria-label="Step permission"]');
      const popup = await open(model, remote, `${mode}-workflow-model-combobox`);
      await capture(`dropdowns-${mode}-combobox-open`);
      const input = popup.getByRole('combobox');
      await input.fill('NAT91 Model 02');
      await popup.getByRole('option', { name: models[1].label, exact: true }).waitFor();
      check(`${mode}: combobox accessible filtering`, () => assert.ok(true));
      await input.press('ArrowDown');
      await input.press('Enter');
      await page.waitForFunction(expected => document.querySelector('.workflow-inspector [data-slot="combobox-trigger"]')?.textContent.includes(expected), models[1].label);
      await open(model, remote, `${mode}-combobox-selected`);
      await capture(`dropdowns-${mode}-combobox-selected`);
      await escape(model, `${mode}-combobox`);
    });
    await run(`${mode} pointer benchmark`, () => pointerOnly(dark));

    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Which models to use' }).click();
    const defaultBackend = page.locator('[data-slot="select-trigger"][aria-label="Default Backend"]');
    await defaultBackend.waitFor();
    await page.locator('details[name="provider-backends"] > summary').first().click();
    const defaultModel = page.locator(`[data-slot="select-trigger"][aria-label="${backend} Default Model"]`);
    const summaryModel = page.locator(`[data-slot="select-trigger"][aria-label="${backend} Summary Model"]`);
    await defaultModel.waitFor();
    await theme(dark);
    for (const [name, trigger, remote, expected] of [
      ['default-backend', defaultBackend, summaryModel, backend === 'pi' ? 'Pi' : backend === 'claude' ? 'Claude' : backend],
      ['default-model', defaultModel, summaryModel, `NAT91 fixture / ${models.at(-1).label}`],
      ['summary-model', summaryModel, defaultModel, `NAT91 fixture / ${models.at(-1).label}`],
    ]) await run(`${mode} Providers ${name}`, async () => {
      await open(trigger, remote, `${mode}-${name}`);
      await capture(`dropdowns-${mode}-${name}-open`);
      await escape(trigger, `${mode}-${name}`);
      await keyboardSelect(trigger, remote, `${mode}-${name}`, expected);
      await open(trigger, remote, `${mode}-${name}-selected`);
      await capture(`dropdowns-${mode}-${name}-selected`);
      await escape(trigger, `${mode}-${name}-selected`);
    });

    await page.getByRole('button', { name: 'Back to Agent Sessions', exact: true }).click();
    // A full Vite reload on a Settings deep link forgets the return point. Use
    // the seeded Agent Session explicitly, not a newly-created/live session.
    await page.goto(`${url}/#/s/${ids[0]}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Agents', exact: true }).waitFor();
    await theme(dark);
    await run(`${mode} composer popup`, async () => {
      // Composer capabilities come from the real FakeBackend stream, not the
      // catalogue mock. Escape only: no session model/effort mutation is needed.
      const trigger = page.locator('[data-slot="select-trigger"][aria-label="Model"], [data-slot="combobox-trigger"][aria-label="Model"], [data-slot="select-trigger"][aria-label="Effort"]').filter({ visible: true }).first();
      await trigger.waitFor();
      const remote = page.getByRole('tab', { name: 'Agents', exact: true }).locator('..');
      await open(trigger, remote, `${mode}-composer`);
      await capture(`dropdowns-${mode}-composer-open`);
      await page.keyboard.press('ArrowDown');
      await escape(trigger, `${mode}-composer`);
    });
  }
  check('No mutating API requests', () => assert.deepEqual(mutations, []));
  check('No browser script failures', () => assert.deepEqual(errors, []));
} catch (error) {
  failures.push(`Setup/navigation: ${error.stack ?? error.message}`);
} finally {
  report.failures = failures;
  report.errors = errors;
  report.mutations = mutations;
  await writeFile(join(out, 'dropdowns-report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
console.log(`${failures.length ? 'FAILED' : 'Passed'}: ${results.filter(result => result.passed).length} checks; ${report.screenshots.length} screenshots. Captures/report: ${out}`);
for (const failure of failures) console.error(failure);
if (failures.length) process.exitCode = 1;
