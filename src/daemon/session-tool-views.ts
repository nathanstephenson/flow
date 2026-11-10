import type { SessionSummary } from '../protocol/commands.ts';
import type { PresentationPage } from '../protocol/presentation.ts';

/** Keep discovery small: model catalogues and streamed output do not belong in every row. */
export function sessionToolSummary({ capabilities: _capabilities, ...summary }: SessionSummary) {
  return { ...summary, title: summary.title.slice(0, 1000),
    ...(summary.outputPreview === undefined ? {} : { outputPreview: summary.outputPreview.slice(0, 2000) }) };
}

/** Bound bytes as well as entry count. A single tool result can otherwise fill a Conversation Context. */
export function sessionToolPage(page: PresentationPage) {
  let bytes = 0;
  const entries: Array<PresentationPage['entries'][number] | { index: number; truncated: true; preview: string }> = [];
  for (const item of [...page.entries].reverse()) {
    const json = JSON.stringify(item);
    const bounded = Buffer.byteLength(json) > 8000
      ? { index: item.index, truncated: true as const, preview: json.slice(0, 1800) }
      : item;
    const size = Buffer.byteLength(JSON.stringify(bounded));
    if (bytes + size > 48_000) break;
    bytes += size;
    entries.unshift(bounded);
  }
  return { ...page, entries, start: entries[0]?.index ?? page.start };
}
