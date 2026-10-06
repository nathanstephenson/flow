// Start preview.mjs first. Playwright is external tooling, not a new Flow dependency.
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs');
const browser = await chromium.launch({
  ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  args: ['--no-sandbox'],
});
const output = resolve(process.env.MOCKUP_SCREENSHOTS ?? 'screenshots/nat-91');
const base = `http://127.0.0.1:${process.env.MOCKUP_PORT ?? 4391}`;
await mkdir(output, { recursive: true });
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 1040 }, deviceScaleFactor: 2 });
page.on('pageerror', error => errors.push(error.message));
page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
try {
  for (const treatment of ['cobalt', 'silver', 'liquid']) {
    await page.setViewportSize({ width: 1440, height: 1040 });
    await page.goto(`${base}/?treatment=${treatment}`, { waitUntil: 'domcontentloaded' });
    await page.locator('.material svg').first().waitFor();
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: `${output}/${treatment}-desktop.png` });
    assert.equal(await page.locator('body').getAttribute('data-treatment'), treatment);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 1440);
    await page.setViewportSize({ width: 1440, height: 670 });
    await page.goto(`${base}/?treatment=${treatment}&view=detail`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => document.fonts.ready);
    const hover = page.locator('#hover-sample');
    const box = await hover.boundingBox();
    await page.mouse.move(box.x + box.width * .7, box.y + 10);
    await page.waitForTimeout(200); // Finish the 160ms hover opacity transition, not a network wait.
    await page.screenshot({ path: `${output}/${treatment}-detail.png` });
    assert.notEqual(await hover.evaluate(el => el.style.getPropertyValue('--light-x')), '');
  }
  await page.setViewportSize({ width: 1440, height: 1040 });
  await page.goto(`${base}/?treatment=cobalt&theme=light`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${output}/cobalt-light.png` });
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('light')), true);
  await page.getByRole('button', { name: '03 Liquid', exact: true }).click();
  assert.equal(await page.locator('body').getAttribute('data-treatment'), 'liquid');
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('light')), false);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const hover = page.locator('#hover-sample');
  await hover.scrollIntoViewIfNeeded();
  const box = await hover.boundingBox();
  await page.mouse.move(box.x + 15, box.y + 15);
  assert.equal(await hover.evaluate(el => el.style.getPropertyValue('--light-x')), '');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 1050 });
  await page.goto(`${base}/?treatment=cobalt`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `${output}/cobalt-mobile.png` });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(errors, []);
  console.log('Captured 8 screenshots; treatment, theme, cursor light, reduced motion, and viewport checks passed.');
} finally {
  await browser.close();
}
