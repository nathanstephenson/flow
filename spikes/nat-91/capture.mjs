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
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(570, 220);
  await page.waitForTimeout(150);
  const revision = await page.evaluate(() => Number(window.nat91Material.canvas.dataset.revision));
  await page.waitForTimeout(200);
  assert.ok(await page.evaluate(() => Number(window.nat91Material.canvas.dataset.revision)) - revision <= 2, 'Material-owned style writes must not create a continuous redraw loop');
  await page.screenshot({ path: join(out, 'real-ui-dark.png') });
  const activeRow = page.locator('[data-sidebar="menu-button"][data-nat91-selected="true"]');
  const idleRailAlpha = await activeRow.locator('.nat91-control-texture').evaluate(texture => {
    const pixels = texture.getContext('2d').getImageData(0, 0, texture.width, texture.height).data;
    let max = 0;
    for (let i = 3; i < pixels.length; i += 4) max = Math.max(max, pixels[i]);
    return max;
  });
  assert.equal(idleRailAlpha, 0, 'The rail must have no static chrome: its gloss overlay is transparent at rest');
  assert.notEqual(await activeRow.evaluate(node => getComputedStyle(node).backgroundColor), await page.locator('[data-sidebar="menu-button"][data-nat91-selected="false"]').first().evaluate(node => getComputedStyle(node).backgroundColor), 'Quiet rows must still have a distinct, full-face selected fill');
  assert.equal(await activeRow.locator('.nat91-adaptive-ink').count(), 0, 'Rail text stays native, not fragmented by material-dependent ink');
  const settle = activeRow.locator('..').getByRole('button', { name: 'Settle', exact: true });
  assert.equal(await settle.locator('.nat91-control-texture').count(), 0, 'Settle must not have an opaque material canvas');
  const material = await page.locator('.nat91-tab-surface[data-nat91-selected="true"] > .nat91-control-texture').first().evaluate(texture => {
    const context = texture.getContext('2d');
    const pixels = context.getImageData(0, 0, texture.width, texture.height).data;
    let min = 255, max = 0, rightChroma = 0, rightCount = 0;
    for (let y = 1; y < texture.height - 1; y += 2) {
      for (let x = 1; x < texture.width - 1; x += 2) {
        const i = (y * texture.width + x) * 4;
        if (pixels[i + 3] < 250) continue;
        const value = pixels[i] * .2126 + pixels[i + 1] * .7152 + pixels[i + 2] * .0722;
        min = Math.min(min, value); max = Math.max(max, value);
        if (x > texture.width * .8) { rightChroma += pixels[i + 2] - pixels[i]; rightCount++; }
      }
    }
    return { min, max, rightChroma: rightChroma / rightCount };
  });
  assert.ok(material.rightChroma > 20, 'Selected material must cover the right side, not fade to the neutral backdrop');
  assert.ok(material.max - material.min > 150, 'Chrome needs genuine bright silver / black reflection contrast, not capped blue glow');
  const activeBounds = await activeRow.boundingBox();
  const railClip = { x: 0, y: activeBounds.y - 12, width: activeBounds.width + 4, height: activeBounds.height + 24 };
  await page.screenshot({ path: join(out, 'real-ui-active-detail.png'), clip: railClip });
  await page.mouse.move(activeBounds.x + 30, activeBounds.y + activeBounds.height * .5);
  await page.waitForTimeout(100);
  const railGlossBefore = await activeRow.locator('.nat91-control-texture').evaluate(texture => texture.toDataURL());
  await page.mouse.move(activeBounds.x + activeBounds.width - 50, activeBounds.y + activeBounds.height * .5);
  await page.waitForTimeout(100);
  assert.notEqual(await activeRow.locator('.nat91-control-texture').evaluate(texture => texture.toDataURL()), railGlossBefore, 'Rail gloss must still follow the pointer');
  await page.screenshot({ path: join(out, 'real-ui-rail-hover.png'), clip: railClip });
  await settle.hover();
  await page.waitForTimeout(100);
  assert.equal(await settle.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'Settle stays transparent even on hover');
  await page.screenshot({ path: join(out, 'real-ui-settle-hover.png'), clip: railClip });
  await activeRow.focus();
  await page.keyboard.press('ArrowRight');
  assert.ok(await settle.evaluate(node => node === document.activeElement && node.matches(':focus-visible') && getComputedStyle(node).boxShadow !== 'none'), 'The native Settle keyboard focus ring must survive');
  await page.mouse.move(570, 220);
  await page.waitForTimeout(100);

  // Real tabs and session navigation, not simulated mockup handlers.
  await page.getByRole('tab', { name: 'Git' }).click();
  await page.getByRole('tab', { name: 'Git', exact: true }).getAttribute('aria-selected').then(value => assert.equal(value, 'true'));
  await page.getByRole('tab', { name: 'Diff', exact: true }).waitFor();
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const refreshBounds = await refresh.boundingBox();
  const rowBefore = await activeRow.locator('.nat91-control-texture').evaluate(texture => texture.toDataURL());
  await page.mouse.move(refreshBounds.x + 10, refreshBounds.y + refreshBounds.height * .5);
  await page.waitForTimeout(100);
  const glossBefore = await refresh.locator('.nat91-control-texture').evaluate(texture => texture.toDataURL());
  await page.mouse.move(refreshBounds.x + refreshBounds.width - 10, refreshBounds.y + refreshBounds.height * .5);
  await page.waitForTimeout(100);
  const glossAfter = await refresh.locator('.nat91-control-texture').evaluate(texture => texture.toDataURL());
  assert.notEqual(glossBefore, glossAfter, 'Button gloss must follow the pointer within that control');
  assert.equal(await activeRow.locator('.nat91-control-texture').evaluate(texture => texture.toDataURL()), rowBefore, 'Hovering a remote button must not relight the selected rail');
  await refresh.hover();
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
  await page.evaluate(() => { document.activeElement?.blur(); document.documentElement.classList.remove('dark'); });
  await page.waitForTimeout(100);
  await page.screenshot({ path: join(out, 'real-ui-light.png') });
  const lightSettle = activeRow.locator('..').getByRole('button', { name: 'Settle', exact: true });
  await lightSettle.hover();
  await page.waitForTimeout(100);
  assert.equal(await lightSettle.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)', 'Settle stays transparent in light mode too');
  const lightBounds = await activeRow.boundingBox();
  await page.screenshot({ path: join(out, 'real-ui-settle-hover-light.png'), clip: { x: 0, y: lightBounds.y - 12, width: lightBounds.width + 4, height: lightBounds.height + 24 } });
  await page.mouse.move(570, 220);
  assert.ok(await page.locator('.nat91-control-texture').count() > 15);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(250);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Narrow layout must not overflow');
  await page.screenshot({ path: join(out, 'real-ui-mobile-light.png') });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await page.waitForTimeout(100);
  const taskTitle = page.locator('.nat91-subagent-notice > .font-mono.text-sm').filter({ hasText: 'Interaction review' });
  assert.ok(await taskTitle.evaluate(node => node.scrollWidth <= node.clientWidth && node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 1), 'Narrow-layout task title must fit on one readable line');
  await page.screenshot({ path: join(out, 'real-ui-mobile-dark.png') });
  assert.deepEqual(errors, [], 'No browser script failures');
  console.log(`Passed: quiet native rail / transparent Settle / native focus ring, full-face chrome tabs, cursor-local gloss / stable remote selection, real tab/session navigation, keyboard focus, reduced motion, both themes, narrow bounds.\nCaptures: ${out}`);
  await context.close();
} finally { await browser.close(); }
