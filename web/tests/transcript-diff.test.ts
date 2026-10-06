import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../../", import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { renderToStaticMarkup } from 'react-dom/server';
      import { parseMarkdown } from '@client/markdown.ts';
      import { Markdown } from '@/components/markdown.tsx';
      import { EditDiffView, ToolPayloadView } from '@/components/edit-diff-view.tsx';
      export function markdown(text, query = '', streaming = false) {
        return renderToStaticMarkup(<Markdown blocks={parseMarkdown(text)} query={query}
          trailing={streaming ? <span data-caret="true" /> : undefined} />);
      }
      export function payload(result, query = '') {
        return renderToStaticMarkup(<ToolPayloadView entry={{kind: 'tool', result}} query={query} />);
      }
      export function edit() {
        return renderToStaticMarkup(<EditDiffView input={{old_string: 'old', new_string: 'new'}} query="" />);
      }
    `,
    resolveDir: root,
    loader: "tsx",
  },
  tsconfig: `${root}/web/tsconfig.json`,
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
});
const compiled = { exports: {} };
new Function("module", "exports", "require", bundle.outputFiles[0]!.text)(
  compiled, compiled.exports, createRequire(import.meta.url),
);
const { markdown, payload, edit } = compiled.exports as {
  markdown: (text: string, query?: string, streaming?: boolean) => string;
  payload: (value: unknown, query?: string) => string;
  edit: () => string;
};

const unified = "--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new\n";
const removed = "bg-destructive/10 text-destructive";
const added = "bg-diff-added/10 text-diff-added";

function assertColours(html: string) {
  assert.ok(html.includes(removed));
  assert.ok(html.includes(added));
}

test("fenced diff/patch blocks use the same colour classes as edit tools", () => {
  assertColours(edit());
  for (const lang of ["diff", "patch"]) {
    const html = markdown(`\`\`\`${lang}\n${unified}\`\`\``);
    assertColours(html);
    assert.match(html, /--- a\/file<\/span>\n/);
    assert.match(html, /\+\+\+ b\/file<\/span>\n/);
    assert.match(html, /@@ -1 \+1 @@<\/span>\n/);
    assert.match(html, /text-destructive">-old<\/span>\n/);
    assert.match(html, /text-diff-added">\+new/);
  }
});

test("diff blocks keep search marks, literal HTML and the streaming caret", () => {
  const html = markdown("```diff\n-old <script>\n+new <script>", "script", true);
  assertColours(html);
  assert.match(html, /&lt;<\/span><mark[^>]*>script<\/mark><span>&gt;/);
  assert.ok(!html.includes("<script>"));
  assert.equal((html.match(/data-caret=/g) ?? []).length, 1);
  assert.match(html, /text-diff-added">[\s\S]*data-caret="true"/);
  assert.match(markdown("```diff", "", true), /data-caret="true"/);
});

test("nested and unlabelled unified diff blocks are coloured, ordinary code is not", () => {
  assertColours(markdown(`> \`\`\`diff\n> -old\n> +new\n> \`\`\``));
  assertColours(markdown(`\`\`\`\n${unified}\`\`\``));
  for (const text of ["```js\n-old;\n+new;\n```", "```\n-old\n+new\n```", "`+new` and ordinary prose"]) {
    assert.ok(!markdown(text).includes(added));
    assert.ok(!markdown(text).includes(removed));
  }
});

test("structured Pi tool results colour text diffs without losing metadata or other content", () => {
  const html = payload({
    content: [
      { type: "text", text: unified, annotation: "diff annotation" },
      { type: "text", text: "ordinary output" },
      { type: "image", data: "image-bytes", mimeType: "image/png" },
    ],
    details: { exitCode: 0, diff: "details are retained" },
    extra: "top-level metadata",
  }, "old");
  assertColours(html);
  assert.match(html, /<mark[^>]*>old<\/mark>/);
  for (const text of ["diff annotation", "ordinary output", "image-bytes", "image/png", "exitCode", "details are retained", "top-level metadata"]) {
    assert.ok(html.includes(text), text);
  }
});

test("non-diff structured output and oversized structured diffs retain the existing JSON view", () => {
  for (const text of ["-ordinary\n+output", unified + " ".repeat(20_000)]) {
    const html = payload({ content: [{ type: "text", text }], details: { exitCode: 0 } });
    assert.ok(!html.includes(added));
    assert.ok(!html.includes("content 1 metadata"));
    assert.ok(html.includes("exitCode"));
  }
});

test("unified tool output is coloured and searchable, ordinary or huge output stays plain", () => {
  assertColours(payload(unified, "old"));
  assert.match(payload(unified, "old"), /<mark[^>]*>old<\/mark>/);
  assert.ok(!payload("-ordinary\n+output").includes(added));
  assert.ok(!payload(unified + " ".repeat(20_000)).includes(added));
});
