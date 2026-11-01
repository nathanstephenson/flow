import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { FilesystemIsolationMode, FilesystemIsolationStatus } from "../../src/protocol/settings.ts";

// Render the real Settings furniture and Base UI controls without a browser. The Select popup is a
// portal that SSR omits, so its items are read from SelectContent's children. The host is a fixture;
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
          export const fixture = { config: {}, patches: [], messages: [], select: {}, items: {}, error: undefined };
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
      builder.onLoad({ filter: /\/ui\/select\.tsx$/ }, ({ path }) => ({
        contents: `import { fixture } from '@/host.tsx';\n` + readFileSync(path, "utf8")
          .replace(
            "const Select = SelectPrimitive.Root",
            "const Select = (props) => { fixture.select = props; return <SelectPrimitive.Root {...props} />; }",
          )
          .replace(
            "  return (\n    <SelectPrimitive.Portal>",
            "  React.Children.forEach(children, (item) => { if (item) fixture.items[item.props.value] = item.props; });\n  return (\n    <SelectPrimitive.Portal>",
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
    config: { filesystemIsolation?: FilesystemIsolationMode; filesystemIsolationStatus?: FilesystemIsolationStatus };
    patches: unknown[];
    messages: { type: string; message: string }[];
    select: { value: string; disabled: boolean; onValueChange: (value: string) => void };
    items: Record<string, { disabled?: boolean }>;
    error?: string;
  };
  render: () => string;
};
function show(status: Partial<FilesystemIsolationStatus>, mode?: FilesystemIsolationMode) {
  fixture.config = {
    ...(mode === undefined ? {} : { filesystemIsolation: mode }),
    filesystemIsolationStatus: {
      mode: mode ?? "bubblewrap",
      automatic: mode === undefined,
      checking: false,
      supported: true,
      sandbox: { supported: false, reason: "No sandbox provider is configured." },
      ...status,
    },
  };
  fixture.patches = [];
  fixture.messages = [];
  fixture.items = {};
  fixture.error = undefined;
  return render();
}
const flushed = () => new Promise<void>((resolve) => setImmediate(resolve));

test("automatic supported mode resolves to Bubblewrap without saving on render", () => {
  const html = show({});
  assert.match(html, /Machine-wide/);
  assert.match(html, /Automatic uses Bubblewrap when supported/);
  assert.match(html, /Bubblewrap supported — Linux, bubblewrap \(bwrap\), and namespaces/);
  assert.match(html, /Automatic — Bubblewrap/);
  assert.match(html, /Automatic choice/);
  assert.match(html, /Bubblewrap isolation for new work/);
  assert.match(html, /Sandbox unsupported. No sandbox provider is configured./);
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal(fixture.select.value, "automatic");
  assert.equal(fixture.select.disabled, false);
  assert.equal(fixture.items.bubblewrap?.disabled, false);
  assert.equal(fixture.items.sandbox?.disabled, true);
  assert.deepEqual(fixture.patches, []);
});

for (const reason of ["Linux is required", "bwrap was not found", "User namespaces are unavailable"]) {
  test(`unsupported automatic mode explains ${reason} and warns without saving a fallback`, async () => {
    const html = show({ supported: false, mode: "none", reason });
    assert.match(html, /Bubblewrap unsupported/);
    assert.ok(html.includes(reason));
    assert.match(html, /Automatic — Unrestricted/);
    assert.match(html, /role="alert"/);
    assert.match(html, /Unrestricted filesystem access/);
    assert.match(html, /agent tools, Workflow Shell steps, and local stdio MCP/);
    assert.match(html, /TypeScript&#x27;s scoped API/);
    assert.match(html, /supervisor is not OS-confined/);
    assert.match(html, /write or delete files outside the Scope and access host credentials/);
    assert.match(html, /Scope is only a working directory, not a security boundary/);
    assert.doesNotMatch(html, /Isolation cannot be enforced/);
    assert.equal(fixture.select.value, "automatic");
    assert.equal(fixture.items.bubblewrap?.disabled, true);
    await flushed();
    assert.deepEqual(fixture.patches, []);
    assert.deepEqual(fixture.messages, []);
  });
}

test("manual unrestricted mode warns on a supported machine and can choose Bubblewrap", async () => {
  const html = show({}, "none");
  assert.match(html, /Manual choice/);
  assert.match(html, /unrestricted for new work/);
  assert.match(html, /Unrestricted filesystem access for new work/);
  assert.equal(fixture.select.value, "none");
  assert.equal(fixture.items.bubblewrap?.disabled, false);
  fixture.select.onValueChange("bubblewrap");
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: "bubblewrap" }]);
  assert.match(fixture.messages[0]!.message, /Filesystem isolation setting saved — applies to new work/);
});

test("choosing a mode is an immediate save; choosing Automatic sends null, not a detected default", async () => {
  show({}, "bubblewrap");
  fixture.select.onValueChange("none");
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: "none" }]);
  show({ supported: false }, "none");
  fixture.select.onValueChange("automatic");
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: null }]);
  assert.match(fixture.messages[0]!.message, /Automatic filesystem isolation restored — applies to new work/);
});

test("explicit Bubblewrap on an unsupported machine is not represented as successful isolation", async () => {
  const html = show({ supported: false, reason: "bwrap missing" }, "bubblewrap");
  assert.match(html, /Bubblewrap isolation requested, but cannot run/);
  assert.match(html, /New work requiring it cannot run/);
  assert.doesNotMatch(html, /Bubblewrap isolation for new work/);
  assert.equal(fixture.select.value, "bubblewrap");
  assert.equal(fixture.items.bubblewrap?.disabled, false); // The current choice stays selectable.
  fixture.select.onValueChange("none");
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: "none" }]);
});

test("explicit Sandbox without a sandbox provider shows its reason and cannot run", () => {
  const html = show({}, "sandbox");
  assert.match(html, /Sandbox unsupported. No sandbox provider is configured./);
  assert.match(html, /Sandbox isolation requested, but cannot run/);
  assert.match(html, /Isolation cannot be enforced on this machine/);
  assert.doesNotMatch(html, /Unrestricted filesystem access/);
  assert.equal(fixture.select.value, "sandbox");
  assert.equal(fixture.items.sandbox?.disabled, false);
});

test("supported Sandbox is selectable and saved as sandbox", async () => {
  const html = show({ sandbox: { supported: true } });
  assert.match(html, /Sandbox supported./);
  assert.equal(fixture.items.sandbox?.disabled, false);
  fixture.select.onValueChange("sandbox");
  await flushed();
  assert.deepEqual(fixture.patches, [{ filesystemIsolation: "sandbox" }]);
});

test("checking support does not present an unchecked probe as unsupported or allow Bubblewrap", () => {
  const html = show({ checking: true, supported: false });
  assert.match(html, /Checking filesystem isolation support/);
  assert.match(html, /effective mode not yet confirmed/);
  assert.match(html, /Automatic — checking…/);
  assert.doesNotMatch(html, /Bubblewrap unsupported/);
  assert.doesNotMatch(html, /role="alert"/);
  assert.equal(fixture.items.bubblewrap?.disabled, true);
  assert.deepEqual(fixture.patches, []);
});

test("a refused save reports the host error without a success message or optimistic mode", async () => {
  show({}, "none");
  fixture.error = "Filesystem isolation cannot be enforced";
  fixture.select.onValueChange("bubblewrap");
  await flushed();
  assert.deepEqual(fixture.messages, [{ type: "error", message: fixture.error }]);
  assert.equal(fixture.config.filesystemIsolation, "none");
  assert.equal(fixture.config.filesystemIsolationStatus?.mode, "none");
});

test("lifetime copy states that existing work retains its starting mode", () => {
  const html = show({});
  assert.match(html, /new Backend Sessions \(including Revive\), new Workflow Executions, and new local/);
  assert.match(html, /MCP clients. Existing work keeps the mode it started with, including Workflow recovery/);
  assert.match(html, /Support is checked at Session Host startup/);
  assert.match(html, /aria-label="Filesystem isolation mode"/);
  assert.match(html, /aria-describedby="filesystem-isolation-support"/);
});
