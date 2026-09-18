import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.env.FLOW_WEB_URL ?? "http://127.0.0.1:5173";
const sessionId = process.env.FLOW_SESSION_ID;
if (!sessionId) throw new Error("FLOW_SESSION_ID must name a Git session with a workflow execution");
const token = (await readFile(`${process.env.FLOW_STATE_DIR}/token`, "utf8")).trim();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

async function openPage(viewport) {
  const page = await browser.newPage({ viewport });
  await page.goto(`${url}/auth?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.goto(`${url}/#/s/${encodeURIComponent(sessionId)}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "More actions" }).waitFor();
  return page;
}

async function chooseDockView(page, label) {
  const desktopOpener = page.getByRole("button", { name: "Open the right Dock" });
  if (await desktopOpener.isVisible()) await desktopOpener.click();
  else await page.getByRole("button", { name: "New tab in the right Dock" }).click();
  await page.locator("button:visible").filter({ hasText: new RegExp(`^${label}$`) }).last().click();
}

async function assertSelected(page, list, label) {
  const tabs = list.getByRole("tab");
  for (let index = 0; index < await tabs.count(); index++) {
    const tab = tabs.nth(index);
    const selected = await tab.getAttribute("aria-selected") === "true";
    assert.equal(selected, await tab.textContent() === label, `only ${label} should be selected`);
    assert.equal(await tab.getAttribute("tabindex"), selected ? "0" : "-1", "tabs should use roving focus");
    const handle = await tab.elementHandle();
    if (selected) {
      await page.waitForFunction((node) => {
        const id = node?.getAttribute("aria-controls");
        const panel = id ? document.getElementById(id) : null;
        return panel && !panel.hidden && panel.getAttribute("aria-labelledby") === node.id;
      }, handle);
    } else {
      await page.waitForFunction((node) => {
        const id = node?.getAttribute("aria-controls");
        const panel = id ? document.getElementById(id) : null;
        return !panel || panel.hidden;
      }, handle);
    }
    const association = await tab.evaluate((node) => {
      const panelId = node.getAttribute("aria-controls");
      const panel = panelId ? document.getElementById(panelId) : null;
      return panel ? {
        labelledBy: panel.getAttribute("aria-labelledby"),
        role: panel.getAttribute("role"),
        hidden: panel.hidden,
        inert: panel.inert,
      } : null;
    });
    if (!association) {
      assert.equal(selected, false, `${await tab.textContent()} should control its visible panel`);
      continue;
    }
    assert.equal(association.labelledBy, await tab.getAttribute("id"));
    assert.equal(association.role, "tabpanel");
    assert.equal(association.hidden, !selected);
    if (!selected) assert.equal(association.inert, true);
  }
}

async function assertFits(page, list) {
  const viewport = page.viewportSize();
  const bounds = await list.boundingBox();
  assert.ok(bounds && viewport && bounds.x >= 0 && bounds.x + bounds.width <= viewport.width, `tab list clips: ${JSON.stringify(bounds)}`);
  for (const tab of await list.getByRole("tab").all()) {
    assert.equal(await tab.evaluate((node) => node.scrollWidth <= node.clientWidth), true, `${await tab.textContent()} clips`);
  }
  assert.equal(await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth), true, "page overflows horizontally");
}

async function checkGit(viewport, screenshotSuffix) {
  const page = await openPage(viewport);
  await chooseDockView(page, "Git");
  const list = page.getByRole("tablist", { name: "Git views" });
  await list.waitFor();
  await page.getByText("Reading Git status…").waitFor({ state: "hidden" });
  if (process.env.FLOW_EXPECT_PR) await list.getByRole("tab", { name: "PR", exact: true }).waitFor();
  else await page.waitForTimeout(500);
  const labels = await list.getByRole("tab").allTextContents();
  assert.equal(labels[0], "Diff");
  assert.deepEqual(labels, labels.filter((label) => ["Diff", "Stack", "PR"].includes(label)));
  assert.equal(labels.join(",").includes("PR,Stack"), false, "Git tabs must stay in Diff / Stack / PR order");
  const selected = labels.includes("PR") ? "PR" : "Diff";
  await assertSelected(page, list, selected);
  await assertFits(page, list);

  if (labels.length > 1) {
    await list.getByRole("tab", { name: selected }).focus();
    await page.keyboard.press("Home");
    await assertSelected(page, list, "Diff");
    await page.keyboard.press("End");
    await assertSelected(page, list, labels.at(-1));
    await page.keyboard.press("ArrowLeft");
    await assertSelected(page, list, labels.at(-2));
    await page.keyboard.press("ArrowRight");
    await assertSelected(page, list, labels.at(-1));
  }
  if (labels.at(-1) !== "Diff") await list.getByRole("tab", { name: "Diff" }).click();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await page.getByRole("tab", { name: "Diff", exact: true }).waitFor();
  for (const tab of await list.getByRole("tab").all()) {
    assert.equal(await tab.isDisabled(), true, "Publish should lock every Git tab");
  }
  if (labels.length > 1) {
    await list.getByRole("tab", { name: labels.at(-1) }).click({ force: true });
    assert.equal(await list.getByRole("tab", { name: "Diff" }).getAttribute("aria-selected"), "true", "a disabled Git tab must not activate");
  }
  await page.reload({ waitUntil: "domcontentloaded" });
  await list.waitFor();
  await page.getByText("Reading Git status…").waitFor({ state: "hidden" });
  if (process.env.FLOW_EXPECT_PR) await list.getByRole("tab", { name: "PR", exact: true }).waitFor();
  else await page.waitForTimeout(500);

  if (process.env.SCREENSHOT_DIR) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/nat-75-git-${screenshotSuffix}-${theme}.png` });
    }
  }
  await page.close();
}

async function checkWorkflow(viewport, screenshotSuffix) {
  const page = await openPage(viewport);
  await chooseDockView(page, "Workflows");
  const list = page.getByRole("tablist", { name: "Workflow execution view" });
  await list.waitFor();
  assert.deepEqual(await list.getByRole("tab").allTextContents(), ["Overview", "Flow"]);
  await assertSelected(page, list, "Overview");

  const overview = list.getByRole("tab", { name: "Overview" });
  const flow = list.getByRole("tab", { name: "Flow" });
  await overview.focus();
  await page.keyboard.press("End");
  await assertSelected(page, list, "Flow");
  assert.equal(await flow.evaluate((node) => node === document.activeElement), true, "End should focus Flow");
  await page.keyboard.press("Home");
  await assertSelected(page, list, "Overview");
  await page.keyboard.press("ArrowRight");
  await assertSelected(page, list, "Flow");
  await page.keyboard.press("ArrowLeft");
  await assertSelected(page, list, "Overview");
  await assertFits(page, list);
  const centerOffset = await list.evaluate((node) => {
    const tabs = node.getBoundingClientRect();
    const container = node.parentElement.getBoundingClientRect();
    if (container.x < 0 || container.right > window.innerWidth) return Infinity;
    return Math.abs(tabs.x + tabs.width / 2 - container.x - container.width / 2);
  });
  assert.ok(centerOffset <= 1, "Workflow tabs should be centered in their container");

  if (process.env.SCREENSHOT_DIR) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/nat-75-workflow-${screenshotSuffix}-${theme}.png` });
    }
  }
  await page.close();
}

try {
  if (process.env.SCREENSHOT_DIR) await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
  await checkGit({ width: 1440, height: 900 }, "desktop");
  await checkWorkflow({ width: 1440, height: 900 }, "desktop");
  await checkGit({ width: 390, height: 844 }, "mobile");
  await checkWorkflow({ width: 390, height: 844 }, "mobile");
  console.log("Git and Workflow tabs passed pointer, keyboard, ARIA, disabled, theme, desktop, and mobile checks.");
} finally {
  await browser.close();
}
