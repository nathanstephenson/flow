import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? '/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs');
const root = process.env.MOCKUP_STATE_DIR;
if (!root) throw new Error('Set MOCKUP_STATE_DIR to the running dev-host.ts state root.');
const token = await readFile(join(root, 'token'), 'utf8');
const { ids, settledId } = JSON.parse(await readFile(join(root, 'study.json'), 'utf8'));
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
  async function checkRailHeadings() {
    const labels = await page.locator('.nat91-session-band [data-sidebar="group-label"]').evaluateAll(labels => labels.map(label => ({ summary: label.tagName === 'SUMMARY', text: label.textContent.trim(), display: getComputedStyle(label).display, height: label.getBoundingClientRect().height })));
    assert.equal(labels.filter(label => !label.summary).length, 4, 'Fixture must exercise all four unfiled status groups');
    assert.ok(labels.filter(label => !label.summary).every(label => label.display === 'none' && label.height === 0), 'Non-Settled headings must be hidden without retaining layout space');
    assert.equal(labels.filter(label => label.summary).length, 1, 'Only the Settled disclosure heading remains');
    assert.match(labels.find(label => label.summary).text, /^Settled\s*·\s*1$/, 'The real disclosure label retains its count');
    assert.equal(await page.locator('[data-sidebar="menu"][aria-label="Settled Agent Sessions"]').count(), 1, 'Settled list must be renamed accessibly as well');
    assert.equal(await page.locator('[data-sidebar="menu"][aria-label="Filed away Agent Sessions"]').count(), 0);
  }
  await checkRailHeadings();
  await page.screenshot({ path: join(out, 'real-ui-dark.png') });
  const activeRow = page.locator('[data-sidebar="menu-button"][data-nat91-selected="true"]');
  const statusLines = await page.locator('[data-sidebar="menu-button"][data-nat91-activity]').evaluateAll(rows => rows.map(row => {
    const dot = row.querySelector('.nat91-activity-dot');
    return { dotDisplay: getComputedStyle(dot).display, color: getComputedStyle(dot).color, line: getComputedStyle(row).borderLeftColor, selected: row.dataset.nat91Selected === 'true', animation: getComputedStyle(row, '::before').animationName };
  }));
  assert.equal(statusLines.length, ids.length, 'Every fixture status dot must have a left-edge replacement');
  assert.equal(statusLines.filter(row => row.animation === 'nat91-rail-flow').length, 1, 'Only the selected Agent Session gets a flowing gradient');
  for (const row of statusLines) {
    assert.equal(row.dotDisplay, 'none', 'Activity dots must leave the visible layout');
    assert.equal(row.line, row.color, 'Each solid status edge must match its original activity hue');
    assert.equal(row.animation, row.selected ? 'nat91-rail-flow' : 'none', 'Inactive Agent Sessions must not animate');
  }
  async function checkStatusPalette(rows) {
    const palette = await rows.evaluateAll(rows => {
      const context = document.createElement('canvas').getContext('2d');
      const rgb = color => { context.clearRect(0, 0, 1, 1); context.fillStyle = color; context.fillRect(0, 0, 1, 1); return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3); };
      const muted = rgb(getComputedStyle(document.documentElement).getPropertyValue('--muted-foreground').trim());
      return rows.map(row => {
        const dot = row.querySelector('.nat91-activity-dot');
        const gradient = getComputedStyle(row, '::before').backgroundImage;
        const stops = [...gradient.matchAll(/color\(srgb ([^)]+)\)/g)].map(match => match[1].split(/[ /]+/).slice(0, 3).map(value => Math.round(Math.max(0, Math.min(1, Number(value))) * 255)));
        return { idle: dot.matches('.text-foreground.bg-current'), dormant: dot.matches('.text-foreground.border-current'), rgb: rgb(getComputedStyle(dot).color), muted, gradient, stops, selected: row.dataset.nat91Selected === 'true', linked: row.style.getPropertyValue('--nat91-activity') === getComputedStyle(dot).color };
      });
    });
    const idle = palette.find(row => row.idle), dormant = palette.find(row => row.dormant);
    assert.ok(idle && dormant, 'Fixture must contain genuine Idle and Dormant rows');
    assert.notDeepEqual(idle.rgb, dormant.rgb, 'Idle and Dormant must not share a colour');
    assert.deepEqual(dormant.rgb, dormant.muted, 'Dormant indicator uses the theme muted grey');
    for (const row of palette.filter(row => row.selected)) {
      assert.ok(row.linked, 'The gradient and edge share the indicator colour variable');
      assert.ok(row.gradient.startsWith('linear-gradient(90deg,'), 'Flow bands must be horizontal');
      assert.equal(row.stops.length, 2, 'Selected gradient must contain both activity-coloured reflection stops');
      for (const stop of row.stops) assert.ok(stop.every((channel, index) => Math.abs(channel - row.rgb[index]) <= 1), 'Both rendered gradient stops must match the indicator RGB');
    }
  }
  await checkStatusPalette(page.locator('[data-sidebar="menu-button"][data-nat91-activity]'));
  const direction = await activeRow.evaluate(node => {
    const animation = node.getAnimations({ subtree: true }).find(animation => animation.animationName === 'nat91-rail-flow');
    const original = animation.currentTime;
    animation.pause();
    animation.currentTime = 1000;
    const first = parseFloat(getComputedStyle(node, '::before').backgroundPositionX);
    animation.currentTime = 2000;
    const second = parseFloat(getComputedStyle(node, '::before').backgroundPositionX);
    const width = node.getBoundingClientRect().width;
    const imageWidth = width * parseFloat(getComputedStyle(node, '::before').backgroundSize) / 100;
    animation.currentTime = original; animation.play();
    return { firstOffset: (width - imageWidth) * first / 100, secondOffset: (width - imageWidth) * second / 100 };
  });
  assert.ok(direction.secondOffset > direction.firstOffset, 'Selected activity reflection must move physically LEFT to RIGHT, not just change its CSS position');
  const flowBefore = await activeRow.evaluate(node => getComputedStyle(node, '::before').backgroundPosition);
  await page.waitForTimeout(250);
  assert.notEqual(await activeRow.evaluate(node => getComputedStyle(node, '::before').backgroundPosition), flowBefore, 'Selected gradient must actually flow over time');
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
  // Cached ink must survive native class resets and direct Text-node updates,
  // not just selection changes or replacement of the whole label element.
  const cachedTab = page.locator('.nat91-tab-surface[data-nat91-selected="true"] > [role="tab"]').first();
  const inkBeforeReset = await page.evaluate(() => window.nat91Material.getStats().inkBuilds);
  await cachedTab.evaluate(node => node.classList.remove('nat91-adaptive-ink'));
  await page.waitForFunction(() => document.querySelector('.nat91-tab-surface[data-nat91-selected="true"] > [role="tab"]')?.classList.contains('nat91-adaptive-ink'));
  assert.ok(await page.evaluate(() => window.nat91Material.getStats().inkBuilds) > inkBeforeReset, 'Native class resets must rebuild cached ink');
  const originalLabel = await cachedTab.evaluate(node => [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.nodeValue.trim()).nodeValue);
  const setLabel = value => cachedTab.evaluate((node, value) => { [...node.childNodes].find(child => child.nodeType === Node.TEXT_NODE && child.nodeValue.trim()).nodeValue = value; }, value);
  const cachedTexture = cachedTab.locator('..').locator(':scope > .nat91-control-texture');
  const waitForInkRevision = before => page.waitForFunction(before => Number(document.querySelector('.nat91-tab-surface[data-nat91-selected="true"] > .nat91-control-texture')?.dataset.revision) > before, before);
  const beforeText = Number(await cachedTexture.getAttribute('data-revision'));
  await setLabel(`${originalLabel} cache probe`);
  await waitForInkRevision(beforeText);
  const beforeRestore = Number(await cachedTexture.getAttribute('data-revision'));
  await setLabel(originalLabel);
  await waitForInkRevision(beforeRestore);
  const activeBounds = await activeRow.boundingBox();
  const railClip = { x: 0, y: activeBounds.y - 12, width: activeBounds.width + 4, height: activeBounds.height + 24 };
  await page.screenshot({ path: join(out, 'real-ui-active-detail.png'), clip: railClip });
  await page.mouse.move(activeBounds.x + 30, activeBounds.y + activeBounds.height * .5);
  await page.waitForTimeout(100);
  const railGlossBefore = await activeRow.locator('.nat91-gloss-spot').evaluate(spot => spot.style.transform);
  await page.mouse.move(activeBounds.x + activeBounds.width - 50, activeBounds.y + activeBounds.height * .5);
  await page.waitForTimeout(100);
  assert.notEqual(await activeRow.locator('.nat91-gloss-spot').evaluate(spot => spot.style.transform), railGlossBefore, 'Composited rail gloss must still follow the pointer');
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
  const glossBefore = await refresh.locator('.nat91-gloss-spot').evaluate(spot => spot.style.transform);
  await page.mouse.move(refreshBounds.x + refreshBounds.width - 10, refreshBounds.y + refreshBounds.height * .5);
  await page.waitForTimeout(100);
  const glossAfter = await refresh.locator('.nat91-gloss-spot').evaluate(spot => spot.style.transform);
  assert.notEqual(glossBefore, glossAfter, 'Button gloss must follow the pointer within that control');
  assert.equal(await activeRow.locator('.nat91-control-texture').evaluate(texture => texture.toDataURL()), rowBefore, 'Hovering a remote button must not relight the selected rail');
  await refresh.hover();
  await page.waitForTimeout(200);
  await page.screenshot({ path: join(out, 'real-ui-git-hover.png') });
  await page.screenshot({ path: join(out, 'real-ui-control-detail.png'), clip: { x: 1090, y: 50, width: 350, height: 380 } });
  await page.getByRole('tab', { name: 'Agents' }).click();
  // Selection, not Running status, owns the animation. Its hue follows the real
  // status indicator on Running and Awaiting rows without animating their peers.
  for (const [index, label, colorClass] of [[1, 'Review the adapter contract', 'text-status-active'], [4, 'Confirm migration', 'text-status-awaiting'], [3, 'Inspect workflow retries', 'text-foreground']]) {
    await page.locator('[data-sidebar="menu-button"]').filter({ hasText: label }).click();
    await page.waitForFunction(id => location.hash.includes(id), ids[index]);
    await activeRow.locator(`.nat91-activity-dot.${colorClass}`).waitFor({ state: 'attached' });
    assert.equal(await activeRow.evaluate(node => getComputedStyle(node, '::before').animationName), 'nat91-rail-flow');
    assert.ok(await activeRow.evaluate(node => node.style.getPropertyValue('--nat91-activity') === getComputedStyle(node.querySelector('.nat91-activity-dot')).color));
    await checkStatusPalette(page.locator('[data-sidebar="menu-button"][data-nat91-activity]'));
    await page.mouse.move(570, 220);
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(out, index === 1 ? 'real-ui-running-flow.png' : index === 4 ? 'real-ui-awaiting-flow.png' : 'real-ui-dormant-flow.png') });
    if (index === 3) {
      await page.evaluate(() => document.documentElement.classList.remove('dark'));
      await page.waitForTimeout(100);
      await checkStatusPalette(page.locator('[data-sidebar="menu-button"][data-nat91-activity]'));
      await page.screenshot({ path: join(out, 'real-ui-dormant-flow-light.png') });
      await page.evaluate(() => document.documentElement.classList.add('dark'));
    }
  }
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
  assert.equal(await activeRow.evaluate(node => getComputedStyle(node, '::before').animationName), 'none', 'Reduced motion stops the flowing gradient');
  const flowStill = await activeRow.evaluate(node => getComputedStyle(node, '::before').backgroundPosition);
  await page.waitForTimeout(250);
  assert.equal(await activeRow.evaluate(node => getComputedStyle(node, '::before').backgroundPosition), flowStill, 'Reduced-motion gradient remains static');
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
  await page.locator('[data-sidebar="trigger"]').click();
  const drawerRows = page.locator('[data-sidebar="menu-button"][data-nat91-activity]');
  await drawerRows.first().waitFor();
  assert.equal(await drawerRows.count(), ids.length, 'The portalled mobile drawer must also replace every status dot');
  for (const dark of [true, false]) {
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
    await page.waitForTimeout(200);
    const linesMatch = await drawerRows.evaluateAll(rows => rows.every(row => getComputedStyle(row).borderLeftColor === getComputedStyle(row.querySelector('.nat91-activity-dot')).color && getComputedStyle(row.querySelector('.nat91-activity-dot')).display === 'none'));
    assert.ok(linesMatch, 'Status edges must follow theme changes in the portalled mobile drawer');
    await checkStatusPalette(drawerRows);
    await checkRailHeadings();
    assert.equal(await activeRow.evaluate(node => getComputedStyle(node, '::before').animationName), 'nat91-rail-flow');
    await page.screenshot({ path: join(out, dark ? 'real-ui-mobile-rail-dark.png' : 'real-ui-mobile-rail-light.png') });
  }
  // Exercise a status-colour update entirely inside the body portal: the old
  // root-only observer missed these changes until another interaction occurred.
  const portalHueBefore = await activeRow.evaluate(node => node.style.getPropertyValue('--nat91-activity'));
  await activeRow.locator('.nat91-activity-dot').evaluate(dot => { dot.style.color = 'var(--status-active)'; });
  await page.waitForFunction(before => {
    const row = document.querySelector('[data-sidebar="menu-button"][data-nat91-selected="true"]');
    return row.style.getPropertyValue('--nat91-activity') !== before && getComputedStyle(row).borderLeftColor === getComputedStyle(row.querySelector('.nat91-activity-dot')).color;
  }, portalHueBefore);
  await activeRow.locator('.nat91-activity-dot').evaluate(dot => dot.style.removeProperty('color'));
  await page.waitForFunction(before => document.querySelector('[data-sidebar="menu-button"][data-nat91-selected="true"]').style.getPropertyValue('--nat91-activity') === before, portalHueBefore);
  assert.ok(settledId, 'Use a fresh dev-host fixture with a genuine Settled Agent Session');
  const disclosure = page.locator('.nat91-session-band summary');
  const settledMenu = page.locator('[data-sidebar="menu"][aria-label="Settled Agent Sessions"]');
  assert.equal(await settledMenu.isVisible(), false, 'Settled rows start collapsed');
  await disclosure.focus(); await page.keyboard.press('Space');
  await settledMenu.waitFor();
  assert.equal(await settledMenu.getByRole('button', { name: /Review complete/ }).count(), 1, 'Opening the original disclosure reveals the real Settled row');
  await disclosure.focus(); await page.keyboard.press('Space');
  await settledMenu.waitFor({ state: 'hidden' });
  // Simulate React updating the native summary's text/count. No API mutation:
  // the observer must rename it again without replacing its chevron or text nodes.
  const originals = await disclosure.evaluate(summary => {
    const texts = [...summary.childNodes].filter(node => node.nodeType === Node.TEXT_NODE);
    const original = texts.map(node => node.nodeValue);
    texts.find(node => node.nodeValue.includes('Settled')).nodeValue = 'Filed away · ';
    texts.find(node => node.nodeValue.trim() === '1').nodeValue = '2';
    return original;
  });
  await page.waitForFunction(() => /Settled\s*·\s*2/.test(document.querySelector('.nat91-session-band summary').textContent));
  await disclosure.evaluate((summary, originals) => [...summary.childNodes].filter(node => node.nodeType === Node.TEXT_NODE).forEach((node, index) => { node.nodeValue = originals[index]; }), originals);
  await checkRailHeadings();
  await disclosure.click(); await settledMenu.waitFor();
  await page.waitForFunction(() => !document.querySelector('.nat91-session-band summary svg').classList.contains('-rotate-90'));
  await disclosure.evaluate(summary => summary.blur());
  await page.screenshot({ path: join(out, 'real-ui-settled-mobile-light.png') });
  await page.setViewportSize({ width: 1440, height: 980 });
  await page.waitForTimeout(250);
  if (!await settledMenu.isVisible()) await disclosure.click();
  for (const dark of [true, false]) {
    await page.evaluate(dark => document.documentElement.classList.toggle('dark', dark), dark);
    await page.waitForTimeout(150);
    await checkRailHeadings();
    await page.screenshot({ path: join(out, dark ? 'real-ui-settled-dark.png' : 'real-ui-settled-light.png') });
  }
  await page.locator('[data-sidebar="footer"]').getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('[data-sidebar="menu"][aria-label="Settings sections"]').waitFor();
  assert.equal(await page.locator('.nat91-session-band').count(), 0, 'Session heading treatment must not mark Settings navigation');
  assert.ok(await page.locator('[data-sidebar="header"]').getByText('Settings', { exact: true }).isVisible(), 'Settings header stays visible');
  assert.deepEqual(errors, [], 'No browser script failures');
  console.log(`Passed: status headings removed without gaps / native Settled disclosure and accessible list name / keyboard collapse and live count updates, distinct Idle/Dormant hues / indicator-matched gradient stops / physical left-to-right flow / reduced-motion static gradient, transparent Settle / native focus ring, full-face chrome tabs, cursor-local gloss / stable remote selection, real tab/session navigation, keyboard focus, reduced motion, both themes, narrow bounds.\nCaptures: ${out}`);
  await context.close();
} finally { await browser.close(); }
