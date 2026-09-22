import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

async function loadPlaywright() {
  // Keep the probe's dependencies outside Flow's locked install in CI.
  if (process.env.FLOW_TEST_PLAYWRIGHT) return import(pathToFileURL(resolve(process.env.FLOW_TEST_PLAYWRIGHT)).href);
  try {
    return await import("playwright");
  } catch (error) {
    if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
    // Development harness fallback; CI installs the npm library, not bundled browsers.
    return import(pathToFileURL("/usr/local/share/npm-global/lib/node_modules/playwright/index.mjs").href);
  }
}

/**
 * Start a REAL self-update through Settings on a disposable test Session Host only.
 * Importing this module has no browser, network, or update side effects.
 * Keep the returned probe alive while checking systemd; always close it in finally.
 * Each invocation should have its own artifactDir. waitForSuccess(timeoutMs = 180000)
 * returns the observed UI state, installed version, and success text.
 */
export async function beginBrowserUpdate({ url, token, version, artifactDir }) {
  if (!url || !token?.trim() || !version || !artifactDir) {
    throw new Error("beginBrowserUpdate requires url, token, version, and artifactDir");
  }
  token = token.trim();
  const base = new URL(url);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password) {
    throw new Error("The test Session Host URL must be HTTP(S) without embedded credentials");
  }
  const directory = resolve(artifactDir);
  mkdirSync(directory, { recursive: true });
  const logPath = join(directory, "browser-update.log");
  const secrets = [...new Set([token, encodeURIComponent(token),
    new URLSearchParams({ token }).toString().slice("token=".length)])];
  const redact = value => secrets.reduce((text, secret) => text.split(secret).join("[REDACTED]"), String(value))
    .replace(/([?&]token=)[^\s&#"']+/gi, "$1[REDACTED]");
  const log = (kind, value) => appendFileSync(logPath,
    `${new Date().toISOString()} ${kind} ${redact(value)}\n`);
  let browser;
  let page;
  let closed = false;
  let navigation = 0;

  async function close() {
    if (closed) return;
    closed = true;
    await browser?.close();
    log("probe", "Browser closed");
  }

  async function captureError(error) {
    log("error", error?.stack ?? error);
    if (page && !page.isClosed()) {
      try {
        log("page", await page.locator("body").innerText({ timeout: 5_000 }));
      } catch (capture) {
        log("diagnostic-error", capture.message);
      }
      try {
        await page.screenshot({ path: join(directory, "browser-update-error.png"), fullPage: true, timeout: 10_000 });
      } catch (capture) {
        log("screenshot-error", capture.message);
      }
    }
    // Playwright errors can contain the authentication navigation URL. Do not leak it
    // to the caller's console via either the message, stack, or an unredacted cause.
    return new Error(redact(error?.stack ?? error));
  }

  try {
    log("probe", `Opening disposable Session Host ${base.origin}; target ${version}`);
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({
      executablePath: process.env.FLOW_TEST_CHROME || "/usr/bin/google-chrome",
      headless: true,
    });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(30_000);
    page.setDefaultNavigationTimeout(30_000);
    page.on("console", message => log(`console:${message.type()}`, message.text()));
    page.on("pageerror", error => log("pageerror", error.stack ?? error.message));
    page.on("requestfailed", request => log("requestfailed", `${request.method()} ${request.url()} ${request.failure()?.errorText}`));
    page.on("framenavigated", frame => {
      if (frame !== page.mainFrame()) return;
      navigation++;
      log("navigation", frame.url());
    });
    page.on("crash", () => log("crash", "Browser page crashed"));

    // This must be the first navigation: all other routes require the handoff cookie.
    const auth = new URL("/auth", base);
    auth.searchParams.set("token", token);
    const response = await page.goto(auth.href, { waitUntil: "domcontentloaded" });
    if (response && !response.ok()) throw new Error(`Authentication failed (${response.status()})`);
    await page.goto(new URL("/", base).href, { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: /^General\b/ }).click();
    await page.waitForURL("**/#/settings/general", { waitUntil: "domcontentloaded" });
    const update = page.locator("section").filter({ has: page.getByRole("heading", { name: "Flow update", exact: true }) });
    await update.getByRole("button", { name: "Check for updates", exact: true }).click();
    // Exact accessible name ensures we never approve a different advertised release.
    await update.getByRole("button", { name: `Update to ${version}`, exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await confirmation.getByRole("heading", { name: `Update Flow to ${version}?`, exact: true }).waitFor();
    const originalDark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
    for (const dark of [false, true]) {
      await page.evaluate(dark => {
        document.documentElement.classList.toggle("dark", dark);
        document.documentElement.style.colorScheme = dark ? "dark" : "light";
      }, dark);
      await page.screenshot({ path: join(directory, `browser-update-confirm-${dark ? "dark" : "light"}.png`), fullPage: true, animations: "disabled" });
    }
    await page.evaluate(dark => {
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    }, originalDark);
    log("probe", `Confirming update to ${version}`);
    await confirmation.getByRole("button", { name: "Update and restart", exact: true }).click();
  } catch (error) {
    const safeError = await captureError(error);
    await close().catch(closeError => log("close-error", closeError.message));
    throw safeError;
  }

  async function waitForSuccess(timeoutMs = 180_000) {
    try {
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be positive and finite");
      const deadline = Date.now() + timeoutMs;
      let lastSnapshot;
      let previousSuccessNavigation;
      while (Date.now() < deadline) {
        if (closed || page.isClosed() || !browser.isConnected()) throw new Error("Browser closed before update success");
        let snapshot;
        try {
          // Read the rendered status and Installed fact together, never a network
          // response. Reacquire nodes on every poll because success reloads the app.
          snapshot = await page.locator("[data-update-state]").evaluate(element => {
            const section = element.closest("section");
            const label = [...(section?.querySelectorAll("span") ?? [])]
              .find(span => span.textContent?.trim() === "Installed");
            return {
              state: element.getAttribute("data-update-state"),
              installedVersion: label?.nextElementSibling?.textContent?.trim(),
              text: element.textContent?.trim(),
            };
          }, undefined, { timeout: Math.min(2_000, Math.max(1, deadline - Date.now())) });
        } catch (error) {
          // Expected during the host restart / automatic updated-assets reload.
          previousSuccessNavigation = undefined;
          log("waiting-for-ui", error.message);
        }
        if (snapshot) {
          if (JSON.stringify(snapshot) !== JSON.stringify(lastSnapshot)) log("ui", JSON.stringify(snapshot));
          lastSnapshot = snapshot;
          if (snapshot.state === "failure") throw new Error(`UI reports update failure: ${snapshot.text}`);
          if (snapshot.state === "success" && snapshot.installedVersion === version) {
            // Avoid accepting the fleeting success render immediately before reload.
            // Require two observations in the same document, half a second apart.
            if (previousSuccessNavigation === navigation) {
              await page.screenshot({ path: join(directory, "browser-update-success.png"), fullPage: true, animations: "disabled", timeout: 10_000 });
              log("probe", `Verified rendered success and Installed ${version}`);
              return snapshot;
            }
            previousSuccessNavigation = navigation;
          } else {
            previousSuccessNavigation = undefined;
          }
        }
        // Leave reconnect/recovery-needed states to the real UI controller. Do not
        // reload, replace the browser, or submit the mutation again to hide failures.
        await delay(Math.min(500, Math.max(0, deadline - Date.now())));
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for UI success with Installed ${version}; last UI: ${JSON.stringify(lastSnapshot)}`);
    } catch (error) {
      throw await captureError(error);
    }
  }

  return { waitForSuccess, close };
}
