import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const url = process.env.FLOW_WEB_URL ?? "http://127.0.0.1:5173";
const token = (await readFile(`${process.env.FLOW_STATE_DIR}/token`, "utf8")).trim();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });

try {
  const page = await browser.newPage({ viewport: { width: 1050, height: 600 } });
  await page.goto(`${url}/auth?token=${encodeURIComponent(token)}`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "New Agent Session" }).waitFor();

  const list = page.getByRole("tablist", { name: "New Agent Session mode" });
  const chat = list.getByRole("tab", { name: "Chat" });
  const workflow = list.getByRole("tab", { name: "Workflow" });

  async function selected(label) {
    const expected = label === "Chat" ? chat : workflow;
    const other = label === "Chat" ? workflow : chat;
    assert.equal(await expected.getAttribute("aria-selected"), "true", `${label} should be selected`);
    assert.equal(await other.getAttribute("aria-selected"), "false", "exactly one tab should be selected");
    assert.equal(await expected.getAttribute("tabindex"), "0", "the selected tab should be in the tab order");
    assert.equal(await other.getAttribute("tabindex"), "-1", "the inactive tab should use roving focus");

    const panels = page.getByRole("tabpanel");
    assert.equal(await panels.count(), 1, "exactly one panel should be exposed");
    assert.equal(await expected.getAttribute("aria-controls"), await panels.first().getAttribute("id"));
    assert.equal(await panels.first().getAttribute("aria-labelledby"), await expected.getAttribute("id"));
  }

  await selected("Chat");
  const selectedShadow = await chat.evaluate((node) => getComputedStyle(node).boxShadow);
  await chat.focus();
  await page.keyboard.press("ArrowRight");
  await selected("Workflow");
  assert.equal(await workflow.evaluate((node) => node === document.activeElement), true, "arrow navigation should manage focus");
  assert.notEqual(
    await workflow.evaluate((node) => getComputedStyle(node).boxShadow),
    selectedShadow,
    "keyboard focus should stay visible independently of selection",
  );

  await page.keyboard.press("ArrowLeft");
  await selected("Chat");
  await workflow.click();
  await selected("Workflow");

  if (process.env.SCREENSHOT_DIR) await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
    await page.waitForTimeout(200);
    for (const [label, tab] of [["chat", chat], ["workflow", workflow]]) {
      await tab.click();
      await selected(label === "chat" ? "Chat" : "Workflow");
      await page.waitForTimeout(200);
      const colors = await tab.evaluate((node) => ({
        tab: getComputedStyle(node).backgroundColor,
        strip: getComputedStyle(node.parentElement).backgroundColor,
      }));
      assert.notEqual(colors.tab, colors.strip, `${theme} ${label}: selected pill must contrast with its strip`);
      if (process.env.SCREENSHOT_DIR) {
        await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/nat-76-${label}-${theme}.png` });
      }
    }
  }

  await page.setViewportSize({ width: 320, height: 720 });
  const bounds = await list.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 320, `tabs clip at 320px: ${JSON.stringify(bounds)}`);
  assert.equal(await page.locator("body").evaluate((body) => body.scrollWidth <= body.clientWidth), true);

  console.log("New Agent Session tabs passed pointer, arrow-key, focus, panel, theme, and 320px checks.");
} finally {
  await browser.close();
}
