import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { FilesystemIsolationStatus } from "../../src/protocol/settings.ts";

// Render the real Settings furniture and Base UI controls without a browser. The host is a fixture;
// instrumentation captures control callbacks without replacing their rendering or styling.
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { IsolationSettings } from '@/components/settings-isolation.tsx';
      export { fixture } from '@/host.tsx';
      export function render() { return renderToStaticMarkup(<IsolationSettings />); }
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  plugins: [{
    name: "isolation-settings-fixture",
    setup(builder) {
      builder.onLoad({ filter: /\/web\/src\/host\.tsx$/ }, () => ({
        contents: `
          export const fixture = { config: {}, patches: [], messages: [], switch: {}, button: {}, error: undefined };
          export function useHost() {
            return { config: fixture.config, refresh: async () => {}, saveSettings: async (patch) => {
              fixture.patches.push(patch);
              if (fixture.error) throw new Error(fixture.error);
              return {};
            } };
          }
        `,
        loader: "tsx",
      }));
      builder.onLoad({ filter: /\/ui\/(switch|button)\.tsx$/ }, ({ path }) => ({
        contents: `import { fixture } from '@/host.tsx';\n` + readFileSync(path, "utf8").replace(
          "  return (",
          `  fixture.${path.endsWith("switch.tsx") ? "switch" : "button"} = props;\n  return (`,
        ),
        loader: "tsx",
      }));
      builder.onLoad({ filter: /\/ui\/toaster\.tsx$/ }, () => ({
        contents: `
          import { fixture } from '@/host.tsx';
          export const toast = {
            info: (message) => fixture.messages.push({ type: 'info', message }),
            error: (message) => fixture.messages.push({ type: 'error', message }),
          };
        `,
        loader: "tsx",
      }));
    },
  }],
});
const compiled = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0]!.text)(
  compiled, compiled.exports, createRequire(import.meta.url),
);
const { fixture, render } = compiled.exports as {
  fixture: {
    config: { filesystemIsolation?: boolean; filesystemIsolationStatus?: FilesystemIsolationStatus };
    patches: unknown[];
    messages: { type: string; message: string }[];
    switch: { checked: boolean; disabled: boolean; onCheckedChange: (value: boolean) => void };
    button: { disabled: boolean; onClick: () => void };
    error?: string;
  };
  render: () => string;
};
function show(status: Partial<FilesystemIsolationStatus>, mode?: boolean) {
  fixture.config = {
    ...(mode === undefined ? {} : { filesystemIsolation: mode }),
    filesystemIsolationStatus: { supported: true, enabled: true, automatic: true, checking: false, ...status },
  };
  fixture.patches = [];
  fixture.messages = [];
  fixture.error = undefined;
  return render();
}
const flushed = () => new Promise<void>((resolve) => setImmediate(resolve));

test("automatic supported mode defaults on without saving on render", () => {
  const html = show({});
  assert.match(html, /Machine-wide/);
  assert.match(html, /Automatic mode enables isolation by default when supported/);
  assert.match(html, /Supported — Linux, bubblewrap \(bwrap\), and namespaces/);
  assert.match(html, /Automatic choice/);
  assert.match(html, /isolation enabled for new work/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal(fixture.switch.checked, true);
  assert.equal(fixture.switch.disabled, false);
  assert.equal(fixture.button.disabled, true);
  assert.deepEqual(fixture.patches, []);
});

for (const reason of ["Linux is required", "bwrap was not found", "User namespaces are unavailable"]) {
  test(`unsupported automatic mode explains ${reason} and warns without saving a fallback`, async () => {
    const html = show({ supported: false, enabled: false, reason });
    assert.match(html, /Unsupported/);
    assert.ok(html.includes(reason));
    assert.match(html, /role="alert"/);
    assert.match(html, /Unrestricted filesystem access/);
    assert.match(html, /agent tools, Workflow Shell steps, and local stdio MCP/);
    assert.match(html, /TypeScript&#x27;s scoped API/);
    assert.match(html, /supervisor is not OS-confined/);
    assert.match(html, /write or delete files outside the Scope and access host credentials/);
    assert.match(html, /Scope is only a working directory, not a security boundary/);
    assert.equal(fixture.switch.checked, false);
    assert.equal(fixture.switch.disabled, true);
    fixture.switch.onCheckedChange(true); // Guard even if a stale UI event arrives.
    await flushed();
    assert.deepEqual(fixture.patches, []);
    assert.deepEqual(fixture.messages, []);
  });
}

test("manual off remains unrestricted on a supported machine and can be enabled", async () => {
  const html = show({ enabled: false, automatic: false }, false);
  assert.match(html, /Manual choice/);
  assert.match(html, /Unrestricted filesystem access/);
  assert.equal(fixture.switch.disabled, false);
  assert.equal(fixture.button.disabled, false);
  fixture.switch.onCheckedChange(true);
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: true }]);
});

test("turning off is an explicit immediate save; resetting sends null, not a detected default", async () => {
  show({ automatic: false }, true);
  fixture.switch.onCheckedChange(false);
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: false }]);
  show({ automatic: false, enabled: false, supported: false }, false);
  fixture.button.onClick();
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: null }]);
  assert.match(fixture.messages[0]!.message, /Automatic filesystem isolation restored/);
});

test("explicit isolation on an unsupported machine is not represented as successful isolation", async () => {
  const html = show({ automatic: false, supported: false, reason: "bwrap missing" }, true);
  assert.match(html, /isolation requested, but cannot run/);
  assert.match(html, /New work requiring it cannot run/);
  assert.doesNotMatch(html, /isolation enabled for new work/);
  assert.equal(fixture.switch.checked, true);
  assert.equal(fixture.switch.disabled, false); // Turning it off must remain possible.
  fixture.switch.onCheckedChange(false);
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: false }]);
});

test("checking support does not present an unchecked probe as unsupported or allow enabling", async () => {
  const html = show({ checking: true, supported: false, enabled: false });
  assert.match(html, /Checking filesystem isolation support/);
  assert.match(html, /effective mode not yet confirmed/);
  assert.doesNotMatch(html, /Unsupported —/);
  assert.equal(fixture.switch.disabled, true);
  fixture.switch.onCheckedChange(true);
  await flushed();
  assert.deepEqual(fixture.patches, []);
});

test("a refused save reports the host error without a success message or optimistic mode", async () => {
  show({ automatic: false, enabled: false }, false);
  fixture.error = "Filesystem isolation cannot be enforced";
  fixture.switch.onCheckedChange(true);
  await flushed();
  assert.deepEqual(fixture.messages, [{ type: "error", message: fixture.error }]);
  assert.equal(fixture.config.filesystemIsolation, false);
  assert.equal(fixture.config.filesystemIsolationStatus?.enabled, false);
});

test("lifetime copy states that existing work retains its starting mode", () => {
  const html = show({});
  assert.match(html, /new Backend Sessions \(including Revive\), new Workflow Executions, and new local/);
  assert.match(html, /MCP clients. Existing work keeps the mode it started with, including Workflow recovery/);
  assert.match(html, /Support is checked at Session Host startup/);
  assert.match(html, /aria-label="Enable filesystem isolation"/);
  assert.match(html, /aria-describedby="filesystem-isolation-support"/);
});
