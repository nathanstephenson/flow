// npm run build:web && node web/tests/enquiry-variants.screenshot.mjs <out dir>
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const out = process.argv[2] ?? "/tmp";
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { TranscriptEntry } from '@/components/transcript-entry.tsx';
      import { EnquiryToolRow, EnquiryExchange, EnquiryDecisionList, EnquiryOptions } from '@/components/enquiry-entry-variants.tsx';
      const q = (header, question, options) => ({ header, question, multiSelect: false, options: options.map((label) => ({ label })) });
      const enquiries = [
        { kind: 'enquiry', id: 'a', status: 'answered', answers: [['Version dir (Recommended)']], questions: [q('Mount',
          'Host Claude for sandbox: what does Flow mount read-only? Native install = ~/.local/bin/claude symlink → ~/.local/share/claude/versions/<v> (one self-contained ELF). sbx mounts at the same path in the VM.',
          ['Version dir (Recommended)', 'Whole ~/.local', 'Copy into VM'])] },
        { kind: 'enquiry', id: 'b', status: 'answered', answers: [['Host ELF check (Recommended)'], ['Pin to 2.1']], questions: [
          q('Reject', 'How should Flow reject an incompatible host Claude? Host-side check catches macOS (Mach-O), scripts/JS installs and wrong CPU arch before the VM is created. It cannot see the guest libc (glibc vs musl).',
            ['Host ELF check (Recommended)', 'Guest probe', 'No check']),
          q('Version', 'Which Claude version should the sandbox default to?', ['Latest', 'Match host'])] },
        { kind: 'enquiry', id: 'c', status: 'asked', questions: [q('Config', 'Provider file shape for host Claude? claudePath keeps its guest meaning in all options.',
          ['hostClaudePath field (Recommended)', 'Nested host block'])] },
      ];
      const before = { kind: 'assistant', id: 'x', final: true, text: 'Three design questions before I change the sandbox mount.' };
      const after = { kind: 'assistant', id: 'y', final: true, text: 'Thanks. I will mount the version directory read-only.' };
      const variants = {
        current: (e) => <TranscriptEntry entry={e} query="" sessionId="s" />,
        'tool-row': (e) => <EnquiryToolRow entry={e} query="" />,
        'tool-row-open': (e) => <EnquiryToolRow entry={e} query="" />,
        exchange: (e) => <EnquiryExchange entry={e} query="" />,
        'decision-list': (e) => <EnquiryDecisionList entry={e} query="" />,
        options: (e) => <EnquiryOptions entry={e} query="" />,
      };
      createRoot(document.getElementById('root')).render(<main className="bg-background text-foreground p-6 space-y-10">
        {Object.entries(variants).map(([name, render]) => (
          <section key={name} id={name} className="w-[720px] space-y-1 bg-background p-4">
            <TranscriptEntry entry={before} query="" sessionId="s" />
            {enquiries.map((e) => <React.Fragment key={e.id}>{render(e)}</React.Fragment>)}
            <TranscriptEntry entry={after} query="" sessionId="s" />
          </section>
        ))}
      </main>);
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
});
const assets = `${root}/web/dist/assets`;
const stylesheet = (await readdir(assets)).find((file) => /^index-.*\.css$/.test(file));
const css = await readFile(`${assets}/${stylesheet}`, "utf8");
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ deviceScaleFactor: 2 });
page.on("pageerror", (error) => console.error(error.message));
page.on("console", (message) => console.error(message.text()));
await page.setContent(`<style>${css}</style><div id="root"></div>`);
await page.addScriptTag({ content: bundle.outputFiles[0].text });
await page.waitForSelector("#options");
await page.evaluate(() => document.querySelectorAll("#tool-row-open details.group\\/tool").forEach((d) => { d.open = true; }));
for (const theme of ["light", "dark"]) {
  await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
  for (const name of ["current", "tool-row", "tool-row-open", "exchange", "decision-list", "options"]) {
    await page.locator(`#${name}`).screenshot({ path: `${out}/enquiry-${name}-${theme}.png` });
  }
}
await browser.close();
