import { highlightSegments } from "@client/search.ts";

/**
 * Search hits as `<mark>`, built from segments rather than from a string of HTML.
 *
 * `highlightSegments` returns data and this turns it into elements, which is the whole reason the
 * matching logic can live in `src/client/` and be shared: it never touches the DOM, and there is no
 * `dangerouslySetInnerHTML` anywhere near a Presentation Transcript.
 *
 * The query arrives already lowercased from the field that owns it, so a keystroke lowercases once
 * rather than once per Entry.
 */
export function Highlighted({ text, query }: { text: string; query: string }) {
  if (query === "") return <>{text}</>;
  return (
    <>
      {highlightSegments(text, query).map((segment, index) =>
        segment.match ? (
          <mark key={index} className="rounded-sm bg-(--color-mark-bg) text-(--color-mark-fg)">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}
