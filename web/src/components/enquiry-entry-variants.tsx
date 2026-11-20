import { Check, ChevronRight, MessageCircleQuestionMark } from "lucide-react";
import type { Entry } from "@client/reduce.ts";
import { Highlighted } from "@/components/highlighted.tsx";
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
  const single = entry.questions.length === 1;
  return (
    <details className="group/tool text-foreground">
      <summary className="flex cursor-default items-center gap-2 rounded-md px-1.5 py-1 select-none hover:bg-muted/50">
        <MessageCircleQuestionMark aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="shrink-0 text-sm text-muted-foreground">{single ? entry.questions[0]!.header : `${entry.questions.length} questions`}</span>
        <span className={cn("min-w-0 truncate text-sm", entry.status !== "answered" && "text-muted-foreground italic")}>
          {entry.status === "answered" ? entry.questions.map((_, index) => answerOf(entry, index) ?? "—").join(" · ") : pending(entry)}
        </span>
        <ChevronRight aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground transition-transform group-open/tool:rotate-90" />
      </summary>
      <div className="my-1 ml-6 space-y-3 rounded-lg border p-3">
        {entry.questions.map((question, index) => (
          <OptionList key={question.question} entry={entry} index={index} query={query} />
        ))}
      </div>
    </details>
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
