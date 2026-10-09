import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { build as buildWeb } from "vite";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const scope = "/tmp/project with spaces";
const modelName = "Fixture reasoning model with an exceptionally long descriptive name ".repeat(3).trim();
const branchName = `flow/ENG-123-mobile-composer-${"long-branch-description-".repeat(12)}`;
const nextBranch = `flow/ENG-124-${"another-long-branch-description-".repeat(10)}`;
const models = [
  { id: "fixture-long", provider: "fixture", label: modelName, effortLevels: ["low", "high"] },
  { id: "fixture-other", provider: "fixture", label: "Other fixture model", effortLevels: ["low", "high"] },
];
const output = await buildWeb({
  configFile: `${root}/web/vite.config.ts`,
  logLevel: "silent",
  build: { write: false },
});
const css = (Array.isArray(output) ? output : [output])
  .flatMap(result => result.output)
  .filter(asset => asset.fileName.endsWith(".css"))
  .map(asset => asset.source).join("\n");
assert.ok(css.includes(".pane-measure"));
const bundle = await build({
  stdin: {
    contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { Composer } from './web/src/components/composer.tsx';
      import { HostProvider } from './web/src/host.tsx';
      import { TooltipProvider } from './web/src/components/ui/tooltip.tsx';
      import { useDraftStash } from './web/src/drafts.ts';
      const models = ${JSON.stringify(models)};
      window.calls = [];
      function Harness() {
        const [chrome, setChrome] = useState({
          status: 'idle', backend: 'pi', scope: ${JSON.stringify(scope)},
          capabilities: {
            providers: ['fixture'], models, compaction: true, fork: false,
            subagents: false, enquiries: false, permissions: true,
          },
          model: models[0], effort: 'low', permissionMode: 'always',
          branch: { name: ${JSON.stringify(branchName)} }, worktree: true,
          contextUsage: { used: 50000, window: 200000 },
          queueDepth: 0, activeSubagents: 0, activeBackgroundCalls: 0,
          compacting: false, spoken: false, link: 'live',
          asking: undefined, authorising: undefined, endedReason: undefined,
        });
        const [controls, setControls] = useState(undefined);
        const drafts = useDraftStash(['fixture']);
        window.configure = ({ status, controls, catalogue }) => flushSync(() => {
          if (status) setChrome(current => ({ ...current, status }));
          if (catalogue) setChrome(current => ({ ...current, capabilities: {
            ...current.capabilities,
            models: [...models, ...Array.from({ length: 32 }, (_, index) => ({
              id: 'extra-' + index, provider: 'fixture', label: 'Extra model ' + index,
            }))],
          } }));
          setControls(controls);
        });
        window.values = {
          model: chrome.model.id, effort: chrome.effort,
          permissions: chrome.permissionMode, branch: chrome.branch.name,
        };
        const actions = {
          send: async () => { window.calls.push(['send']); return {}; },
          abort: async () => {}, listSkills: async () => [],
          setModel: id => {
            window.calls.push(['model', id]);
            setChrome(current => ({ ...current, model: models.find(model => model.id === id) }));
          },
          setEffort: effort => {
            window.calls.push(['effort', effort]);
            setChrome(current => ({ ...current, effort }));
          },
          setPermissionMode: permissionMode => {
            window.calls.push(['permissions', permissionMode]);
            setChrome(current => ({ ...current, permissionMode }));
          },
          switchBranch: async name => {
            window.calls.push(['branch', name]);
            setChrome(current => ({ ...current, branch: { name } }));
            return true;
          },
        };
        return <main className="relative h-dvh" aria-label="Composer fixture">
          <Composer id="fixture" chrome={chrome} actions={actions} drafts={drafts}
            controls={controls} inputLabel="Draft" authorisingSummary={undefined}
            onShowSubagents={() => {}} />
        </main>;
      }
      createRoot(document.getElementById('root')).render(
        <HostProvider><TooltipProvider><Harness /></TooltipProvider></HostProvider>
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

describe("Composer turn options", () => {
  let browser;
  let page;
  let errors;
  let branchRequests;
  const pane = () => page.getByRole("main", { name: "Composer fixture" });
  const panel = () => pane().locator(".pane-measure");
  const editor = () => pane().locator(".cm-content");
  const trigger = () => pane().getByRole("button", { name: "Turn options", exact: true });
  const dialog = () => page.getByRole("dialog", { name: "Turn options", exact: true });
  const meter = container => container.locator('span[aria-hidden]').filter({ has: page.locator('span[style*="width"]') });
  const configure = options => page.evaluate(options => window.configure(options), options);
  const settle = locator => locator.evaluate(async element => {
    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  const noOverflow = async locator => {
    const size = await locator.evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    assert.ok(size.scroll <= size.client + 1, `Horizontal overflow: ${JSON.stringify(size)}`);
  };
  const inside = async (child, parent) => {
    const box = await child.boundingBox();
    const bounds = await parent.boundingBox();
    assert.ok(box && bounds, "Expected visible control");
    assert.ok(box.x >= bounds.x - 1 && box.x + box.width <= bounds.x + bounds.width + 1,
      `Control outside container: ${JSON.stringify({ box, bounds })}`);
  };
  const separate = async (left, right) => {
    const a = await left.boundingBox();
    const b = await right.boundingBox();
    assert.ok(a && b, "Expected visible elements");
    assert.ok(a.x + a.width <= b.x + 1 || b.x + b.width <= a.x + 1 ||
      a.y + a.height <= b.y + 1 || b.y + b.height <= a.y + 1,
    `Elements overlap: ${JSON.stringify({ a, b })}`);
  };
  const open = async () => {
    await trigger().click();
    await dialog().waitFor();
    await settle(dialog());
  };
  const choose = async (name, value) => {
    await dialog().getByRole("combobox", { name, exact: true }).click();
    await page.getByRole("option", { name: value, exact: true }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
  };
  before(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}),
    });
  });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    errors = [];
    branchRequests = [];
    page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: "reduce" });
    page.setDefaultTimeout(5000);
    page.on("pageerror", error => errors.push(error.message));
    await page.route("http://flow.test/**", async route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/") {
        await route.fulfill({ contentType: "text/html", body: '<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div>' });
      } else if (url.pathname === "/api/config") {
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({ scope, backends: ["pi"] }) });
      } else if (url.pathname === "/api/branches") {
        branchRequests.push(url.searchParams.get("scope"));
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({
          scope, repository: true, branches: [branchName, nextBranch], head: { name: branchName },
        }) });
      } else {
        await route.abort();
      }
    });
    await page.goto("http://flow.test/", { waitUntil: "domcontentloaded" });
    await page.addStyleTag({ content: css });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await editor().waitFor();
  });
  afterEach(async () => {
    await page?.close();
    assert.deepEqual(errors, []);
  });

  for (const width of [320, 390, 768]) {
    for (const theme of ["light", "dark"]) {
      it(`fits ${width}px ${theme} and changes turn options without losing the Draft`, async () => {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(theme => document.documentElement.classList.toggle("dark", theme === "dark"), theme);
        await trigger().waitFor();
        assert.equal(await pane().getByRole("combobox").count(), 0);
        const summary = pane().getByText(modelName, { exact: true });
        await summary.waitFor();
        assert.equal(await meter(pane()).count(), 1);
        await pane().getByText("context 25%", { exact: true }).waitFor({ state: "attached" });
        const truncated = await summary.evaluate(element => {
          for (let node = element; node && !node.classList.contains("pane-measure"); node = node.parentElement) {
            const style = getComputedStyle(node);
            if (style.textOverflow === "ellipsis" && node.scrollWidth > node.clientWidth) return true;
          }
          return false;
        });
        assert.equal(truncated, true, "Long model summary must be truncated");
        await noOverflow(panel());
        await noOverflow(page.locator("html"));
        await inside(summary, panel());
        await inside(meter(pane()), panel());
        await separate(summary, meter(pane()));
        const send = pane().getByRole("button", { name: "Send this message", exact: true });
        await separate(trigger(), send);
        await separate(editor(), trigger());
        const optionsBox = await trigger().boundingBox();
        const sendBox = await send.boundingBox();
        assert.ok(Math.abs(optionsBox.y + optionsBox.height / 2 - sendBox.y - sendBox.height / 2) < 2,
          "Turn options must sit beside Send");
        await editor().click();
        await page.keyboard.type("Keep this unsent Draft");
        await open();
        assert.equal(await dialog().getAttribute("data-side"), "bottom");
        const drawerBox = await dialog().boundingBox();
        assert.ok(Math.abs(drawerBox.y + drawerBox.height - 900) < 1, "Sheet must sit at the bottom");
        await noOverflow(dialog());
        assert.equal(await dialog().getByRole("combobox").count(), 4);
        let previousBottom = 0;
        for (const name of ["Model", "Effort", "Permissions", "Branch"]) {
          const control = dialog().getByRole("combobox", { name, exact: true });
          const label = dialog().getByText(name, { exact: true });
          const labelBox = await label.boundingBox();
          const controlBox = await control.boundingBox();
          assert.ok(labelBox.y >= previousBottom && labelBox.y + labelBox.height <= controlBox.y + 1,
            `${name} must have a visible label above its control`);
          previousBottom = controlBox.y + controlBox.height;
          await inside(control, dialog());
        }
        await dialog().getByText("25% · 50k/200k tokens", { exact: true }).waitFor();
        assert.equal(await meter(dialog()).count(), 1);
        await choose("Effort", "high");
        await choose("Permissions", "Ask");
        await choose("Branch", nextBranch);
        await inside(dialog().getByRole("combobox", { name: "Branch", exact: true }), dialog());
        await noOverflow(dialog());
        await choose("Model", models[1].label);
        assert.deepEqual(await page.evaluate(() => window.values), {
          model: models[1].id, effort: "high", permissions: "ask", branch: nextBranch,
        });
        assert.deepEqual(branchRequests, [scope]);
        assert.deepEqual(await page.evaluate(() => window.calls), [
          ["effort", "high"], ["permissions", "ask"], ["branch", nextBranch], ["model", models[1].id],
        ]);
        assert.equal(await editor().textContent(), "Keep this unsent Draft");
        await page.keyboard.press("Escape");
        await dialog().waitFor({ state: "hidden" });
        await pane().getByText(models[1].label, { exact: true }).waitFor();
        assert.equal(await editor().textContent(), "Keep this unsent Draft");
        assert.equal(await trigger().evaluate(element => document.activeElement === element), true);
      });
    }
  }

  it("filters a large model catalogue inside the drawer", async () => {
    await configure({ catalogue: true });
    await open();
    const model = dialog().locator('[data-slot="combobox-trigger"]');
    await inside(model, dialog());
    await noOverflow(dialog());
    await model.click();
    await page.getByPlaceholder("Filter 34 models").fill("Other fixture");
    await page.getByRole("option", { name: models[1].label, exact: true }).click();
    await page.getByRole("listbox").waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => window.values.model), models[1].id);
    await dialog().waitFor();
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "hidden" });
    await pane().getByText(models[1].label, { exact: true }).waitFor();
  });

  it("closes with Escape and returns focus to Turn options", async () => {
    await open();
    await dialog().getByRole("combobox", { name: "Effort", exact: true }).focus();
    await page.keyboard.press("Escape");
    await dialog().waitFor({ state: "hidden" });
    assert.equal(await trigger().evaluate(element => document.activeElement === element), true);
  });

  it("closes on desktop resize and returns the TurnStrip at the 1024px boundary", async () => {
    await page.setViewportSize({ width: 1023, height: 900 });
    await editor().click();
    await page.keyboard.type("Draft survives resize");
    await open();
    await dialog().getByRole("combobox", { name: "Branch", exact: true }).focus();
    await page.setViewportSize({ width: 1024, height: 900 });
    await dialog().waitFor({ state: "hidden" });
    await trigger().waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("dialog", { name: "Turn options", includeHidden: true }).count(), 0);
    for (const name of ["Model", "Effort", "Permissions", "Branch"]) {
      await pane().getByRole("combobox", { name, exact: true }).waitFor();
    }
    assert.equal(await meter(pane()).count(), 1);
    assert.equal(await editor().textContent(), "Draft survives resize");
    assert.equal(await editor().evaluate(element => document.activeElement === element), true);
    await page.setViewportSize({ width: 390, height: 900 });
    await trigger().waitFor();
    assert.equal(await dialog().count(), 0);
    assert.equal(await pane().getByRole("combobox").count(), 0);
  });

  it("disables Permissions and Branch while Running on mobile and desktop", async () => {
    await configure({ status: "running" });
    await open();
    for (const name of ["Permissions", "Branch"]) {
      assert.equal(await dialog().getByRole("combobox", { name, exact: true }).isDisabled(), true);
    }
    for (const name of ["Model", "Effort"]) {
      assert.equal(await dialog().getByRole("combobox", { name, exact: true }).isEnabled(), true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog().waitFor({ state: "hidden" });
    for (const name of ["Permissions", "Branch"]) {
      assert.equal(await pane().getByRole("combobox", { name, exact: true }).isDisabled(), true);
    }
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    assert.deepEqual(branchRequests, []);
  });

  it("respects hidden Permissions and Branch and disabled model controls in both layouts", async () => {
    await configure({ controls: { permissions: false, branches: false, disabled: true } });
    await open();
    for (const name of ["Permissions", "Branch"]) {
      assert.equal(await dialog().getByRole("combobox", { name, exact: true }).count(), 0);
      assert.equal(await dialog().getByText(name, { exact: true }).count(), 0);
    }
    for (const name of ["Model", "Effort"]) {
      assert.equal(await dialog().getByRole("combobox", { name, exact: true }).isDisabled(), true);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog().waitFor({ state: "hidden" });
    for (const name of ["Permissions", "Branch"]) {
      assert.equal(await pane().getByRole("combobox", { name, exact: true }).count(), 0);
    }
    for (const name of ["Model", "Effort"]) {
      assert.equal(await pane().getByRole("combobox", { name, exact: true }).isDisabled(), true);
    }
    assert.deepEqual(await page.evaluate(() => window.calls), []);
    assert.deepEqual(branchRequests, []);
  });
});
