import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const playwright = process.env.PLAYWRIGHT_MODULE
  ? await import(process.env.PLAYWRIGHT_MODULE)
  : await import("playwright").catch(() => import("/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs"));
const url = (process.env.FLOW_URL ?? process.env.FLOW_WEB_URL ?? "http://127.0.0.1:5173").replace(/\/$/, "");
const token = process.env.FLOW_TOKEN ?? (await readFile(join(process.env.FLOW_STATE_DIR ?? join(homedir(), ".flow"), "token"), "utf8")).trim();
const sessionId = "mcp-menu-fixture";
const connections = [
  { id: "ready", name: "Ready tools", transport: "stdio", command: "never-run", args: [], enabledByDefault: true },
  { id: "pending", name: "Pending tools", transport: "http", url: "https://example.invalid/mcp", oauth: false, headers: {}, enabledByDefault: true },
  { id: "oauth", name: "OAuth tools", transport: "http", url: "https://example.invalid/mcp", oauth: true, headers: {}, enabledByDefault: true },
];
const states = [
  { id: "ready", state: "connected", tools: 7 },
  { id: "pending", state: "connecting", tools: 0 },
  { id: "oauth", state: "failed", tools: 0 },
];
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? process.env.PLAYWRIGHT_EXECUTABLE_PATH });
const failures = [];
const screenshotDir = process.env.SCREENSHOT_DIR;

async function fixture({ theme = "light", mobile = false, empty = false, failed = "oauth" } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    hasTouch: mobile, isMobile: mobile, colorScheme: theme, reducedMotion: "reduce", serviceWorkers: "block",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on("pageerror", (error) => failures.push(error.message));
  const writes = [];
  const unexpected = [];
  let retryError = false;
  let retryWait;
  let releaseRetry;
  let mcpReads = 0;
  const statuses = empty ? [] : states.map((entry) => ({
    ...entry, id: entry.id === failed ? "oauth" : entry.id === "oauth" ? failed : entry.id,
  }));
  const snapshot = {
    type: "snapshot", seq: 0, start: 0, total: 0, entries: [], related: [],
    state: { status: "idle", lifecycle: "live", turnInFlight: false, queue: [], activeSubagents: 0, activeBackgroundCalls: 0, backend: "fake", scope: "/tmp/mcp-menu-fixture" },
  };
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    if (method === "GET" && path === "/api/config") return route.fulfill({ json: { scope: snapshot.state.scope, backends: ["fake"], shell: false, git: false, mcp: connections } });
    if (method === "GET" && path === "/api/sessions") return route.fulfill({ json: [{
      id: sessionId, scope: snapshot.state.scope, backend: "fake", status: "idle", title: "MCP menu fixture",
      restingAt: "2026-01-01T00:00:00Z", activeSubagents: 0, activeBackgroundCalls: 0, activeWorkflows: 0, lastSeq: 0,
    }] });
    if (method === "GET" && path === `/api/sessions/${sessionId}/presentation/events`) return route.fulfill({ contentType: "text/event-stream", body: `data: ${JSON.stringify(snapshot)}\n\n` });
    if (method === "GET" && path === `/api/sessions/${sessionId}/mcp`) {
      mcpReads++;
      return route.fulfill({ json: statuses });
    }
    if (method === "GET" && path === "/api/models") return route.fulfill({ json: [] });
    if (method === "GET" && path === "/api/shells") return route.fulfill({ json: [] });
    if (method === "GET" && path === "/api/workflows") return route.fulfill({ json: { workflows: [] } });
    if (method === "GET" && path === "/api/update") return route.fulfill({ json: { installedVersion: "fixture", updateAvailable: false, eligibility: { state: "unsupported", reason: "Browser fixture" } } });
    if (method === "POST" && path === "/api/command" && request.postDataJSON()?.type === "list_skills") return route.fulfill({ json: { result: [] } });
    if (method === "POST" && path === `/api/sessions/${sessionId}/mcp/${failed}/retry`) {
      writes.push({ method, path });
      await retryWait;
      return route.fulfill({ status: retryError ? 503 : 200, json: retryError ? { error: "Fixture retry refused" } : { ok: true } });
    }
    if (method === "POST" && path === "/api/mcp/oauth/login") {
      writes.push({ method, path, body: request.postDataJSON() });
      return route.fulfill({ status: 503, json: { error: "Fixture sign-in refused" } });
    }
    unexpected.push(`${method} ${path}`);
    return route.fulfill({ status: 500, json: { error: `Unexpected fixture request: ${method} ${path}` } });
  });
  await page.goto(`${url}/auth?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.goto(`${url}/#/s/${sessionId}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "More actions", exact: true }).waitFor();
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
  await page.waitForFunction(() => document.querySelector("[data-pane]"));
  const item = (name) => page.getByRole("menuitem", { name, exact: true });
  const more = page.getByRole("button", { name: "More actions", exact: true });
  assert.deepEqual(await more.locator("xpath=../..").locator(":scope > span").allTextContents(), ["MCP menu fixture"], "the header shows the Agent Session title without a Project name or divider");
  const mcp = item("MCP · 1/3 connected");
  const row = item(`${connections.find((connection) => connection.id === failed).name}: failed`);
  async function open(touch = false) {
    await page.mouse.move(0, 0);
    assert.equal(await page.getByText(/^(MCP ·|Ready tools:|Pending tools:|OAuth tools:)/).filter({ visible: true }).count(), 0, "MCP must not remain as a banner");
    await more[touch ? "tap" : "click"]();
    await mcp.waitFor();
    assert.equal(await mcp.getAttribute("aria-haspopup"), "menu");
    await mcp[touch ? "tap" : "hover"]();
    await row.waitFor();
  }
  async function actions(touch = false) {
    await row[touch ? "tap" : "hover"]();
    await item("Retry").waitFor();
  }
  async function finish() {
    assert.ok(mcpReads > 0, "MCP status must be read before checking the menu");
    assert.deepEqual(unexpected, [], "all API requests must use known browser fixtures");
    await context.close();
  }
  return {
    page, more, mcp, row, item, writes, open, actions, finish,
    failRetry: () => { retryError = true; },
    pauseRetry: () => { retryWait = new Promise((resolve) => { releaseRetry = resolve; }); },
    resumeRetry: () => { releaseRetry(); retryWait = undefined; },
  };
}

async function fits(page) {
  for (const menu of await page.getByRole("menu").all()) {
    const box = await menu.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `menu clips: ${JSON.stringify(box)}`);
  }
}

async function focused(page, locator) {
  const handle = await locator.elementHandle();
  await page.waitForFunction((node) => node === document.activeElement, handle);
}

async function keyboardActions(f) {
  await f.more.focus();
  await f.page.keyboard.press("ArrowDown");
  await f.mcp.waitFor();
  await f.page.keyboard.press("ArrowDown");
  await f.page.waitForFunction((node) => node.parentElement.querySelector('[role="menuitem"][tabindex="0"]') === document.activeElement, await f.mcp.elementHandle());
  await f.page.keyboard.press("m");
  await focused(f.page, f.mcp);
  await f.page.keyboard.press("ArrowRight");
  await focused(f.page, f.row);
  await f.page.keyboard.press("ArrowRight");
  await focused(f.page, f.item("Sign in"));
  await f.page.keyboard.press("ArrowDown");
  await focused(f.page, f.item("Retry"));
}

try {
  if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
  for (const theme of ["light", "dark"]) {
    const f = await fixture({ theme });
    const { page, item } = f;
    await f.open();
    assert.equal(await page.getByRole("menu").count(), 2, "More actions must contain the MCP submenu");
    for (const label of ["Ready tools: connected (7 tools)", "Pending tools: connecting"]) {
      const row = item(label);
      await row.waitFor();
      assert.equal(await row.getAttribute("aria-haspopup"), null, `${label} must not have actions`);
    }
    await f.actions();
    assert.equal(await page.getByRole("menu").count(), 3, "failed connection actions must be a nested submenu");
    assert.deepEqual(await item("Retry").locator("..").getByRole("menuitem").allTextContents(), ["Sign in", "Retry"]);
    await fits(page);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `mcp-menu-${theme}.png`) });
    f.pauseRetry();
    await item("Retry").click();
    await f.more.waitFor();
    await f.open();
    await f.actions();
    assert.equal(await item("Retry").isDisabled(), true, "pending Retry stays disabled after reopening the menu");
    f.resumeRetry();
    await page.waitForFunction((node) => node.getAttribute("aria-disabled") !== "true", await item("Retry").elementHandle());
    assert.deepEqual(f.writes, [{ method: "POST", path: `/api/sessions/${sessionId}/mcp/oauth/retry` }]);
    f.failRetry();
    await item("Retry").click();
    await page.getByText("Error: Fixture retry refused", { exact: true }).waitFor();
    await page.getByLabel("Dismiss", { exact: true }).click();
    await f.open();
    await f.actions();
    await item("Sign in").click();
    await page.getByText("Error: Fixture sign-in refused", { exact: true }).waitFor();
    assert.deepEqual(f.writes, [
      { method: "POST", path: `/api/sessions/${sessionId}/mcp/oauth/retry` },
      { method: "POST", path: `/api/sessions/${sessionId}/mcp/oauth/retry` },
      { method: "POST", path: "/api/mcp/oauth/login", body: { returnUrl: `${url}/#/s/${sessionId}` } },
    ]);
    await page.getByLabel("Dismiss", { exact: true }).click();

    await keyboardActions(f);
    await page.keyboard.press("ArrowLeft");
    await focused(page, f.row);
    await page.keyboard.press("ArrowLeft");
    await focused(page, f.mcp);
    await page.keyboard.press("Escape");
    await focused(page, f.more);
    await keyboardActions(f);
    await page.keyboard.press("Enter");
    await page.getByText("Error: Fixture retry refused", { exact: true }).waitFor();
    assert.equal(f.writes.length, 4, "keyboard activation must issue exactly one Retry");
    assert.deepEqual(f.writes.at(-1), { method: "POST", path: `/api/sessions/${sessionId}/mcp/oauth/retry` });
    await f.finish();
  }
  for (const failed of ["ready", "pending"]) {
    const f = await fixture({ failed });
    await f.open();
    await f.actions();
    assert.equal(await f.item("Sign in").count(), 0, `${failed}: only HTTP OAuth connections offer Sign in`);
    await f.item("Retry").click();
    await f.open();
    assert.deepEqual(f.writes, [{ method: "POST", path: `/api/sessions/${sessionId}/mcp/${failed}/retry` }]);
    await f.finish();
  }
  const empty = await fixture({ empty: true });
  const emptyResponse = empty.page.waitForResponse((response) => new URL(response.url()).pathname === `/api/sessions/${sessionId}/mcp`);
  await empty.more.click();
  await emptyResponse;
  await empty.page.getByRole("menu").waitFor();
  assert.equal(await empty.page.getByRole("menuitem", { name: /^MCP/ }).count(), 0, "no MCP connections must hide the entry");
  await empty.finish();

  for (const theme of ["light", "dark"]) {
    const f = await fixture({ theme, mobile: true });
    await f.open(true);
    await f.actions(true);
    await fits(f.page);
    if (screenshotDir) await f.page.screenshot({ path: join(screenshotDir, `mcp-menu-mobile-${theme}.png`) });
    await f.item("Retry").tap();
    await f.open(true);
    assert.deepEqual(f.writes, [{ method: "POST", path: `/api/sessions/${sessionId}/mcp/oauth/retry` }]);
    await f.finish();
  }
  assert.deepEqual(failures, [], "browser must not report uncaught errors");
  console.log("MCP menu passed hover, keyboard, touch, request, toast, empty-state, light, and dark checks. Browser fixtures only; real MCP/OAuth and physical mobile devices are not tested.");
} finally {
  await browser.close();
}
