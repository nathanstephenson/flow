import type { SessionSummary } from "../protocol/commands.ts";
import type { Capabilities, ModelInfo } from "../protocol/events.ts";
import type { Entry, ViewState } from "../client/reduce.ts";

/**
 * Frame rendering, kept pure so it can be tested without a terminal.
 *
 * The TUI holds no session state of its own: everything on screen is derived from the reduced
 * Presentation Transcript plus which overlay is open.
 */

export type Overlay =
  | { kind: "none" }
  | { kind: "sessions"; index: number }
  | { kind: "models"; index: number };

export type UiState = {
  sessions: SessionSummary[];
  selected: string | undefined;
  view: ViewState;
  input: string;
  overlay: Overlay;
  notice?: string;
};

export type Size = { columns: number; rows: number };

export type ModelChoice = { provider: string; model: ModelInfo };

/** Models grouped by provider. Claude offers one group, pi offers dozens; the list is the same. */
export function modelChoices(capabilities: Capabilities | undefined): ModelChoice[] {
  if (!capabilities) return [];
  const byProvider = new Map<string, ModelInfo[]>();
  for (const model of capabilities.models) {
    const provider = model.provider ?? "other";
    byProvider.set(provider, [...(byProvider.get(provider) ?? []), model]);
  }
  return [...byProvider.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([provider, models]) => models.map((model) => ({ provider, model })));
}

export function renderFrame(ui: UiState, size: Size): string[] {
  const width = Math.max(20, size.columns);
  const height = Math.max(6, size.rows);
  const body = height - 3;

  const lines = [header(ui, width)];
  lines.push(...(ui.overlay.kind === "none" ? transcript(ui.view, width, body) : overlay(ui, width, body)));
  lines.push(status(ui, width));
  lines.push(clip(`> ${ui.input}`, width));
  return lines;
}

function header(ui: UiState, width: number): string {
  const summary = ui.sessions.find((session) => session.id === ui.selected);
  const model = ui.view.model?.label ?? ui.view.model?.id ?? "default model";
  const left = summary ? `${summary.backend} · ${summary.title}` : "no session";
  const right = `${model} · ${ui.view.status}`;
  return clip(pad(left, Math.max(0, width - right.length - 1)) + " " + right, width);
}

function status(ui: UiState, width: number): string {
  const parts: string[] = [];
  if (ui.view.queue.length > 0) parts.push(`${ui.view.queue.length} queued`);
  if (ui.view.contextUsage) {
    const { used, window } = ui.view.contextUsage;
    parts.push(window > 0 ? `context ${Math.round((used / window) * 100)}%` : `${used} tokens`);
  }
  if (ui.notice) parts.push(ui.notice);
  parts.push("^S sessions  ^P models  esc abort  ^C quit");
  return clip(parts.join("  ·  "), width);
}

function transcript(view: ViewState, width: number, height: number): string[] {
  const lines = view.entries.flatMap((entry) => entryLines(entry, width));
  return padTo(lines.slice(-height), height, width);
}

function entryLines(entry: Entry, width: number): string[] {
  switch (entry.kind) {
    case "user":
      return wrap(`> ${entry.text}`, width);
    case "assistant":
      return wrap(entry.text, width);
    case "thinking":
      return wrap(`· ${entry.text}`, width);
    case "tool":
      return [clip(`  [${entry.status}] ${entry.name}`, width)];
    case "notice":
      return wrap(`! ${entry.text}`, width);
  }
}

function overlay(ui: UiState, width: number, height: number): string[] {
  if (ui.overlay.kind === "sessions") {
    const rows = ui.sessions.map((session, index) =>
      clip(
        `${index === (ui.overlay as { index: number }).index ? ">" : " "} ${session.status.padEnd(8)} ${session.backend.padEnd(7)} ${session.title}`,
        width,
      ),
    );
    return padTo(["sessions  (enter to switch, n for new, esc to close)", ...rows], height, width);
  }

  const choices = modelChoices(ui.view.capabilities);
  const index = ui.overlay.kind === "models" ? ui.overlay.index : 0;
  // Keep the cursor in view: the pi backend can offer hundreds of models.
  const start = Math.max(0, Math.min(index - Math.floor((height - 2) / 2), choices.length - (height - 2)));
  const rows: string[] = [];
  let lastProvider: string | undefined;
  for (let cursor = start; cursor < Math.min(choices.length, start + height - 2); cursor += 1) {
    const choice = choices[cursor];
    if (!choice) break;
    if (choice.provider !== lastProvider) {
      rows.push(clip(`  ${choice.provider}`, width));
      lastProvider = choice.provider;
    }
    rows.push(clip(`${cursor === index ? ">" : " "}   ${choice.model.label ?? choice.model.id}`, width));
  }
  return padTo([`models  (${choices.length} across ${providerCount(choices)} providers)`, ...rows], height, width);
}

function providerCount(choices: ModelChoice[]): number {
  return new Set(choices.map((choice) => choice.provider)).size;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length <= width) {
      out.push(paragraph);
      continue;
    }
    let rest = paragraph;
    while (rest.length > width) {
      const cut = rest.lastIndexOf(" ", width);
      const at = cut > width / 2 ? cut : width;
      out.push(rest.slice(0, at));
      rest = rest.slice(at).trimStart();
    }
    if (rest) out.push(rest);
  }
  return out;
}

function padTo(lines: string[], height: number, width: number): string[] {
  const clipped = lines.slice(0, height).map((line) => clip(line, width));
  while (clipped.length < height) clipped.push("");
  return clipped;
}

function clip(text: string, width: number): string {
  return text.length > width ? text.slice(0, width) : text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}
