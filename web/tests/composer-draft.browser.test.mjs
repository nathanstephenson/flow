// PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node --test web/tests/composer-draft.browser.test.mjs
// Set PLAYWRIGHT_BROWSER=chromium|firefox|webkit to select one engine.
import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const playwright = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const browsers = process.env.PLAYWRIGHT_BROWSER ? [process.env.PLAYWRIGHT_BROWSER] : ["chromium", "firefox", "webkit"];
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React, { useRef, useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Composer } from './web/src/components/composer.tsx';
      import { HostProvider } from './web/src/host.tsx';
      import { SessionsProvider } from './web/src/agent-sessions.tsx';
      import { TooltipProvider } from './web/src/components/ui/tooltip.tsx';
      import { useDraftStash } from './web/src/drafts.ts';
      import { EditorView } from '@codemirror/view';
      window.editorText = () => EditorView.findFromDOM(document.querySelector('.cm-editor')).state.doc.toString();
      const actions = {
        send: async (text) => { window.sent.push(text); return {}; }, abort: async () => {},
        listSkills: async () => [], setModel() {}, setEffort() {},
      };
      window.sent = [];
      function Harness() {
        const [status, setStatus] = useState('idle');
        const [asking, setAsking] = useState();
        const [mounted, setMounted] = useState(true);
        const composer = useRef(null);
        const drafts = useDraftStash(['fixture']);
        window.renderStatus = (status) => flushSync(() => setStatus(status));
        window.setAsking = (asking) => flushSync(() => setAsking(asking));
        window.setMounted = (mounted) => flushSync(() => setMounted(mounted));
        window.append = (block) => composer.current.append(block);
        window.readDraft = () => drafts.read('fixture').text;
        const chrome = {
          status, backend: 'pi', scope: '/tmp/project', queueDepth: 0, asking,
          activeSubagents: 0, activeBackgroundCalls: 0, compacting: false, spoken: false,
          model: { id: 'fixture', label: 'Fixture model' },
          capabilities: { models: [{ id: 'fixture' }] },
        };
        return <main data-pane className="relative h-96" aria-label="Agent Session pane">
          {mounted ? <Composer handle={composer} id="fixture" chrome={chrome} actions={actions} drafts={drafts} authorisingSummary={undefined} /> : null}
        </main>;
      }
      createRoot(document.getElementById('root')).render(
        <HostProvider><SessionsProvider><TooltipProvider><Harness /></TooltipProvider></SessionsProvider></HostProvider>
      );
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
});

const relay = { askId: "relay", context: "Workflow asks", questions: [{ header: "Q", question: "Which?", multiSelect: false, options: [{ label: "A", description: "" }] }] };

for (const browserName of browsers) describe(`${browserName}: Composer Add to Draft`, () => {
  let browser;
  let page;
  let errors;
  const input = () => page.locator(".cm-content");
  const text = () => page.evaluate(() => window.editorText());
  before(async () => {
    browser = await playwright[browserName].launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    errors = [];
    page = await browser.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://flow.test/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/") await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      else if (path === "/api/config" || path === "/api/sessions") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(path === "/api/config" ? { scope: "/tmp/project", backends: ["pi"] } : []) });
      } else await route.abort();
    });
    await page.goto("http://flow.test/", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await input().waitFor();
  });
  afterEach(async () => {
    await page?.close();
    assert.deepEqual(errors, []);
  });

  it("appends after typed text, keeps the caret, focuses the input and sends nothing", async () => {
    await input().click();
    await page.keyboard.type("typed");
    await page.keyboard.press("Home");
    await page.evaluate(() => document.activeElement.blur());
    await page.evaluate(() => window.append("block"));
    assert.equal(await text(), "typed\n\nblock");
    assert.ok(await page.evaluate(() => document.activeElement?.closest(".cm-editor") !== null));
    await page.keyboard.type("X");
    assert.equal(await text(), "Xtyped\n\nblock");
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  });

  for (const status of ["dormant", "running"]) it(`appends while the Agent Session is ${status}`, async () => {
    await page.evaluate(status => window.renderStatus(status), status);
    await page.evaluate(() => { window.append("one"); window.append("two"); });
    assert.equal(await text(), "one\n\ntwo");
    assert.deepEqual(await page.evaluate(() => window.sent), []);
  });

  it("appends to the held Draft during a Workflow relay, and gives it back when the relay closes", async () => {
    await input().click();
    await page.keyboard.type("mine");
    await page.evaluate(relay => window.setAsking(relay), relay);
    await page.keyboard.type("answer");
    await page.evaluate(() => window.append("block"));
    assert.equal(await text(), "answer");
    await page.evaluate(() => window.setMounted(false));
    assert.equal(await page.evaluate(() => window.readDraft()), "mine\n\nblock");
    await page.evaluate(() => window.setMounted(true));
    await page.evaluate(() => window.setAsking(undefined));
    assert.equal(await text(), "mine\n\nblock");
  });

  it("keeps the appended text in the Draft stash after unmount", async () => {
    await page.evaluate(() => window.append("block"));
    await page.evaluate(() => window.setMounted(false));
    assert.equal(await page.evaluate(() => window.readDraft()), "block");
  });
});
