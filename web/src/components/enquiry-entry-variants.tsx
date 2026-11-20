import { Check, ChevronRight, MessageCircleQuestionMark } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Entry } from "@client/reduce.ts";
import { Highlighted } from "@/components/highlighted.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { cn } from "@/lib/utils.ts";

type Enquiry = Extract<Entry, { kind: "enquiry" }>;
type Props = { entry: Enquiry; query: string };

function answerOf(entry: Enquiry, index: number): string | undefined {
  const chosen = entry.answers?.[index] ?? [];
  if (chosen.length > 0) return chosen.join(", ");
  return undefined;
}

function pending(entry: Enquiry): string {
  return entry.status === "asked" ? "waiting…" : "no answer";
}

export function EnquiryToolRow({ entry, query }: Props) {
  return (
    <ToolRowShell entry={entry} query={query}>
      <span className="min-w-0 truncate text-sm">
        {entry.questions.map((_, index) => (
          <span key={index}>
            {index > 0 ? <span className="text-muted-foreground"> · </span> : null}
            <Pair entry={entry} index={index} />
          </span>
        ))}
      </span>
    </ToolRowShell>
  );
}

export type Detail = "card" | "notes" | "rule" | "chips";

export function EnquiryToolRowLines({ entry, query, detail = "card" }: Props & { detail?: Detail }) {
  return (
    <ToolRowShell entry={entry} query={query} detail={detail}>
      <span className="flex min-w-0 flex-col text-sm">
        {entry.questions.map((_, index) => (
          <span key={index} className="truncate">
            <Pair entry={entry} index={index} />
          </span>
        ))}
      </span>
    </ToolRowShell>
  );
}

export function EnquiryToolRowCount({ entry, query }: Props) {
  const row = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(entry.questions.length);
  useLayoutEffect(() => {
    const element = row.current!;
    const fit = () => {
      const widths = [...element.querySelectorAll<HTMLElement>("[data-measure]")].map((pair) => pair.offsetWidth);
      const space = element.clientWidth;
      const total = widths.reduce((sum, width) => sum + width, 0);
      if (total <= space) return setShown(widths.length);
      let used = 0;
      let count = 0;
      while (count < widths.length && used + widths[count]! <= space - 80) used += widths[count++]!;
      setShown(Math.max(1, count));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [entry]);
  const hidden = entry.questions.length - shown;
  return (
    <ToolRowShell entry={entry} query={query}>
      <span ref={row} className="relative flex min-w-0 flex-1 overflow-hidden text-sm whitespace-nowrap">
        <span aria-hidden className="invisible absolute flex">
          {entry.questions.map((_, index) => (
            <span key={index} data-measure>
              {index > 0 ? " · " : null}
              <Pair entry={entry} index={index} />
            </span>
          ))}
        </span>
        <span className="min-w-0 truncate">
          {entry.questions.slice(0, shown).map((_, index) => (
            <span key={index}>
              {index > 0 ? <span className="text-muted-foreground"> · </span> : null}
              <Pair entry={entry} index={index} />
            </span>
          ))}
        </span>
        {hidden > 0 ? <span className="ml-2 shrink-0 text-muted-foreground">+{hidden} more</span> : null}
      </span>
    </ToolRowShell>
  );
}

export function EnquiryPerQuestion({ entry, query, detail }: Props & { detail: Detail }) {
  return (
    <div className="flex items-start gap-2 px-1.5 py-1 text-foreground">
      <MessageCircleQuestionMark aria-hidden className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        {entry.questions.map((question, index) => (
          <details key={question.question} className="group/question">
            <summary className="-mx-1.5 flex cursor-default items-center gap-2 rounded-md px-1.5 text-sm select-none hover:bg-muted/50">
              <span className="min-w-0 truncate">
                <Pair entry={entry} index={index} />
              </span>
              <ChevronRight aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-open/question:rotate-90" />
            </summary>
            <div className={cn("mt-0.5 mb-1.5", detail === "rule" && "border-l pl-3")}>
              <LightDetail entry={entry} index={index} query={query} detail={detail} labelled={false} />
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}

function ToolRowShell({ entry, query, children, detail = "card" }: Props & { children: ReactNode; detail?: Detail }) {
  return (
    <details className="group/tool text-foreground">
      <summary className="flex cursor-default items-start gap-2 rounded-md px-1.5 py-1 select-none hover:bg-muted/50">
        <MessageCircleQuestionMark aria-hidden className="mt-[3px] size-3.5 shrink-0 text-muted-foreground" />
        {children}
        <ChevronRight aria-hidden className="mt-[3px] ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
      </summary>
      {detail === "card" ? (
        <div className="my-1 ml-6 space-y-3 rounded-lg border p-3">
          {entry.questions.map((question, index) => (
            <OptionList key={question.question} entry={entry} index={index} query={query} />
          ))}
        </div>
      ) : (
        <div className={cn("mb-1 space-y-2.5 py-1", detail === "rule" ? "ml-[13px] border-l pl-[14px]" : "pl-7")}>
          {entry.questions.map((question, index) => (
            <LightDetail key={question.question} entry={entry} index={index} query={query} detail={detail} />
          ))}
        </div>
      )}
    </details>
  );
}

function Pair({ entry, index }: { entry: Enquiry; index: number }) {
  return (
    <>
      <span className="text-muted-foreground">{entry.questions[index]!.header} </span>
      {entry.status === "answered" ? answerOf(entry, index) ?? "—" : <span className="text-muted-foreground italic">{pending(entry)}</span>}
    </>
  );
}

export function EnquiryExchange({ entry, query }: Props) {
  return (
    <div className="space-y-2 py-1">
      {entry.questions.map((question, index) => {
        const answer = answerOf(entry, index);
        return (
          <div key={question.question} className="space-y-1.5">
            <div className="flex gap-2 text-sm text-muted-foreground">
              <MessageCircleQuestionMark aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <Highlighted text={question.question} query={query} />
            </div>
            <div className="flex justify-end">
              <span className={cn("rounded-2xl rounded-br-sm bg-muted px-3 py-1.5 text-sm", answer === undefined && "text-muted-foreground italic")}>
                {answer === undefined ? pending(entry) : <Highlighted text={answer} query={query} />}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function EnquiryDecisionList({ entry, query }: Props) {
  return (
    <dl className="my-1 ml-1.5 space-y-2 border-l-2 py-0.5 pl-3">
      {entry.questions.map((question, index) => {
        const answer = answerOf(entry, index);
        return (
          <div key={question.question} className="min-w-0">
            <div className="flex items-baseline gap-2">
              <dt className="shrink-0 text-xs text-muted-foreground">{question.header}</dt>
              <dd className={cn("min-w-0 text-sm font-medium", answer === undefined && "font-normal text-muted-foreground italic")}>
                {answer === undefined ? pending(entry) : <Highlighted text={answer} query={query} />}
              </dd>
            </div>
            <p className="line-clamp-1 text-xs text-muted-foreground/80" title={question.question}>
              <Highlighted text={question.question} query={query} />
            </p>
          </div>
        );
      })}
    </dl>
  );
}

export function EnquiryOptions({ entry, query }: Props) {
  return (
    <div className="space-y-3 rounded-lg border px-3 py-2.5">
      {entry.questions.map((question, index) => (
        <OptionList key={question.question} entry={entry} index={index} query={query} />
      ))}
      {entry.status === "answered" ? null : <p className="text-xs text-muted-foreground italic">{pending(entry)}</p>}
    </div>
  );
}

function OptionList({ entry, index, query }: Props & { index: number }) {
  const question = entry.questions[index]!;
  const chosen = entry.answers?.[index] ?? [];
  const typed = chosen.filter((answer) => !question.options.some((option) => option.label === answer));
  return (
    <div className="space-y-1.5">
      <p className="text-sm [overflow-wrap:anywhere]">
        <span className="mr-2 text-xs text-muted-foreground">{question.header}</span>
        <Highlighted text={question.question} query={query} />
      </p>
      <ul className="space-y-0.5">
        {question.options.map((option) => {
          const picked = chosen.includes(option.label);
          return (
            <li key={option.label} className={cn("flex items-start gap-2 text-sm", !picked && "text-muted-foreground")}>
              <Check aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", !picked && "invisible")} />
              <span className={cn(picked && "font-medium")}>
                <Highlighted text={option.label} query={query} />
              </span>
            </li>
          );
        })}
        {typed.map((answer) => (
          <li key={answer} className="flex items-start gap-2 text-sm">
            <Check aria-hidden className="mt-0.5 size-3.5 shrink-0" />
            <span className="font-medium">“<Highlighted text={answer} query={query} />”</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function LightDetail({ entry, index, query, detail, labelled = true }: Props & { index: number; detail: Detail; labelled?: boolean }) {
  const question = entry.questions[index]!;
  const chosen = entry.answers?.[index] ?? [];
  const others = question.options.filter((option) => !chosen.includes(option.label));
  const typed = chosen.filter((answer) => !question.options.some((option) => option.label === answer));
  return (
    <div className="space-y-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
      <p>
        {labelled && entry.questions.length > 1 ? <span className="mr-1.5 text-foreground/70">{question.header}</span> : null}
        <Highlighted text={question.question} query={query} />
      </p>
      {detail === "notes" ? (
        others.length === 0 ? null : <p className="text-muted-foreground/70">Other options: {others.map((option) => option.label).join(" · ")}</p>
      ) : detail === "rule" ? (
        <ul>
          {question.options.map((option) => {
            const picked = chosen.includes(option.label);
            return (
              <li key={option.label} className={cn("flex items-center gap-1.5", picked ? "text-foreground" : "text-muted-foreground/70")}>
                <Check aria-hidden className={cn("size-3 shrink-0", !picked && "invisible")} />
                {option.label}
              </li>
            );
          })}
          {typed.map((answer) => (
            <li key={answer} className="flex items-center gap-1.5 text-foreground">
              <Check aria-hidden className="size-3 shrink-0" />“{answer}”
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex flex-wrap gap-1">
          {question.options.map((option) => (
            <Badge key={option.label} variant={chosen.includes(option.label) ? "secondary" : "outline"} className={cn("font-normal", !chosen.includes(option.label) && "text-muted-foreground")}>
              {option.label}
            </Badge>
          ))}
          {typed.map((answer) => (
            <Badge key={answer} variant="secondary" className="font-normal">“{answer}”</Badge>
          ))}
        </div>
      )}
    </div>
  );
}
