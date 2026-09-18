import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const url = process.env.FLOW_WEB_URL ?? 'http://127.0.0.1:5173';
const token = (await readFile(`${process.env.FLOW_STATE_DIR}/token`, 'utf8')).trim();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  const page = await browser.newPage();
  await page.goto(`${url}/auth?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' });
  await page.locator('#root > *').waitFor();
  assert.ok(await page.evaluate(async () => {
    const fonts = await document.fonts.load('14px "Inter Variable"');
    await document.fonts.ready;
    return fonts.length > 0 && fonts.every((font) => font.status === 'loaded');
  }), 'Inter must load before layout checks');
  await page.evaluate(async () => {
    const { default: { createElement: h } } = await import('/node_modules/.vite/deps/react.js');
    const { default: { createRoot } } = await import('/node_modules/.vite/deps/react-dom_client.js');
    const { TranscriptView } = await import('/src/components/transcript-view.tsx');
    const long = 'long_identifier_'.repeat(30);
    const entries = [
      { kind: 'assistant', text: `Normal prose must wrap within the transcript. ${long}\n\n\`\`\`text\n${long}\n\`\`\``, final: true },
      { kind: 'notice', level: 'info', text: `Workflow input requested. ${long}` },
      { kind: 'tool', name: `workflow_relay_enquiry_${long}`, input: { requestId: long }, status: 'complete' },
      { kind: 'enquiry', status: 'answered', questions: [{ question: `Preserve Drafts and browser Back? ${long}` }], answers: [[long]] },
      { kind: 'subagent', name: long, description: 'Review the changes', status: 'complete' },
      { kind: 'user', text: long },
      { kind: 'thinking', text: long, final: true },
      { kind: 'background_call', tool: long, status: 'complete', startedAt: '2026-09-18T10:00:00Z', endedAt: '2026-09-18T10:01:00Z' },
    ];
    const keys = entries.map((_, index) => `fixture-${index}`);
    const view = {
      sessionId: 'layout-fixture', getKeys: () => keys,
      getEntry: (key) => entries[keys.indexOf(key)], subscribeTranscript: () => () => {},
    };
    document.getElementById('root').style.display = 'none';
    const fixture = document.createElement('section');
    fixture.id = 'transcript-layout-fixture';
    fixture.className = 'grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)]';
    fixture.style.height = '100dvh';
    document.body.append(fixture);
    createRoot(fixture).render(h(TranscriptView, { view, query: '' }));
  });
  await page.locator('#transcript-layout-fixture pre').first().waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
    for (const width of [360, 390, 800, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      const dimensions = await page.locator('#transcript-layout-fixture').evaluate((fixture) => {
        const scroller = fixture.querySelector('.transcript-scroller');
        const pre = fixture.querySelector('pre');
        return {
          width: fixture.clientWidth, transcript: scroller.getBoundingClientRect().width,
          scroll: scroller.scrollWidth, client: scroller.clientWidth,
          codeScroll: pre.scrollWidth, codeClient: pre.clientWidth,
        };
      });
      assert.ok(dimensions.transcript <= dimensions.width, `${theme} ${width}px: transcript exceeds pane ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.scroll <= dimensions.client + 1, `${theme} ${width}px: transcript content overflows ${JSON.stringify(dimensions)}`);
      assert.ok(dimensions.codeScroll > dimensions.codeClient, 'Wide code must scroll locally');
      if (process.env.SCREENSHOT_DIR && width === 390) {
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/transcript-${theme}.png` });
      }
    }
  }
  console.log('Transcript layout passed: 360, 390, 800, 1280px; light and dark.');
} finally {
  await browser.close();
}
