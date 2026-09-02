import { useEffect, useRef, useState, type RefObject } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input.tsx";

/** The input is debounced, not the filter: a filter that lags the text it is filtering by feels broken. */
const DEBOUNCE_MS = 120;

/**
 * Find text in this pane's Presentation Transcript.
 *
 * It lowercases before publishing so a keystroke lowercases once rather than once per Entry, which is
 * the convention `src/client/search.ts` asks for. It is *not* a replacement for find-in-page: Cmd-F
 * still works over the whole transcript, which is exactly why nothing here is virtualised.
 */
export function TranscriptSearchField({
  query,
  onQueryChange,
  inputRef,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  inputRef?: RefObject<HTMLInputElement | null> | undefined;
}) {
  const [text, setText] = useState(query);
  const published = useRef(query);

  useEffect(() => {
    const lowered = text.trim().toLowerCase();
    if (lowered === published.current) return;
    const timer = setTimeout(() => {
      published.current = lowered;
      onQueryChange(lowered);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text, onQueryChange]);

  return (
    <div className="flex items-center gap-2 border-b bg-card px-3 py-1">
      <Search className="size-4 shrink-0 opacity-50" aria-hidden />
      <Input
        ref={inputRef}
        data-transcript-search=""
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setText("");
            event.currentTarget.blur();
          }
        }}
        placeholder="Find in this Presentation Transcript"
        aria-label="Find in this Presentation Transcript"
        className="h-8 border-0 bg-transparent px-0 shadow-none dark:bg-transparent focus-visible:border-0 focus-visible:ring-0"
      />
      {text === "" ? null : (
        <button
          type="button"
          onClick={() => setText("")}
          aria-label="Clear"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}
