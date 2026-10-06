// Start preview.mjs first. Playwright is external tooling, not a Flow dependency.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox'],
});
const output = resolve(process.env.MOCKUP_SCREENSHOTS ?? 'screenshots/nat-91-round-02');
const base = `http://127.0.0.1:${process.env.MOCKUP_PORT ?? 4391}`;
await mkdir(output, { recursive: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1290 }, deviceScaleFactor: 2 });
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
async function navigate(query = '') {
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.locator('body[data-rendered=true]').waitFor();
}
async function checkBounds(width) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
  for (const swatch of await page.locator('.study:not([hidden]) .swatch').all()) {
    assert.equal(await swatch.evaluate(el => {
      const surface = el.parentElement.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      return rect.left >= surface.left - 1 && rect.right <= surface.right + 1 && rect.height > 0;
    }), true);
  }
}
const pixels = canvas => canvas.evaluate(el => el.toDataURL());
try {
  await navigate();
  await checkBounds(1440);
  await page.screenshot({ path: `${output}/brushed-comparison-dark.png`, fullPage: true });
  await page.getByRole('button', { name: 'Light backdrop', exact: true }).click();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('light')), true);
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `${output}/brushed-comparison-light.png`, fullPage: true });

  for (const material of ['silver', 'cobalt', 'graphite']) {
    await page.setViewportSize({ width: 1440, height: 740 });
    await navigate(`?material=${material}`);
    assert.equal(await page.locator('.study:not([hidden])').count(), 1);
    assert.equal(await page.locator('.study:not([hidden])').getAttribute('data-material'), material);
    const hover = page.locator('.study:not([hidden]) .hover-control');
    const canvas = hover.locator('canvas');
    const baseline = await pixels(canvas);
    const box = await hover.boundingBox();
    await page.mouse.move(box.x + box.width * .8, box.y + box.height / 2);
    await page.waitForFunction(() => document.querySelector('.study:not([hidden]) .hover-control').dataset.light !== undefined);
    assert.notEqual(await pixels(canvas), baseline);
    await page.waitForTimeout(200); // Finish the 160ms hover-opacity transition.
    await page.screenshot({ path: `${output}/brushed-${material}-closeup.png`, fullPage: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.querySelector('.study:not([hidden]) .hover-control').dataset.light === undefined);
    const reduced = await pixels(canvas);
    await page.mouse.move(box.x + 12, box.y + 12);
    assert.equal(await pixels(canvas), reduced);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await hover.dispatchEvent('pointermove', { pointerType: 'touch', clientX: box.x + 20, clientY: box.y + 20 });
    assert.equal(await pixels(canvas), reduced);
    await checkBounds(1440);
  }
  // Actual keyboard focus, not a permanently painted example ring.
  await navigate('?material=cobalt');
  await page.mouse.move(0, 0);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Light backdrop', exact: true }).evaluate(el => el.matches(':focus-visible')), true);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button', { name: 'Shell 1', exact: true }).evaluate(el => el.matches(':focus-visible')), true);
  assert.equal(await page.getByRole('button', { name: 'Shell 1', exact: true }).evaluate(el => getComputedStyle(el).outlineStyle), 'solid');

  await page.setViewportSize({ width: 390, height: 844 });
  await navigate();
  await checkBounds(390);
  await page.screenshot({ path: `${output}/brushed-comparison-narrow.png`, fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Captured six material studies; pixel-change, reduced-motion, touch, keyboard-focus, theme, bounds, and asset checks passed.');
} finally {
  await browser.close();
}
