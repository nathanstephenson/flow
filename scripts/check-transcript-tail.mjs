import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer as createVite } from "vite";
import { FakeBackend } from "../src/backend/fake/index.ts";
import { readOrCreateToken } from "../src/daemon/auth.ts";
import { SessionHost } from "../src/daemon/host.ts";
import { serve } from "../src/daemon/server.ts";
import { TranscriptStore } from "../src/daemon/store.ts";

// Self-contained, isolated real Session Host + this worktree's Vite client. No model calls.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const stateRoot = await mkdtemp(join(tmpdir(), "flow-transcript-tail-"));
const token = readOrCreateToken(stateRoot);
const store = new TranscriptStore(stateRoot);
const host = new SessionHost({ store });
host.registerBackend(new FakeBackend());
const sessionId = await host.create({ scope: stateRoot, backend: "fake" });
const log = host.logFor(sessionId);
log.append({ type: "user_message", id: "oldest", text: "OLDEST_SEARCH_MATCH" });
log.append({ type: "subagent", subagentId: "old-agent", name: "Earlier Reviewer", state: "running" });
log.append({ type: "turn_started", turnId: "historical-turn" });
for (let i = 0; i < 1_200; i++) {
  log.append({ type: "message", id: `response-${i}`, text: `Response ${i}. ` + "Some wrapping transcript text. ".repeat(4), final: true });
}
log.append({ type: "message", id: "latest", text: "LATEST_VISIBLE_RESPONSE", final: true });
log.append({ type: "turn_ended", turnId: "historical-turn", reason: "complete" });
const server = await serve({ host, token, store, assets: {} });
const priorUrl = process.env.FLOW_URL;
const priorRoot = process.env.FLOW_STATE_DIR;
process.env.FLOW_URL = server.url;
process.env.FLOW_STATE_DIR = stateRoot;
let vite;
let browser;
try {
  vite = await createVite({ configFile: resolve("web/vite.config.ts"), server: { host: "127.0.0.1", port: 0, fs: { allow: [resolve(".")] } } });
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: theme === "light" ? 1280 : 390, height: 844 } });
    page.setDefaultTimeout(10_000);
    page.on("pageerror", error => console.error(error.message));
    const requests = [];
    page.on("request", request => requests.push(request.url()));
    await page.goto(`${url}/auth?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
    await page.locator("#root > *").waitFor();
    await page.evaluate(async ({ sessionId, theme, source }) => {
      const { default: { createElement: h, StrictMode } } = await import("/node_modules/.vite/deps/react.js");
      const { default: { createRoot } } = await import("/node_modules/.vite/deps/react-dom_client.js");
      const { connect } = await import(source);
      const { TranscriptView } = await import("/src/components/transcript-view.tsx");
      const { createAgentSessionView } = await import("/src/store/agent-session-view.ts");
      const { useChrome } = await import("/src/agent-session-view.tsx");
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.getElementById("root").style.display = "none";
      const fixture = document.createElement("section");
      fixture.id = "tail-fixture";
      fixture.className = "grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] bg-background text-foreground";
      fixture.style.height = "100dvh";
      fixture.style.setProperty("--composer-inset", "100px");
      document.body.append(fixture);
      const root = createRoot(fixture);
      const view = createAgentSessionView(sessionId, connect({ url: "" }));
      function State() { return h("p", { id: "tail-status", className: "p-2 text-sm" }, useChrome(view).status); }
      const render = (query = "") => root.render(h(StrictMode, null, h(State), h(TranscriptView, { view, query })));
      window.tailFixture = { view, search: render, stop: () => view.stop() };
      view.start();
      render();
    }, { sessionId, theme, source: `/@fs${resolve("src/client/connection.ts")}` });
    const scroller = page.locator("#tail-fixture .transcript-scroller");
    await page.locator("#tail-status").getByText("idle", { exact: true }).waitFor();
    await page.locator("#tail-fixture").getByText("LATEST_VISIBLE_RESPONSE", { exact: true }).waitFor();
    await page.waitForFunction(() => window.tailFixture.view.getChrome().link === "live");
    const bottom = () => page.waitForFunction(() => {
      const element = document.querySelector("#tail-fixture .transcript-scroller");
      return element.scrollHeight - element.scrollTop - element.clientHeight < 1;
    });
    await bottom();
    const initial = await page.evaluate(() => ({
      keys: window.tailFixture.view.getKeys().length,
      earlier: window.tailFixture.view.getHistory().earlier,
      activeAgents: window.tailFixture.view.getChrome().activeSubagents,
      activity: window.tailFixture.view.getActivityKeys(),
    }));
    assert.equal(initial.keys, 400, "opening must deliver a bounded tail, not the whole record");
    assert.ok(initial.earlier > 400);
    assert.equal(initial.activeAgents, 1);
    assert.ok(initial.activity.includes("subagent:old-agent"), "off-tail live activity must remain accessible");
    assert.equal(await page.locator("#tail-fixture").getByText("OLDEST_SEARCH_MATCH", { exact: true }).count(), 0);
    assert.equal(requests.filter(request => request.includes(`/api/sessions/${sessionId}/events`)).length, 0, "web opening must not request raw historical replay");
    assert.equal(requests.filter(request => request.includes("/presentation?before=")).length, 0, "opening must not eagerly backfill history");

    log.append({ type: "turn_started", turnId: `live-${theme}` });
    await page.locator("#tail-status").getByText("running", { exact: true }).waitFor();
    log.append({ type: "message", id: "latest", text: `LATEST_VISIBLE_RESPONSE ${theme}`, final: false });
    await page.locator("#tail-fixture").getByText(`LATEST_VISIBLE_RESPONSE ${theme}`, { exact: false }).waitFor();
    await bottom();
    log.append({ type: "turn_ended", turnId: `live-${theme}`, reason: "complete" });
    await page.locator("#tail-status").getByText("idle", { exact: true }).waitFor();

    // Backward paging preserves a visible anchor instead of jumping to the new top/bottom.
    await scroller.evaluate(element => { element.scrollTop = 0; });
    await page.locator("#tail-fixture").getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
    const firstText = await page.evaluate(() => window.tailFixture.view.getEntry(window.tailFixture.view.getKeys()[0]).text);
    const anchor = page.locator("#tail-fixture").getByText(firstText, { exact: true });
    const beforeTop = await anchor.evaluate(element => element.getBoundingClientRect().top);
    await page.locator("#tail-fixture").getByRole("button", { name: /earlier transcript entries · load earlier/ }).click();
    await page.waitForFunction(earlier => window.tailFixture.view.getHistory().earlier < earlier && !window.tailFixture.view.getHistory().loadingOlder, initial.earlier);
    await page.waitForTimeout(100);
    assert.ok(Math.abs(await anchor.evaluate(element => element.getBoundingClientRect().top) - beforeTop) < 2, "prepending a page must preserve the visible row");
    assert.equal(await page.locator("#tail-status").textContent(), "idle", "older rows must never replay historical activity");
    assert.equal(requests.filter(request => request.includes("/presentation?before=")).length, 1);

    // Search backfills explicitly, but must not move a reader who scrolls while it is in flight.
    let releaseSearch;
    const searchGate = new Promise(resolve => { releaseSearch = resolve; });
    await page.route(/\/presentation\?before=/, async route => { await searchGate; await route.continue(); });
    const searching = page.waitForRequest(request => /\/presentation\?before=/.test(request.url()));
    try {
      await page.evaluate(() => window.tailFixture.search("response"));
      await searching;
      await bottom();
      await scroller.evaluate(element => { element.scrollTop = 0; });
      await page.locator("#tail-fixture").getByRole("button", { name: "Jump to latest", exact: true }).waitFor();
      const queryText = await page.evaluate(() => window.tailFixture.view.getEntry(window.tailFixture.view.getKeys()[0]).text);
      const queryAnchor = page.locator("#tail-fixture").getByText(queryText, { exact: true });
      const queryTop = await queryAnchor.evaluate(element => element.getBoundingClientRect().top);
      releaseSearch();
      await page.waitForFunction(() => window.tailFixture.view.getHistory().earlier === 0);
      await page.waitForTimeout(100);
      assert.ok(Math.abs(await queryAnchor.evaluate(element => element.getBoundingClientRect().top) - queryTop) < 2, "search backfill must preserve a reader's visible row");
    } finally { releaseSearch(); }

    // Search includes the now-loaded earliest row, rather than silently reporting tail-only matches.
    await page.evaluate(() => window.tailFixture.search("oldest_search_match"));
    try {
      await page.waitForFunction(() => window.tailFixture.view.getHistory().earlier === 0);
      await page.locator("#tail-fixture").getByText("OLDEST_SEARCH_MATCH", { exact: true }).waitFor();
    } catch (error) {
      console.error(await page.evaluate(() => ({ history: window.tailFixture.view.getHistory(), link: window.tailFixture.view.getChrome().link, keys: window.tailFixture.view.getKeys().length, text: document.getElementById("tail-fixture").textContent })));
      throw error;
    }
    assert.ok(requests.filter(request => request.includes("/presentation?before=")).length > 1);
    await page.evaluate(() => window.tailFixture.search(""));
    await bottom();
    console.log(`${theme}: real tail-first opening, current activity, backward paging and whole-record search passed`);
    await page.evaluate(() => window.tailFixture.stop());
    await page.close();
    // Reset latest text for the next independent browser client.
    log.append({ type: "message", id: "latest", text: "LATEST_VISIBLE_RESPONSE", final: true });
  }
  // Keep the original scroll/Attachment/reopen matrix running against the same isolated host.
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["scripts/check-transcript-scroll.mjs"], {
      stdio: "inherit", env: { ...process.env, FLOW_WEB_URL: url, FLOW_STATE_DIR: stateRoot },
    });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve() : reject(new Error(`Scroll checks exited ${code}`)));
  });
} finally {
  await browser?.close();
  await vite?.close();
  await server.close();
  await host.shutdown();
  await rm(stateRoot, { recursive: true, force: true });
  if (priorUrl === undefined) delete process.env.FLOW_URL; else process.env.FLOW_URL = priorUrl;
  if (priorRoot === undefined) delete process.env.FLOW_STATE_DIR; else process.env.FLOW_STATE_DIR = priorRoot;
}
