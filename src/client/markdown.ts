import { marked, type Token, type Tokens } from "marked";

/**
 * Markdown, lexed once into a tree both front-ends can render.
 *
 * Only `marked.lexer()` is ever called — never `marked.parse()`. The parser's job is to produce an
 * HTML string, and an HTML string is the one thing a Presentation Transcript may not be built from:
 * `highlighted.tsx` records that there is no `dangerouslySetInnerHTML` anywhere near this record, and
 * search highlighting has to reach the leaf text nodes, which it cannot do through a string. So the
 * lexer's tokens are normalised here and each front-end turns them into its own elements — the same
 * split `src/client/search.ts` and `web/src/components/highlighted.tsx` already use, for the same
 * reason. See docs/adr/0012.
 *
 * The union below is ours rather than marked's `Token` so that a renderer's switch is exhaustive: a
 * kind nobody handled is a compile error rather than a blank space on screen. It also puts the two
 * decisions that matter — raw HTML is text, and which link schemes survive — in a module with tests,
 * instead of in a component.
 *
 * **Nothing the model wrote is dropped.** ADR 0001 defines this record as what a human saw, so a
 * construct we did not model (`html`, a link reference definition, an image) renders as its own
 * verbatim source rather than vanishing. That rule is why there is no `default:` that returns
 * `undefined` anywhere below.
 */

export type MdAlign = "left" | "center" | "right" | undefined;
export type MdHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type MdInline =
  | { kind: "text"; text: string }
  | { kind: "strong" | "em" | "del"; inlines: MdInline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; inlines: MdInline[] }
  | { kind: "break" };

export type MdBlock =
  | { kind: "paragraph"; inlines: MdInline[] }
  | { kind: "heading"; level: MdHeadingLevel; inlines: MdInline[] }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "list"; ordered: boolean; start?: number; items: MdBlock[][] }
  | { kind: "quote"; blocks: MdBlock[] }
  | { kind: "table"; header: MdInline[][]; rows: MdInline[][][]; align: readonly MdAlign[] }
  | { kind: "rule" };

export function parseMarkdown(text: string): MdBlock[] {
  if (text === "") return [];
  try {
    return toBlocks(marked.lexer(text));
  } catch {
    // A throw here happens during a React render, where it would take down the whole pane rather
    // than one Entry. Half a markdown document is exactly what streaming produces, so the input this
    // runs on is never known-good; showing the source is always better than showing nothing.
    return [{ kind: "paragraph", inlines: [{ kind: "text", text }] }];
  }
}

/**
 * The schemes a transcript will turn into an anchor. Everything else — `javascript:`, `data:`, a
 * relative path with no base to resolve against — falls back to rendering the link's own source, so
 * the reader sees where it pointed instead of a label hiding it.
 */
const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function safeHref(href: string): string | undefined {
  try {
    // The original string is returned rather than `url.href`, so the anchor points at what the model
    // actually wrote instead of the URL parser's normalisation of it.
    return SAFE_SCHEMES.has(new URL(href).protocol) ? href : undefined;
  } catch {
    return undefined;
  }
}

const HEADING_LEVELS = [1, 2, 3, 4, 5, 6] as const;

function toBlocks(tokens: Token[]): MdBlock[] {
  return tokens.flatMap(toBlock);
}

/**
 * marked's `Token` union carries a `Tokens.Generic` member with a string index signature, so
 * narrowing on `.type` leaves every branch as `X | Generic` and neither a cast nor an `in` check can
 * be avoided. The lexer does emit the documented shape for each `type`, so the casts below are where
 * that is asserted once — deliberately at the boundary, so nothing past this module has to.
 */
function toBlock(token: Token): MdBlock[] {
  switch (token.type) {
    case "space":
      return [];
    case "heading":
      return [
        { kind: "heading", level: HEADING_LEVELS[token.depth - 1] ?? 6, inlines: toInlines(token.tokens) ?? [] },
      ];
    case "paragraph":
      return [{ kind: "paragraph", inlines: toInlines(token.tokens) ?? [] }];
    // At block position a `text` token is a paragraph that marked did not wrap — which is what every
    // item of a tight list is made of.
    case "text":
      return [{ kind: "paragraph", inlines: toInlines(token.tokens) ?? verbatim(token) }];
    case "code":
      return [{ kind: "code", text: token.text, ...(token.lang ? { lang: token.lang } : {}) }];
    case "blockquote":
      return [{ kind: "quote", blocks: toBlocks(token.tokens ?? []) }];
    case "hr":
      return [{ kind: "rule" }];
    case "list":
      return [toList(token as Tokens.List)];
    case "table":
      return [toTable(token as Tokens.Table)];
    default:
      return [{ kind: "paragraph", inlines: verbatim(token) }];
  }
}

function toList(token: Tokens.List): MdBlock {
  // `start` is `""` on an unordered list and `1` on an ordered one that did not ask for anything
  // else; neither is worth carrying, and `exactOptionalPropertyTypes` means the key is spread in
  // rather than set to undefined.
  const start = token.ordered && typeof token.start === "number" && token.start !== 1 ? token.start : undefined;
  return {
    kind: "list",
    ordered: token.ordered,
    items: token.items.map(toListItem),
    ...(start === undefined ? {} : { start }),
  };
}

/**
 * A task list's checkbox arrives as its own block-level token ahead of the item's text. Rendered as
 * a block it would sit on a line of its own, so the marker is folded into the item's first
 * paragraph — and it is written as the `[x]` the model typed rather than a glyph invented here.
 */
function toListItem(item: Tokens.ListItem): MdBlock[] {
  const blocks = toBlocks(item.tokens.filter((token) => token.type !== "checkbox"));
  if (!item.task) return blocks;

  const marker: MdInline = { kind: "text", text: item.checked ? "[x] " : "[ ] " };
  const [first, ...rest] = blocks;
  return first?.kind === "paragraph"
    ? [{ kind: "paragraph", inlines: [marker, ...first.inlines] }, ...rest]
    : [{ kind: "paragraph", inlines: [marker] }, ...blocks];
}

function toTable(token: Tokens.Table): MdBlock {
  const cells = (row: Tokens.TableCell[]): MdInline[][] => row.map((cell) => toInlines(cell.tokens) ?? []);
  return {
    kind: "table",
    header: cells(token.header),
    rows: token.rows.map(cells),
    align: token.align.map((align) => align ?? undefined),
  };
}

function toInlines(tokens: Token[] | undefined): MdInline[] | undefined {
  return tokens?.flatMap(toInline);
}

function toInline(token: Token): MdInline[] {
  switch (token.type) {
    // A `text` token carrying its own tokens is a nested run, not a leaf — the shape a list item's
    // text and an autolink's label both take.
    case "text":
      return toInlines(token.tokens) ?? [{ kind: "text", text: token.text }];
    case "escape":
      return [{ kind: "text", text: token.text }];
    case "strong":
    case "em":
    case "del":
      return [{ kind: token.type, inlines: toInlines(token.tokens) ?? [] }];
    case "codespan":
      return [{ kind: "code", text: token.text }];
    case "br":
      return [{ kind: "break" }];
    case "link":
      return [toLink(token as Tokens.Link)];
    // Raw HTML the model emitted, inline or as a block, is text. This is the whole reason the lexer
    // is used without the parser: there is no path here by which `<script>` becomes a script.
    case "html":
      return [{ kind: "text", text: token.text }];
    default:
      return verbatim(token);
  }
}

function toLink(token: Tokens.Link): MdInline {
  const href = safeHref(token.href);
  return href === undefined
    ? { kind: "text", text: token.raw }
    : { kind: "link", href, inlines: toInlines(token.tokens) ?? [{ kind: "text", text: token.text }] };
}

/** A construct this module does not model, shown as the source the model wrote. */
function verbatim(token: Token): MdInline[] {
  return [{ kind: "text", text: token.raw }];
}
