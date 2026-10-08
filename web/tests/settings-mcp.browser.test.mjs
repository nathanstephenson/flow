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
      import McpSettings from './web/src/components/settings-mcp.tsx';
      import { HostProvider } from './web/src/host.tsx';
      createRoot(document.getElementById('root')).render(<HostProvider><McpSettings /></HostProvider>);
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

const remote = (id) => ({
  id, name: id, transport: "http", url: `https://${id}.test/mcp`,
  oauth: true, headers: {}, enabledByDefault: true,
});

describe("MCP Settings", () => {
  let browser;
  let page;
  let saved;
  let signedIn;
  let logoutFails;
  let logouts;
  before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }); });
  after(async () => { await browser?.close(); });
  beforeEach(async () => {
    saved = { scope: "/tmp/project", backends: ["pi"], mcp: [remote("one"), remote("two")] };
    signedIn = ["one"];
    logoutFails = false;
    logouts = [];
    page = await browser.newPage();
    await page.route("https://flow.test/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let data;
      let status = 200;
      if (path === "/") {
        await route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' });
        return;
      }
      if (path === "/api/config") {
        if (request.method() === "PUT") saved = { ...saved, ...request.postDataJSON() };
        data = saved;
      } else if (path === "/api/secrets") data = { names: [] };
      else if (path === "/api/mcp/auth") data = { signedIn };
      else if (path.endsWith("/logout")) {
        logouts.push({ path, method: request.method() });
        status = logoutFails ? 400 : 200;
        data = logoutFails ? { error: "MCP sign-out failed" } : {};
        if (!logoutFails) signedIn = signedIn.filter((id) => path !== `/api/mcp/${id}/logout`);
      } else {
        await route.abort();
        return;
      }
      await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(data) });
    });
    await page.goto("https://flow.test/", { waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.getByRole("heading", { name: "MCP connections" }).waitFor();
  });
  afterEach(async () => { await page?.close(); });

  it("adds, edits, and deletes without a page refresh or losing saved connections", { timeout: 15_000 }, async () => {
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Local");
    await page.getByRole("textbox", { name: "Command", exact: true }).fill("example-mcp");
    await page.getByRole("button", { name: "Add connection", exact: true }).click();
    const row = page.getByRole("listitem").filter({ hasText: "Local" });
    await row.waitFor({ timeout: 3000 });
    assert.equal(saved.mcp.length, 3);
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const renamed = page.getByRole("listitem").filter({ hasText: "Renamed" });
    await renamed.waitFor({ timeout: 3000 });
    await renamed.getByRole("button", { name: "Delete", exact: true }).click();
    await renamed.waitFor({ state: "detached", timeout: 3000 });
    assert.deepEqual(saved.mcp.map((entry) => entry.id), ["one", "two"]);
  });

  it("shows Sign out only for a signed-in connection and resets it without a refresh", { timeout: 15_000 }, async () => {
    const one = page.getByRole("listitem").filter({ hasText: "one" });
    const two = page.getByRole("listitem").filter({ hasText: "two" });
    await one.getByRole("button", { name: "Sign out", exact: true }).waitFor({ timeout: 3000 });
    await two.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    await one.getByRole("button", { name: "Sign out", exact: true }).click();
    await one.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 3000 });
    assert.deepEqual(logouts, [{ path: "/api/mcp/one/logout", method: "POST" }]);
    assert.deepEqual(saved.mcp.map((entry) => entry.id), ["one", "two"]);
  });

  it("does not restore stale sign-in status when Settings are saved during logout", { timeout: 15_000 }, async () => {
    const row = page.getByRole("listitem").filter({ hasText: "one" });
    await row.getByRole("button", { name: "Sign out", exact: true }).waitFor();
    let releaseLogout;
    let releaseStatus;
    let statusStarted;
    const logoutGate = new Promise((resolve) => { releaseLogout = resolve; });
    const statusGate = new Promise((resolve) => { releaseStatus = resolve; });
    const statusRequest = new Promise((resolve) => { statusStarted = resolve; });
    let holdStatus = true;
    await page.route("**/api/mcp/one/logout", async (route) => {
      await logoutGate;
      await route.fallback();
    });
    await page.route("**/api/mcp/auth", async (route) => {
      if (!holdStatus) return route.fallback();
      holdStatus = false;
      statusStarted();
      await statusGate;
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ signedIn: ["one"] }) });
    });
    await row.getByRole("button", { name: "Sign out", exact: true }).click();
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed one");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await statusRequest;
    const logoutResponse = page.waitForResponse((response) => response.url().endsWith("/logout"));
    releaseLogout();
    await logoutResponse;
    releaseStatus();
    await row.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 3000 });
  });

  it("can retry after the OAuth status request fails", { timeout: 15_000 }, async () => {
    let failStatus = true;
    await page.route("**/api/mcp/auth", async (route) => {
      if (!failStatus) return route.fallback();
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Status unavailable" }) });
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    const row = page.getByRole("listitem").filter({ hasText: "one" });
    const retry = row.getByRole("button", { name: "Retry sign-in status", exact: true });
    await retry.waitFor({ timeout: 3000 });
    failStatus = false;
    await retry.click();
    await row.getByRole("button", { name: "Sign out", exact: true }).waitFor({ timeout: 3000 });
  });

  it("refreshes OAuth status after changing an HTTP endpoint without changing its ID", { timeout: 15_000 }, async () => {
    await page.route("**/api/mcp/auth", async (route) => {
      const connection = saved.mcp.find((entry) => entry.id === "one");
      await route.fulfill({ contentType: "application/json", body: JSON.stringify({ signedIn: connection.url === "https://one.test/mcp" ? ["one"] : [] }) });
    });
    const row = page.getByRole("listitem").filter({ hasText: "one" });
    await row.getByRole("button", { name: "Sign out", exact: true }).waitFor();
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await page.getByRole("textbox", { name: "URL", exact: true }).fill("https://changed.test/mcp");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await row.getByRole("button", { name: "Sign in", exact: true }).waitFor({ timeout: 3000 });
    assert.deepEqual(saved.mcp.map((entry) => entry.id).sort(), ["one", "two"]);
    assert.equal(saved.mcp.find((entry) => entry.id === "one").url, "https://changed.test/mcp");
  });

  it("keeps Sign out when clearing credentials fails", { timeout: 15_000 }, async () => {
    logoutFails = true;
    const button = page.getByRole("listitem").filter({ hasText: "one" }).getByRole("button", { name: "Sign out", exact: true });
    await button.waitFor({ timeout: 3000 });
    const response = page.waitForResponse((response) => response.url().endsWith("/logout"));
    await button.click();
    await response;
    await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent === "Sign out" && !button.disabled));
    assert.deepEqual(signedIn, ["one"]);
    assert.equal(await button.count(), 1);
  });
});
