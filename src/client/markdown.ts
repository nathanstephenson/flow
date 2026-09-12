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
  | { kind: "image"; src: string; alt: string }
  | { kind: "break" };

export type MdBlock =
  | { kind: "paragraph"; inlines: MdInline[] }
  | { kind: "heading"; level: MdHeadingLevel; inlines: MdInline[] }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "list"; ordered: boolean; start?: number; items: MdBlock[][] }
  | { kind: "quote"; blocks: MdBlock[] }
  | { kind: "table"; header: MdInline[][]; rows: MdInline[][][]; align: readonly MdAlign[] }
  | { kind: "rule" };

export type MarkdownOptions = { images?: boolean; linkBase?: string; imageBase?: string };

export function parseMarkdown(text: string, options: MarkdownOptions = {}): MdBlock[] {
  if (text === "") return [];
  try {
    return toBlocks(marked.lexer(text), options);
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

function toBlocks(tokens: Token[], options: MarkdownOptions): MdBlock[] {
  return tokens.flatMap((token) => toBlock(token, options));
}

/**
 * marked's `Token` union carries a `Tokens.Generic` member with a string index signature, so
 * narrowing on `.type` leaves every branch as `X | Generic` and neither a cast nor an `in` check can
 * be avoided. The lexer does emit the documented shape for each `type`, so the casts below are where
 * that is asserted once — deliberately at the boundary, so nothing past this module has to.
 */
function toBlock(token: Token, options: MarkdownOptions): MdBlock[] {
  switch (token.type) {
    case "space":
      return [];
    case "heading":
      return [
        { kind: "heading", level: HEADING_LEVELS[token.depth - 1] ?? 6, inlines: toInlines(token.tokens, options) ?? [] },
      ];
    case "paragraph":
      return [{ kind: "paragraph", inlines: toInlines(token.tokens, options) ?? [] }];
    // At block position a `text` token is a paragraph that marked did not wrap — which is what every
    // item of a tight list is made of.
    case "text":
      return [{ kind: "paragraph", inlines: toInlines(token.tokens, options) ?? verbatim(token) }];
    case "code":
      return [{ kind: "code", text: token.text, ...(token.lang ? { lang: token.lang } : {}) }];
    case "blockquote":
      return [{ kind: "quote", blocks: toBlocks(token.tokens ?? [], options) }];
    case "hr":
      return [{ kind: "rule" }];
    case "list":
      return [toList(token as Tokens.List, options)];
    case "table":
      return [toTable(token as Tokens.Table, options)];
    case "html":
      return [{ kind: "paragraph", inlines: htmlImages(token.raw, options) }];
    default:
      return [{ kind: "paragraph", inlines: verbatim(token) }];
  }
}

function toList(token: Tokens.List, options: MarkdownOptions): MdBlock {
  // `start` is `""` on an unordered list and `1` on an ordered one that did not ask for anything
  // else; neither is worth carrying, and `exactOptionalPropertyTypes` means the key is spread in
  // rather than set to undefined.
  const start = token.ordered && typeof token.start === "number" && token.start !== 1 ? token.start : undefined;
  return {
    kind: "list",
    ordered: token.ordered,
    items: token.items.map((item) => toListItem(item, options)),
    ...(start === undefined ? {} : { start }),
  };
}

/**
 * A task list's checkbox arrives as its own block-level token ahead of the item's text. Rendered as
 * a block it would sit on a line of its own, so the marker is folded into the item's first
 * paragraph — and it is written as the `[x]` the model typed rather than a glyph invented here.
 */
function toListItem(item: Tokens.ListItem, options: MarkdownOptions): MdBlock[] {
  const blocks = toBlocks(item.tokens.filter((token) => token.type !== "checkbox"), options);
  if (!item.task) return blocks;

  const marker: MdInline = { kind: "text", text: item.checked ? "[x] " : "[ ] " };
  const [first, ...rest] = blocks;
  return first?.kind === "paragraph"
    ? [{ kind: "paragraph", inlines: [marker, ...first.inlines] }, ...rest]
    : [{ kind: "paragraph", inlines: [marker] }, ...blocks];
}

function toTable(token: Tokens.Table, options: MarkdownOptions): MdBlock {
  const cells = (row: Tokens.TableCell[]): MdInline[][] => row.map((cell) => toInlines(cell.tokens, options) ?? []);
  return {
    kind: "table",
    header: cells(token.header),
    rows: token.rows.map(cells),
    align: token.align.map((align) => align ?? undefined),
  };
}

function toInlines(tokens: Token[] | undefined, options: MarkdownOptions): MdInline[] | undefined {
  return tokens?.flatMap((token) => toInline(token, options));
}

function toInline(token: Token, options: MarkdownOptions): MdInline[] {
  switch (token.type) {
    // A `text` token carrying its own tokens is a nested run, not a leaf — the shape a list item's
    // text and an autolink's label both take.
    case "text":
      return toInlines(token.tokens, options) ?? [{ kind: "text", text: token.text }];
    case "escape":
      return [{ kind: "text", text: token.text }];
    case "strong":
    case "em":
    case "del":
      return [{ kind: token.type, inlines: toInlines(token.tokens, options) ?? [] }];
    case "codespan":
      return [{ kind: "code", text: token.text }];
    case "br":
      return [{ kind: "break" }];
    case "link":
      return [toLink(token as Tokens.Link, options)];
    case "image":
      return [toImage(token.href, token.text, token.raw, options)];
    // Raw HTML the model emitted, inline or as a block, is text. This is the whole reason the lexer
    // is used without the parser: there is no path here by which `<script>` becomes a script.
    case "html":
      return htmlImages(token.text, options);
    default:
      return verbatim(token);
  }
}

function toLink(token: Tokens.Link, options: MarkdownOptions): MdInline {
  const href = resolveHref(token.href, options.linkBase);
  return href === undefined
    ? { kind: "text", text: token.raw }
    : { kind: "link", href, inlines: toInlines(token.tokens, options) ?? [{ kind: "text", text: token.text }] };
}

function resolveHref(href: string, base?: string): string | undefined {
  if (!base) return safeHref(href);
  try { return safeHref(new URL(href, base).href); }
  catch { return undefined; }
}

function toImage(href: string, alt: string, raw: string, options: MarkdownOptions): MdInline {
  const src = options.images && href.trim() ? resolveHref(href, options.imageBase) : undefined;
  if (!src || !/^https?:\/\//i.test(src)) return { kind: "text", text: raw };
  const url = new URL(src);
  const blob = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(url.pathname);
  if (url.hostname === "github.com" && blob) {
    url.hostname = "raw.githubusercontent.com";
    url.pathname = `/${blob[1]}/${blob[2]}/${blob[3]}`;
  }
  return { kind: "image", src: url.href, alt };
}

function htmlImages(text: string, options: MarkdownOptions): MdInline[] {
  const tags = text.match(/<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*\/?>/gi);
  if (!options.images || !tags || tags.join("").replace(/\s/g, "") !== text.replace(/\s/g, "")) return [{ kind: "text", text }];
  return tags.map((tag) => {
    const attrs = new Map<string, string>();
    for (const match of tag.slice(4, -1).matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = match[1]!.toLowerCase();
      if (!attrs.has(name)) attrs.set(name, decodeAttribute(match[2] ?? match[3] ?? match[4] ?? ""));
    }
    return toImage(attrs.get("src") ?? "", attrs.get("alt") ?? "Screenshot", tag, options);
  });
}

function decodeAttribute(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (raw, entity: string) => {
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? raw;
    const number = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : raw;
  });
}

/** A construct this module does not model, shown as the source the model wrote. */
function verbatim(token: Token): MdInline[] {
  return [{ kind: "text", text: token.raw }];
}
