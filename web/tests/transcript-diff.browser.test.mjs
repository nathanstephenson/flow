// Build the stylesheet first: npm run build:web
// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/transcript-diff.browser.test.mjs
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { build } from "esbuild";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const text = "--- a/file\n+++ b/file\n@@ -1,2 +1,2 @@\n context\n-old\n+new\n";
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { parseMarkdown } from '@client/markdown.ts';
      import { Markdown } from '@/components/markdown.tsx';
      import { EditDiffView, ToolPayloadView } from '@/components/edit-diff-view.tsx';
      const text = ${JSON.stringify(text)};
      createRoot(document.getElementById('root')).render(<main className="bg-background text-foreground p-6 space-y-6">
        <section id="diff"><Markdown blocks={parseMarkdown('~~~diff\\n' + text + '~~~')} query="old" /></section>
        <section id="edit"><EditDiffView input={{old_string: 'old', new_string: 'new'}} query="old" /></section>
        <section id="tool"><ToolPayloadView entry={{kind: 'tool', result: text}} query="" /></section>
        <section id="structured"><ToolPayloadView entry={{kind: 'tool', result: {
          content: [{type: 'text', text}], details: {exitCode: 0},
        }}} query="old" /></section>
        <pre id="plain">{text}</pre>
        <section id="crlf"><ToolPayloadView entry={{kind: 'tool', result: text.replaceAll('\\n', '\\r\\n')}} query="" /></section>
        <section id="stream"><Markdown blocks={parseMarkdown('~~~patch\\n-old\\n+streaming')} query=""
          trailing={<span data-caret="true">▍</span>} /></section>
        <section id="long"><Markdown blocks={parseMarkdown('~~~diff\\n-' + 'long'.repeat(200) + '\\n+short\\n~~~')} query="" /></section>
      </main>);
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
const assets = `${root}/web/dist/assets`;
const stylesheet = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
assert.ok(stylesheet, "Run npm run build:web first");
const css = await readFile(`${assets}/${stylesheet}`, "utf8");
let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
  });
});
after(async () => { await browser?.close(); });

for (const theme of ["light", "dark"]) {
  test(`transcript diffs preserve colours, copying and layout in ${theme} mode`, async () => {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    try {
      await page.setContent('<div id="root"></div>', { waitUntil: "domcontentloaded" });
      await page.addStyleTag({ content: css });
      await page.addScriptTag({ content: bundle.outputFiles[0].text });
      await page.locator("#diff pre").waitFor();
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      const metrics = await page.evaluate(() => {
        const colour = (selector) => {
          const style = getComputedStyle(document.querySelector(selector));
          return [style.color, style.backgroundColor];
        };
        const rows = [...document.querySelectorAll("#diff code > span > span")];
        const pre = document.querySelector("#long pre");
        const selectedText = (selector) => {
          const range = document.createRange();
          range.selectNodeContents(document.querySelector(selector));
          const selection = window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          return selection.toString();
        };
        return {
          added: colour("#diff .text-diff-added"), removed: colour("#diff .text-destructive"),
          editAdded: colour("#edit .text-diff-added"), editRemoved: colour("#edit .text-destructive"),
          structuredAdded: colour("#structured .text-diff-added"), structuredRemoved: colour("#structured .text-destructive"),
          structuredCopied: selectedText("#structured pre"),
          structuredMetadata: document.querySelector("#structured").textContent,
          neutral: colour("#diff code > span > span"),
          heights: rows.map((row) => row.getBoundingClientRect().height),
          crlfHeights: [...document.querySelectorAll("#crlf pre > span > span")].map((row) => row.getBoundingClientRect().height),
          crlfText: document.querySelector("#crlf pre").innerText,
          crlfSource: document.querySelector("#crlf pre").textContent,
          copied: selectedText("#tool pre"),
          plainCopied: selectedText("#plain"),
          plainText: document.querySelector("#tool pre").innerText,
          scrollWidth: pre.scrollWidth, width: pre.clientWidth,
          caret: !!document.querySelector("#stream .text-diff-added [data-caret]"),
        };
      });
      assert.deepEqual(metrics.added, metrics.editAdded);
      assert.deepEqual(metrics.removed, metrics.editRemoved);
      assert.deepEqual(metrics.structuredAdded, metrics.editAdded);
      assert.deepEqual(metrics.structuredRemoved, metrics.editRemoved);
      assert.notDeepEqual(metrics.added, metrics.removed);
      assert.notDeepEqual(metrics.added, metrics.neutral);
      // Native selection can drop a terminal newline; colouring must match an unstyled pre.
      assert.equal(metrics.copied, metrics.plainCopied);
      assert.equal(metrics.structuredCopied, metrics.plainCopied);
      assert.ok(metrics.structuredMetadata.includes("exitCode"));
      assert.equal(metrics.plainText, text);
      assert.ok(metrics.heights.every((height) => Math.abs(height - metrics.heights[0]) < 1));
      assert.ok(metrics.crlfHeights.every((height) => Math.abs(height - metrics.crlfHeights[0]) < 1));
      assert.equal(metrics.crlfText, text.replaceAll("\n", "\r\n"));
      assert.equal(metrics.crlfSource, text.replaceAll("\n", "\r\n"));
      assert.ok(metrics.scrollWidth > metrics.width);
      assert.ok(metrics.caret);
    } finally { await page.close(); }
  });
}
