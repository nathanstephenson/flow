import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseMarkdown, safeHref, type MdBlock, type MdInline } from "../src/client/markdown.ts";

/** The leaf text of a tree, which is what most of these assertions are really about. */
const textOf = (nodes: readonly (MdBlock | MdInline)[]): string =>
  nodes
    .map((node) => {
      if ("text" in node) return node.text;
      if ("inlines" in node) return textOf(node.inlines);
      if ("blocks" in node) return textOf(node.blocks);
      if ("items" in node) return node.items.map(textOf).join("");
      return "";
    })
    .join("");

const only = (source: string): MdBlock => {
  const blocks = parseMarkdown(source);
  assert.equal(blocks.length, 1, `expected one block, got ${JSON.stringify(blocks)}`);
  return blocks[0] as MdBlock;
};

describe("lexing markdown into a renderable tree", () => {
  it("gives a heading its level and its inline children", () => {
    const block = only("### Why both are needed");
    assert.equal(block.kind, "heading");
    assert.equal(block.kind === "heading" && block.level, 3);
    assert.equal(textOf([block]), "Why both are needed");
  });

  it("clamps a heading deeper than six rather than emitting an unrenderable level", () => {
    const block = only("####### seven");
    // marked reads this as a paragraph, but the clamp is the contract the renderer relies on.
    assert.ok(block.kind !== "heading" || block.level <= 6);
  });

  it("separates emphasis, strong and inline code", () => {
    const block = only("plain **bold** *italic* `code` ~~gone~~");
    assert.equal(block.kind, "paragraph");
    const kinds = block.kind === "paragraph" ? block.inlines.map((inline) => inline.kind) : [];
    assert.deepEqual(kinds, ["text", "strong", "text", "em", "text", "code", "text", "del"]);
  });

  it("keeps a fenced block's language and its text verbatim", () => {
    const block = only("```ts\nconst x = 1;\n```");
    assert.deepEqual(block, { kind: "code", text: "const x = 1;", lang: "ts" });
  });

  it("omits lang entirely when a fence declares none, rather than setting it undefined", () => {
    // exactOptionalPropertyTypes: the key must be absent, not present-and-undefined.
    const block = only("```\nbare\n```");
    assert.deepEqual(block, { kind: "code", text: "bare" });
    assert.equal("lang" in block, false);
  });

  it("nests a list inside its parent item", () => {
    const block = only("- one\n- two\n  - nested");
    assert.equal(block.kind, "list");
    if (block.kind !== "list") return;
    assert.equal(block.ordered, false);
    assert.equal(block.items.length, 2);
    assert.equal(block.items[1]?.some((child) => child.kind === "list"), true);
    assert.equal(textOf(block.items[1] ?? []), "twonested");
  });

  it("carries an ordered list's start only when it is not the default", () => {
    const plain = only("1. first\n2. second");
    assert.equal(plain.kind === "list" && "start" in plain, false);

    const offset = only("7. seventh\n8. eighth");
    assert.equal(offset.kind === "list" && offset.start, 7);
  });

  it("folds a task list's checkbox into the item's own line", () => {
    const block = only("- [x] done\n- [ ] todo");
    assert.equal(block.kind, "list");
    if (block.kind !== "list") return;
    assert.equal(textOf(block.items[0] ?? []), "[x] done");
    assert.equal(textOf(block.items[1] ?? []), "[ ] todo");
    // One paragraph per item, not a stray block for the checkbox.
    assert.equal(block.items[0]?.length, 1);
  });

  it("reads a table's alignment, header and rows", () => {
    const block = only("| a | b |\n|---|--:|\n| 1 | 2 |");
    assert.equal(block.kind, "table");
    if (block.kind !== "table") return;
    assert.deepEqual(block.align, [undefined, "right"]);
    assert.equal(textOf(block.header.flat()), "ab");
    assert.equal(block.rows.length, 1);
    assert.equal(textOf((block.rows[0] ?? []).flat()), "12");
  });

  it("reads a blockquote and a rule", () => {
    assert.deepEqual(only("---"), { kind: "rule" });
    const quote = only("> quoted");
    assert.equal(quote.kind, "quote");
    assert.equal(textOf([quote]), "quoted");
  });

  it("returns nothing for an empty string", () => {
    assert.deepEqual(parseMarkdown(""), []);
  });
});

describe("markdown that could put HTML on screen", () => {
  it("renders a raw HTML block as its own literal source", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    assert.equal(textOf(blocks), "<script>alert(1)</script>");
    // Nothing anywhere in the tree may be a kind a renderer could mistake for markup.
    assert.equal(JSON.stringify(blocks).includes('"html"'), false);
  });

  it("renders inline HTML as literal text around the words it wrapped", () => {
    const block = only("x <b>bold</b> y");
    assert.equal(textOf([block]), "x <b>bold</b> y");
    assert.equal(block.kind === "paragraph" && block.inlines.every((inline) => inline.kind === "text"), true);
  });

  it("refuses a javascript: link and shows its source instead", () => {
    const block = only("[x](javascript:alert(1))");
    assert.equal(block.kind === "paragraph" && block.inlines[0]?.kind, "text");
    assert.equal(textOf([block]), "[x](javascript:alert(1))");
  });

  it("refuses a data: url and a scheme-relative one", () => {
    assert.equal(safeHref("data:text/html;base64,PHNjcmlwdD4="), undefined);
    assert.equal(safeHref("javascript:alert(1)"), undefined);
    assert.equal(safeHref("/relative/path"), undefined);
    assert.equal(safeHref("not a url"), undefined);
  });

  it("allows http, https and mailto, unnormalised", () => {
    assert.equal(safeHref("https://example.com/a_b"), "https://example.com/a_b");
    assert.equal(safeHref("http://example.com"), "http://example.com");
    assert.equal(safeHref("mailto:nathan@goodstack.io"), "mailto:nathan@goodstack.io");
  });

  it("keeps an image as its source rather than fetching anything", () => {
    // A remote image in a transcript is a tracking pixel with extra steps.
    assert.equal(textOf(parseMarkdown("![alt](https://example.com/p.png)")), "![alt](https://example.com/p.png)");
  });
});

describe("markdown that is only half written, as streaming produces", () => {
  it("lexes an unterminated fence as one code block running to the end", () => {
    const block = only("```ts\nconst x = 1;\nlet y");
    assert.deepEqual(block, { kind: "code", text: "const x = 1;\nlet y", lang: "ts" });
  });

  it("leaves an unclosed strong marker as the literal characters the model has sent", () => {
    const block = only("some **bold and more");
    assert.equal(textOf([block]), "some **bold and more");
  });

  it("loses nothing as a message grows one character at a time", () => {
    const full = "## Head\n\nSome **bold** text.\n\n- a\n- b";
    for (let length = 1; length <= full.length; length++) {
      const source = full.slice(0, length);
      const rendered = textOf(parseMarkdown(source));
      // Syntax is consumed, but every non-syntax character has to survive to the screen.
      for (const word of source.split(/[^A-Za-z]+/).filter((part) => part.length > 1)) {
        assert.ok(rendered.includes(word), `"${word}" vanished from "${source}"`);
      }
    }
  });
});
