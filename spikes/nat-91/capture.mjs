import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs');
const root = process.env.MOCKUP_STATE_DIR;
if (!root) throw new Error('Set MOCKUP_STATE_DIR to the running dev-host.ts state root.');
const token = await readFile(join(root, 'token'), 'utf8');
const { ids } = JSON.parse(await readFile(join(root, 'study.json'), 'utf8'));
const out = process.env.CAPTURE_DIR ?? '/tmp/nat91-live-captures';
const url = process.env.MOCKUP_URL ?? 'http://127.0.0.1:5191';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
});
const errors = [];
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1.5, colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${url}/auth?token=${token}`, { waitUntil: 'domcontentloaded' });
  await page.goto(`${url}/study`, { waitUntil: 'domcontentloaded' });
  assert.ok(page.url().includes(ids[0]), 'Study handoff opens the seeded Agent Session');
  await page.getByText('This dev study uses the real Flow components.', { exact: false }).last().waitFor();
  await page.locator('body[data-material-ready=true]').waitFor();
  await page.getByRole('tab', { name: 'Agents' }).waitFor();
  await page.mouse.move(570, 220);
  await page.waitForTimeout(150);
  const before = await page.evaluate(() => window.nat91Material.canvas.toDataURL());
  await page.mouse.move(90, 570);
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => window.nat91Material.canvas.toDataURL());
  assert.notEqual(before, after, 'Shared material light must respond to cursor movement');
  await page.screenshot({ path: join(out, 'real-ui-dark.png') });

  // Real tabs and session navigation, not simulated mockup handlers.
  await page.getByRole('tab', { name: 'Git' }).click();
  await page.getByRole('tab', { name: 'Git' }).getAttribute('aria-selected').then(value => assert.equal(value, 'true'));
  await page.getByRole('button', { name: 'Refresh', exact: true }).hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, 'real-ui-git-hover.png') });
  await page.screenshot({ path: join(out, 'real-ui-control-detail.png'), clip: { x: 1090, y: 50, width: 350, height: 380 } });
  await page.getByRole('tab', { name: 'Agents' }).click();
  const rail = page.locator('[data-sidebar="menu-button"]').filter({ hasText: 'Polish keyboard navigation' });
  await rail.click();
  await page.waitForFunction(id => location.hash.includes(id), ids[2]);
  await page.goto(`${url}/#/s/${ids[0]}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Agents' }).waitFor();
  await page.keyboard.press('Tab');
  await page.getByRole('tab', { name: 'Agents' }).focus();
  assert.ok(await page.getByRole('tab', { name: 'Agents' }).evaluate(node => node.matches(':focus-visible')));
  await page.screenshot({ path: join(out, 'real-ui-keyboard-focus.png') });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() => {
    const light = window.nat91Material.getLight();
    return Math.abs(light.x - innerWidth * .56) < .01 && Math.abs(light.y - innerHeight * .3) < .01;
  });
  const stableLight = await page.evaluate(() => window.nat91Material.getLight());
  await page.mouse.move(1300, 850);
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(() => window.nat91Material.getLight()), stableLight, 'Reduced motion fixes the shared light');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(out, 'real-ui-light.png') });
  assert.ok(await page.locator('.nat91-control-texture').count() > 15);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow layout must not overflow');
  await page.screenshot({ path: join(out, 'real-ui-mobile-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(out, 'real-ui-mobile-dark.png') });
  assert.deepEqual(errors, [], 'No browser script failures');
  console.log(`Passed: shared light, real tab/session navigation, keyboard focus, reduced motion, both themes, narrow bounds.\nCaptures: ${out}`);
  await context.close();
} finally { await browser.close(); }
