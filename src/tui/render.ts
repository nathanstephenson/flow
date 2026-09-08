import type { SessionSummary } from "../protocol/commands.ts";
import { contextUsageLabel } from "../client/context-usage.ts";
import { effortChoices, modelChoices, type ModelChoice } from "../client/model-choices.ts";
import type { Entry, ViewState } from "../client/reduce.ts";
import { relativeTime } from "../client/relative-time.ts";
import { scopeKindLabel } from "../client/scope-kind.ts";
import { sessionLabel } from "../client/session-label.ts";

/**
 * Frame rendering, kept pure so it can be tested without a terminal.
 *
 * The TUI holds no session state of its own: everything on screen is derived from the reduced
 * Presentation Transcript plus which overlay is open.
 */

export type Overlay =
  | { kind: "none" }
  | { kind: "sessions"; index: number }
  | { kind: "models"; index: number }
  | { kind: "effort"; index: number }
  /**
   * The branches of the selected Agent Session's Scope.
   *
   * ADR 0010 declined a fourth Overlay kind for Projects, on the grounds that the TUI is "already
   * running in the directory you want". That argument does not reach a branch: being in the right
   * directory does not put you on the right branch, and `--scope` cannot express one. So this is
   * the case that kind of overlay was refused *for*, not a reversal of the decision.
   *
   * `purpose` is what makes one list serve two jobs. Switching moves the Scope this Agent Session
   * is already bound to; cutting starts a new Agent Session in a worktree taken from the picked
   * branch. The rows are identical, so two overlays would be two copies of one list.
   */
  | { kind: "branches"; index: number; purpose: "switch" | "cut"; branches: string[]; head?: string };

export type UiState = {
  sessions: SessionSummary[];
  selected: string | undefined;
  view: ViewState;
  input: string;
  overlay: Overlay;
  notice?: string;
  /** Passed in rather than read from the clock, so a frame renders identically twice. */
  now?: number;
};

export type Size = { columns: number; rows: number };

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
  const effort = ui.view.effort && effortChoices(ui.view).length > 0 ? ` · ${ui.view.effort}` : "";
  /*
   * Where the next turn will land, beside what will run it.
   *
   * The web client draws this as a strip along the bottom of its composer, with the checkout named
   * every time. Here it is one line shared with the model and the status, so only the notable case
   * is spent width on: `scopeKindLabel` supplies the word either way, so the two clients cannot
   * drift on *what* a Worktree is called — only on whether there is room to say it.
   *
   * Absent when the Scope is not a repository, the same signal the web client hides its control on.
   */
  const kind = ui.view.worktree ? ` · ${scopeKindLabel(ui.view)}` : "";
  const branch = ui.view.branch ? ` · ${ui.view.branch.name}${kind}` : "";
  const left = summary ? `${summary.backend} · ${sessionLabel(summary)}${branch}` : "no session";
  const right = `${model}${effort} · ${ui.view.status}`;
  return clip(pad(left, Math.max(0, width - right.length - 1)) + " " + right, width);
}

function status(ui: UiState, width: number): string {
  const parts: string[] = [];
  if (ui.view.queue.length > 0) parts.push(`${ui.view.queue.length} queued`);
  // Ahead of the reading it is about to change, and in place of it: a percentage that has not moved
  // yet is the thing someone asking for a compaction is staring at.
  if (ui.view.compacting) parts.push("compacting…");
  else {
    const context = contextUsageLabel(ui.view.contextUsage);
    if (context) parts.push(context);
  }
  if (ui.notice) parts.push(ui.notice);
  // `^K` is listed only where it can be served, on the same rule the web client hides the menu item:
  // an affordance a backend cannot honour is worse than no affordance at all.
  const compact = ui.view.capabilities?.compaction ? "  ^K compact" : "";
  parts.push(`^S sessions  ^P models  ^E effort  ^G branches${compact}  esc abort  ^C quit`);
  return clip(parts.join("  ·  "), width);
}

function transcript(view: ViewState, width: number, height: number): string[] {
  const lines = view.entries.flatMap((entry) => entryLines(entry, width));
  return padTo(lines.slice(-height), height, width);
}

function entryLines(entry: Entry, width: number): string[] {
  switch (entry.kind) {
    case "user": {
      const lines = wrap(`> ${entry.text}`, width);
      // A terminal cannot show the image and cannot paste one either, so it says one is there and
      // stops. Naming the count rather than each id, because an id is a filename this reader has no
      // use for — what they need to know is that the model saw something they cannot.
      const count = entry.attachments?.length ?? 0;
      return count === 0 ? lines : [...lines, clip(`  [${count} image${count === 1 ? "" : "s"}]`, width)];
    }
    case "assistant":
      return wrap(entry.text, width);
    case "thinking":
      return wrap(`· ${entry.text}`, width);
    case "tool":
      return [clip(`  [${entry.status}] ${entry.name}`, width)];
    case "subagent":
      // Indented past a tool call: a Subagent is what one of those is doing, not another of them.
      return [clip(`    ⤷ [${entry.waitingOn ?? entry.status}] ${entry.name}`, width)];
    case "notice":
      return wrap(`! ${entry.text}`, width);
    case "marker":
      return [rule(entry.text, width)];
  }
}

/**
 * A structural marker is a break in the Presentation Transcript rather than another line of text, so
 * it gets a labelled rule — the same `──` vocabulary the Settled divider in the session list uses.
 */
function rule(label: string, width: number): string {
  const dashes = Math.max(0, width - label.length - 4);
  return clip(`── ${label} ${"─".repeat(dashes)}`, width);
}

function overlay(ui: UiState, width: number, height: number): string[] {
  if (ui.overlay.kind === "sessions") {
    const cursor = (ui.overlay as { index: number }).index;
    const now = ui.now ?? Date.now();
    const rows: string[] = [];
    let openedSettled = false;

    // list() sorts Settled last, so one divider separates the two groups. It is a label rather than
    // a row: the cursor indexes into ui.sessions, and a selectable heading would shift every index.
    for (const [index, session] of ui.sessions.entries()) {
      if (session.status === "settled" && !openedSettled) {
        openedSettled = true;
        rows.push(clip("  ── settled ──", width));
      }
      const updated = relativeTime(session.updatedAt, now);
      rows.push(
        clip(
          `${index === cursor ? ">" : " "} ${session.status.padEnd(8)} ${session.backend.padEnd(7)} ${updated.padEnd(10)} ${sessionLabel(session)}`,
          width,
        ),
      );
    }

    return padTo(
      ["sessions  (enter to switch, n for new, w for new in a worktree, s to settle, esc to close)", ...rows],
      height,
      width,
    );
  }

  if (ui.overlay.kind === "branches") {
    const { index, purpose, branches, head } = ui.overlay;
    // Keep the cursor in view, the same way the model list does: a long-lived checkout accumulates
    // branches the way the pi backend accumulates models.
    const room = Math.max(1, height - 1);
    const start = Math.max(0, Math.min(index - Math.floor(room / 2), branches.length - room));
    const rows: string[] = [];
    for (let cursor = start; cursor < Math.min(branches.length, start + room); cursor += 1) {
      const name = branches[cursor];
      if (name === undefined) break;
      const inForce = name === head ? "  (in force)" : "";
      rows.push(clip(`${cursor === index ? ">" : " "} ${name}${inForce}`, width));
    }
    const title =
      branches.length === 0
        ? "no branches here"
        : purpose === "switch"
          ? "branches  (enter to switch, esc to close)"
          : "cut a worktree from  (enter to start an Agent Session, esc to close)";
    return padTo([title, ...rows], height, width);
  }

  if (ui.overlay.kind === "effort") {
    const levels = effortChoices(ui.view);
    const cursor = (ui.overlay as { index: number }).index;
    const rows = levels.map((level, index) => {
      const inForce = level === ui.view.effort ? "  (in force)" : "";
      return clip(`${index === cursor ? ">" : " "} ${level}${inForce}`, width);
    });
    const title =
      levels.length > 0 ? "effort  (enter to set, esc to close)" : "this model has no effort control";
    return padTo([title, ...rows], height, width);
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
