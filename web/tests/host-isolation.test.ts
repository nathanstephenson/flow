import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import type { HostValue } from "../src/host.tsx";

// Exercise the actual saveSettings HTTP callback and useHost context. SSR does not run effects or
// state updates, so only HostProvider's gate is replaced with a controllable in-memory state cell.
const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { HostProvider, useHost } from '@/host.tsx';
      import { fixture } from 'host-fixture';
      export { fixture };
      function Probe() { fixture.value = useHost(); return null; }
      export function render() { renderToStaticMarkup(<HostProvider><Probe /></HostProvider>); return fixture.value; }
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
    name: "host-settings-state-fixture",
    setup(builder) {
      builder.onResolve({ filter: /^host-fixture$/ }, () => ({ path: "host-fixture", namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `export const fixture = {
          gate: { state: 'ready', config: {} },
          setGate(update) { fixture.gate = typeof update === 'function' ? update(fixture.gate) : update; },
          response: {}, ok: true, status: 200, requests: [], value: undefined,
        };`,
        loader: "js",
      }));
      builder.onLoad({ filter: /\/web\/src\/host\.tsx$/ }, ({ path }) => ({
        contents: `import { fixture } from 'host-fixture';\n` + readFileSync(path, "utf8").replace(
          'const [gate, setGate] = useState<Gate>({ state: "loading" });',
          "const gate = fixture.gate; const setGate = fixture.setGate;",
        ),
        loader: "tsx",
      }));
      builder.onLoad({ filter: /\/web\/src\/fonts\.ts$/ }, () => ({ contents: "export function applyFonts() {}", loader: "js" }));
      builder.onLoad({ filter: /\/web\/src\/store\/host\.ts$/ }, () => ({ contents: "export const host = {};", loader: "js" }));
      builder.onLoad({ filter: /\/web\/src\/authentication\.ts$/ }, () => ({
        contents: `import { fixture } from 'host-fixture';
          export async function authenticatedFetch(url, init) {
            fixture.requests.push({ url, ...init });
            return { ok: fixture.ok, status: fixture.status, json: async () => fixture.response };
          }`,
        loader: "js",
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
    gate: { state: "ready"; config: HostValue["config"] };
    response: Record<string, unknown>;
    requests: { url: string; method?: string; body?: string }[];
    ok: boolean;
    status: number;
  };
  render: () => HostValue;
};

const isolated = { supported: true, enabled: true, automatic: true, checking: false };
const unrestricted = { ...isolated, enabled: false, automatic: false };

test("PUT replaces mode and runtime status, then omission clears a manual override on reset", async () => {
  fixture.gate = { state: "ready", config: { scope: "/scope", backends: ["pi"], filesystemIsolationStatus: isolated } };
  fixture.ok = true;
  fixture.response = { filesystemIsolation: false, filesystemIsolationStatus: unrestricted };
  await render().saveSettings({ filesystemIsolation: false });
  let value = render();
  assert.equal(value.config.filesystemIsolation, false);
  assert.deepEqual(value.config.filesystemIsolationStatus, unrestricted);
  assert.equal(value.config.scope, "/scope");
  assert.deepEqual(JSON.parse(fixture.requests.at(-1)!.body!), { filesystemIsolation: false });

  fixture.response = { filesystemIsolationStatus: isolated };
  await value.saveSettings({ filesystemIsolation: null });
  value = render();
  assert.equal(value.config.filesystemIsolation, undefined);
  assert.deepEqual(value.config.filesystemIsolationStatus, isolated);
  assert.deepEqual(JSON.parse(fixture.requests.at(-1)!.body!), { filesystemIsolation: null });
});

test("a refused PUT keeps the previous mode and status", async () => {
  fixture.gate = { state: "ready", config: { scope: "/scope", backends: ["pi"], filesystemIsolation: false, filesystemIsolationStatus: unrestricted } };
  fixture.ok = false;
  fixture.status = 400;
  fixture.response = { error: "Linux namespaces are unavailable" };
  await assert.rejects(render().saveSettings({ filesystemIsolation: true }), /Linux namespaces are unavailable/);
  assert.equal(render().config.filesystemIsolation, false);
  assert.deepEqual(render().config.filesystemIsolationStatus, unrestricted);
});

test("PUT updates MCP connections and clears deleted definitions without refresh", async () => {
  const connection = { id: "local", name: "Local", transport: "stdio" as const, command: "example-mcp", args: [], enabledByDefault: true };
  fixture.gate = { state: "ready", config: { scope: "/scope", backends: ["pi"], mcp: [] } };
  fixture.ok = true;
  fixture.response = { mcp: [connection] };
  await render().saveSettings({ mcp: [connection] });
  assert.deepEqual(render().config.mcp, [connection]);
  assert.equal(render().config.scope, "/scope");

  fixture.response = { mcp: [] };
  await render().saveSettings({ mcp: [] });
  assert.deepEqual(render().config.mcp, []);

  fixture.response = {};
  await render().saveSettings({ mcp: [] });
  assert.equal(render().config.mcp, undefined);
});

test("GET refresh replaces runtime status and clears a stale manual override", async () => {
  fixture.ok = true;
  fixture.status = 200;
  fixture.response = { scope: "/scope", backends: ["pi"], filesystemIsolationStatus: isolated };
  await render().refresh();
  assert.equal(render().config.filesystemIsolation, undefined);
  assert.deepEqual(render().config.filesystemIsolationStatus, isolated);
});
