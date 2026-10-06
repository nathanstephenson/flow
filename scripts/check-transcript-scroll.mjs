import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Run against this worktree's Vite client and an isolated Session Host, like check-transcript-layout.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.env.FLOW_WEB_URL ?? "http://127.0.0.1:5173";
const token = (await readFile(`${process.env.FLOW_STATE_DIR}/token`, "utf8")).trim();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
try {
  for (const theme of ["light", "dark"]) {
    for (const cached of [false, true]) {
      for (const status of ["running", "idle"]) {
        const page = await browser.newPage({ viewport: { width: theme === "light" ? 1280 : 390, height: 844 } });
        page.setDefaultTimeout(10_000);
        let releaseImage;
        const imageReady = new Promise(resolve => { releaseImage = resolve; });
        await page.route("**/api/sessions/scroll-fixture/attachments/late", async route => {
          await imageReady;
          await route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="256"><rect width="300" height="256" fill="gray"/></svg>' });
        });
        await page.goto(`${url}/auth?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
        await page.locator("#root > *").waitFor();
        await page.evaluate(async ({ theme, cached, status }) => {
          const { default: { createElement: h, StrictMode } } = await import("/node_modules/.vite/deps/react.js");
          const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
          const { TranscriptView } = await import("/src/components/transcript-view.tsx");
          const { createAgentSessionView } = await import("/src/store/agent-session-view.ts");
          document.documentElement.classList.toggle("dark", theme === "dark");
          document.getElementById("root").style.display = "none";
          const fixture = document.createElement("section");
          fixture.id = "transcript-scroll-fixture";
          fixture.className = "grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)] bg-background text-foreground";
          fixture.style.height = "100dvh";
          fixture.style.setProperty("--composer-inset", "100px");
          document.body.append(fixture);
          const root = createRoot(fixture);
          let emit;
          let seq = 0;
          let mount = 0;
          const view = createAgentSessionView("scroll-fixture", {
            subscribe: options => { emit = options.onEntry; return () => {}; },
          });
          view.start();
          const append = event => emit({ sessionId: view.sessionId, seq: ++seq, at: new Date().toISOString(), event });
          const events = [
            { type: "session_started", backend: "fake", scope: "/tmp", capabilities: { providers: [], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false } },
            { type: "user_message", id: "first", text: "An Attachment that loads after the transcript.", attachments: ["late"] },
            { type: "turn_started", turnId: "turn" },
            ...Array.from({ length: 450 }, (_, i) => ({ type: "message", id: `message-${i}`, text: `Response ${i}. ` + "Some transcript text that wraps on narrow screens. ".repeat(4), final: true })),
            // Keep the delayed Attachment in the tail window too.
            { type: "user_message", id: "last", text: "Latest prompt", attachments: ["late"] },
          ];
          if (status === "idle") events.push({ type: "turn_ended", turnId: "turn", reason: "complete" });
          const render = (query = "") => root.render(h(StrictMode, null, h(TranscriptView, { key: mount, view, query })));
          if (cached) events.forEach(append);
          render();
          window.scrollFixture = {
            view,
            replay: async () => {
              for (let i = 0; i < events.length; i += 25) {
                events.slice(i, i + 25).forEach(append);
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              }
            },
            append: () => append({ type: "message", id: "live-output", text: "New live output. ".repeat(60), final: status === "idle" }),
            stream: () => append({ type: "message", id: "live-output", text: "A growing snapshot without any new row. ".repeat(100), final: status === "idle" }),
            grow: () => {
              // A layout-only change: models do not send an event when fonts/images/disclosures resize.
              const spacer = document.createElement("div");
              spacer.style.height = "300px";
              fixture.querySelector(".pane-measure").append(spacer);
              // Simulate a queued programmatic scroll event arriving after the size changed.
              fixture.querySelector(".transcript-scroller").dispatchEvent(new Event("scroll"));
            },
            search: render,
            reopen: () => { mount++; render(); },
          };
        }, { theme, cached, status });
        const scroller = page.locator("#transcript-scroll-fixture .transcript-scroller");
        await scroller.waitFor();
        if (!cached) await page.evaluate(() => window.scrollFixture.replay());
        await page.waitForFunction(status => window.scrollFixture.view.getChrome().status === status, status);
        const bottom = () => page.waitForFunction(() => {
          const element = document.querySelector("#transcript-scroll-fixture .transcript-scroller");
          return element.scrollHeight > element.clientHeight && element.scrollHeight - element.scrollTop - element.clientHeight < 1;
        });
        await bottom();
        await page.getByRole("button", { name: /earlier entries · show all/ }).waitFor();
        const beforeImage = await scroller.evaluate(element => element.scrollHeight);
        releaseImage();
        await page.waitForFunction(() => [...document.querySelectorAll("#transcript-scroll-fixture img")].every(image => image.naturalHeight > 0));
        await bottom();
        assert.ok(await scroller.evaluate(element => element.scrollHeight) > beforeImage, "delayed Attachments must really grow the document");
        await page.evaluate(() => window.scrollFixture.grow());
        await bottom();

        // Genuine reader movement releases the pin. Neither output nor layout may steal it back.
        await scroller.hover();
        await page.mouse.wheel(0, -600);
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        const top = await scroller.evaluate(element => element.scrollTop);
        await page.evaluate(() => { window.scrollFixture.append(); window.scrollFixture.grow(); });
        await page.waitForTimeout(250);
        assert.equal(await scroller.evaluate(element => element.scrollTop), top, "reading earlier messages must survive output and layout changes");
        await page.getByRole("button", { name: "Jump to latest", exact: true }).click();
        await bottom();
        await page.evaluate(() => window.scrollFixture.stream());
        await bottom();

        // The Composer inset and viewport still use the same pin rule.
        await page.evaluate(() => document.getElementById("transcript-scroll-fixture").style.setProperty("--composer-inset", "250px"));
        await bottom();
        await page.setViewportSize({ width: theme === "light" ? 800 : 360, height: 600 });
        await bottom();
        await page.evaluate(() => window.scrollFixture.search("Response 449"));
        await page.waitForFunction(() => !document.querySelector("#transcript-scroll-fixture img"));
        await page.evaluate(() => window.scrollFixture.search(""));
        await bottom();
        await scroller.evaluate(element => { element.scrollTop = 0; });
        await page.getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
        await page.evaluate(() => window.scrollFixture.reopen());
        await bottom();
        console.log(`${theme}, ${cached ? "cached" : "replayed"}, ${status}: scroll checks passed`);
        await page.close();
      }
    }
  }
} finally {
  await browser.close();
}
