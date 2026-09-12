import { useState, type ReactNode } from "react";

import type { MdAlign, MdBlock, MdInline } from "@client/markdown.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { cn } from "@/lib/utils.ts";

/**
 * A lexed markdown tree, as elements.
 *
 * The tree arrives from `src/client/markdown.ts` and every leaf goes through `<Highlighted>`, which
 * is the whole reason the lexer is used without its parser: an HTML string has no leaf text nodes to
 * put a `<mark>` inside. Nothing here is `dangerouslySetInnerHTML`, and raw HTML the model emitted
 * arrived as a text leaf, so it renders as the characters it is.
 *
 * **Prose is the chrome font.** Monospace is spent only where alignment is the point — a code span,
 * a fenced block — which is the rule `web/src/fonts.ts` already states and this is the first place to
 * honour it. Everything a model writes around its code is prose, and setting prose in a terminal font
 * is what made a long answer read as a wall.
 *
 * `trailing` is the streaming caret. It is threaded to the *last* leaf block rather than rendered
 * after the tree, so it sits after the final character the model has sent instead of orphaned on a
 * line below it.
 */
export function Markdown({ blocks, query, trailing }: { blocks: MdBlock[]; query: string; trailing?: ReactNode }) {
  // No colour of its own: a caller sets the tone — thinking is muted and italic — and prose inherits it.
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      <Blocks blocks={blocks} query={query} trailing={trailing} />
    </div>
  );
}

function Blocks({ blocks, query, trailing }: { blocks: MdBlock[]; query: string; trailing: ReactNode }) {
  return (
    <>
      {blocks.map((block, index) => (
        <Block
          key={index}
          block={block}
          query={query}
          trailing={index === blocks.length - 1 ? trailing : undefined}
        />
      ))}
    </>
  );
}

const HEADING_SIZE: Record<number, string> = { 1: "text-lg", 2: "text-base" };

function Block({ block, query, trailing }: { block: MdBlock; query: string; trailing: ReactNode }) {
  switch (block.kind) {
    case "paragraph":
      return (
        <p className="m-0 [overflow-wrap:anywhere]">
          <Inlines inlines={block.inlines} query={query} />
          {trailing}
        </p>
      );

    case "heading": {
      // Tailwind cannot see a class it did not read as a literal, so the tag is chosen by element
      // name and the size by lookup rather than by building either string.
      const Tag = `h${block.level}` as const;
      return (
        <Tag
          className={cn(
            HEADING_SIZE[block.level] ?? "text-sm",
            "m-0 pt-1 font-heading font-semibold tracking-tight [overflow-wrap:anywhere]",
          )}
        >
          <Inlines inlines={block.inlines} query={query} />
          {trailing}
        </Tag>
      );
    }

    case "code":
      return (
        <div className="overflow-hidden rounded-lg border bg-muted">
          {block.lang === undefined ? null : (
            <div className="border-b px-3 py-1 font-mono text-xs text-muted-foreground">{block.lang}</div>
          )}
          {/* Scrolls rather than wraps: breaking a line mid-identifier is worse than a scrollbar. */}
          <pre className="overflow-x-auto p-3">
            <code className="font-mono text-sm">
              <Highlighted text={block.text} query={query} />
              {trailing}
            </code>
          </pre>
        </div>
      );

    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return (
        <Tag
          className={cn(
            "m-0 space-y-1 pl-5 marker:text-muted-foreground",
            block.ordered ? "list-decimal" : "list-disc",
          )}
          {...(block.start === undefined ? {} : { start: block.start })}
        >
          {block.items.map((item, index) => (
            <li key={index} className="space-y-2 [overflow-wrap:anywhere]">
              <Blocks
                blocks={item}
                query={query}
                trailing={index === block.items.length - 1 ? trailing : undefined}
              />
            </li>
          ))}
        </Tag>
      );
    }

    case "quote":
      return (
        <blockquote className="space-y-2 border-l-2 border-border pl-3 text-muted-foreground">
          <Blocks blocks={block.blocks} query={query} trailing={trailing} />
        </blockquote>
      );

    case "table":
      return <Table block={block} query={query} trailing={trailing} />;

    case "rule":
      return (
        <>
          <hr className="border-border" />
          {trailing}
        </>
      );
  }
}

const ALIGN: Record<string, string> = { left: "text-left", center: "text-center", right: "text-right" };

const align = (value: MdAlign): string => (value === undefined ? "text-left" : (ALIGN[value] ?? "text-left"));

function Table({
  block,
  query,
  trailing,
}: {
  block: Extract<MdBlock, { kind: "table" }>;
  query: string;
  trailing: ReactNode;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-sm tabular-nums">
        <thead>
          <tr>
            {block.header.map((cell, index) => (
              <th key={index} className={cn("border-b px-2 py-1 font-semibold", align(block.align[index]))}>
                <Inlines inlines={cell} query={query} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} className={cn("border-b border-border/50 px-2 py-1", align(block.align[index]))}>
                  <Inlines inlines={cell} query={query} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {trailing}
    </div>
  );
}

function Inlines({ inlines, query }: { inlines: MdInline[]; query: string }) {
  return (
    <>
      {inlines.map((inline, index) => (
        <Inline key={index} inline={inline} query={query} />
      ))}
    </>
  );
}

function Inline({ inline, query }: { inline: MdInline; query: string }) {
  switch (inline.kind) {
    case "text":
      return <Highlighted text={inline.text} query={query} />;
    case "strong":
      return (
        <strong className="font-semibold">
          <Inlines inlines={inline.inlines} query={query} />
        </strong>
      );
    case "em":
      return (
        <em>
          <Inlines inlines={inline.inlines} query={query} />
        </em>
      );
    case "del":
      return (
        <del className="text-muted-foreground">
          <Inlines inlines={inline.inlines} query={query} />
        </del>
      );
    case "code":
      return (
        <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] [overflow-wrap:anywhere]">
          <Highlighted text={inline.text} query={query} />
        </code>
      );
    case "link":
      // noreferrer as well as noopener: a Presentation Transcript should not tell a third party
      // which Agent Session someone was reading when they clicked.
      return (
        <a
          href={inline.href}
          target="_blank"
          rel="noreferrer noopener"
          className="underline decoration-muted-foreground underline-offset-2 hover:decoration-foreground"
        >
          <Inlines inlines={inline.inlines} query={query} />
        </a>
      );
    case "image":
      return <MarkdownImage key={inline.src} src={inline.src} alt={inline.alt} />;
    case "break":
      return <br />;
  }
}

function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="text-muted-foreground">Image unavailable{alt ? `: ${alt}` : ""}. Open the pull request on GitHub to view it.</span>
    : <img src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} className="my-2 max-h-[36rem] max-w-full rounded border object-contain" />;
}
