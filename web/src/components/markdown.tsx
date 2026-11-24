import { useState, type ReactNode } from "react";

import type { MdAlign, MdBlock, MdInline } from "@client/markdown.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { DiffText } from "@/components/diff-text.tsx";
import { ExpandableImage } from "@/components/expandable-image.tsx";
import { cn } from "@/lib/utils.ts";
import { githubLinkLabel } from "@/presentation/github-link.ts";

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
              <DiffText text={block.text} lang={block.lang} query={query} trailing={trailing} />
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
    case "link": {
      const github = githubLinkLabel(inline.href);
      if (github !== undefined) return <GitHubPill inline={inline} label={github} query={query} />;
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
    }
    case "image":
      return <MarkdownImage key={inline.src} src={inline.src} alt={inline.alt} />;
    case "break":
      return <br />;
  }
}

function GitHubPill({ inline, label, query }: { inline: Extract<MdInline, { kind: "link" }>; label: string; query: string }) {
  const [only, ...rest] = inline.inlines;
  const bare = rest.length === 0 && only?.kind === "text" && only.text === inline.href;
  return (
    <a
      href={inline.href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-baseline gap-1 rounded-md bg-foreground/8 px-1 py-px align-baseline font-medium hover:bg-foreground/12 [overflow-wrap:anywhere]"
    >
      <GitHubMark className="size-3 shrink-0 self-center" />
      <span>{bare ? <Highlighted text={label} query={query} /> : <Inlines inlines={inline.inlines} query={query} />}</span>
    </a>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 24 24" fill="currentColor" className={className}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  );
}

function MarkdownImage({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);
  return failed
    ? <span className="text-muted-foreground">Image unavailable{alt ? `: ${alt}` : ""}. Open the pull request on GitHub to view it.</span>
    : <ExpandableImage src={src} alt={alt} referrerPolicy="no-referrer" onError={() => setFailed(true)} className="my-2 max-h-[36rem] max-w-full rounded border object-contain" />;
}
