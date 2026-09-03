import { useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";

import { Input } from "@/components/ui/input.tsx";

/** The input is debounced, not the filter: a filter that lags the text it is filtering by feels broken. */
const DEBOUNCE_MS = 120;

/**
 * Find text in this pane's Presentation Transcript.
 *
 * It lowercases before publishing so a keystroke lowercases once rather than once per Entry, which is
 * the convention `src/client/search.ts` asks for.
 *
 * It is mounted only while the reader has asked for it — ⌘F, the key they would otherwise have
 * pressed for find-in-page — so it takes focus on mount rather than waiting to be focused. Nothing
 * else mounts it, which is what makes that safe. Escape and the cross both mean the same thing:
 * close, and the pane clears the query as it goes, because a filter left applied under a field that
 * is no longer on screen is a transcript with Entries missing for no visible reason.
 */
export function TranscriptSearchField({
  query,
  onQueryChange,
  onClose,
}: {
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(query);
  const published = useRef(query);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.select();
  }, []);

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
        ref={input}
        data-transcript-search=""
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
        }}
        placeholder="Find in this Presentation Transcript"
        aria-label="Find in this Presentation Transcript"
        className="h-8 border-0 bg-transparent px-0 shadow-none dark:bg-transparent focus-visible:border-0 focus-visible:ring-0"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close search"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <X className="size-4" aria-hidden />
      </button>
    </div>
  );
}
