import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ProvidersSettings } from './web/src/components/settings-providers.tsx';
      import { HostProvider } from './web/src/host.tsx';
      createRoot(document.getElementById('root')).render(<HostProvider><ProvidersSettings /></HostProvider>);
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

describe("per-backend auto-compaction settings", () => {
  let browser;
  let page;
  let saved;
  let patches;
  before(async () => { browser = await chromium.launch({ headless: true }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    saved = { scope: "/tmp/project", backends: ["pi"], providers: {} };
    patches = [];
    page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    await page.route("http://flow.test/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === "/") await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
      else if (path === "/api/config" && request.method() === "GET") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(saved) });
      } else if (path === "/api/config" && request.method() === "PUT") {
        const patch = request.postDataJSON();
        patches.push(patch);
        saved.providers.autoCompaction = patch.providers.autoCompaction.pi === null
          ? undefined
          : { pi: patch.providers.autoCompaction.pi };
        saved.providers.compactionModels = patch.providers.compactionModels?.pi
          ? { pi: patch.providers.compactionModels.pi } : undefined;
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ providers: saved.providers }) });
      } else if (path === "/api/models") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify([{
          backend: "pi", autoCompaction: "model-change",
          models: [{ id: "p/one", contextWindow: 16384 }, { id: "p/two" }],
        }]) });
      } else await route.abort();
    });
    await page.goto("http://flow.test/");
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator("details summary").click();
    await page.getByRole("combobox", { name: "pi Auto-compaction mode" }).waitFor();
  });
  afterEach(async () => { await page?.close(); });

  it("saves without choosing a model, restores on remount, and clears the override", async () => {
    const mode = page.getByRole("combobox", { name: "pi Auto-compaction mode" });
    assert.equal(await page.getByRole("combobox", { name: "pi Auto-compaction model" }).count(), 0);
    await mode.click();
    await page.getByRole("option", { name: "Enabled with target" }).click();
    await page.getByRole("spinbutton", { name: "pi Auto-compaction target percentage" }).fill("75");
    await page.getByRole("combobox", { name: "pi Compaction Model" }).click();
    await page.getByRole("option", { name: "p/one" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    assert.deepEqual(patches.at(-1), { providers: { autoCompaction: { pi: { mode: "enabled", targetPercent: 75 } }, compactionModels: { pi: "p/one" } } });
    await page.reload();
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.locator("details summary").click();
    assert.match(await page.getByRole("combobox", { name: "pi Auto-compaction mode" }).textContent(), /Enabled with target/);
    assert.equal(await page.getByRole("spinbutton", { name: "pi Auto-compaction target percentage" }).inputValue(), "75");
    assert.match(await page.getByRole("combobox", { name: "pi Compaction Model" }).textContent(), /p\/one/);
    await page.getByRole("combobox", { name: "pi Auto-compaction mode" }).click();
    await page.getByRole("option", { name: "Use backend default" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    assert.deepEqual(patches.at(-1), { providers: { autoCompaction: { pi: null }, compactionModels: { pi: "p/one" } } });
    await page.getByRole("combobox", { name: "pi Compaction Model" }).click();
    await page.getByRole("option", { name: "Use current model" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).last().click();
    assert.deepEqual(patches.at(-1), { providers: { autoCompaction: { pi: null }, compactionModels: { pi: "" } } });
  });
});
