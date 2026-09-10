import type { SessionSummary } from "../protocol/commands.ts";
import { contextUsageLabel } from "../client/context-usage.ts";
import { effortChoices, modelChoices, type ModelChoice } from "../client/model-choices.ts";
import {
  answerLines,
  progressLabel,
  rowsFor,
  type Answering,
} from "../client/enquiry.ts";
import { authorisationLabel, PERMISSION_CHOICES } from "../client/permission.ts";
import type { Entry, ViewState } from "../client/reduce.ts";
import { toolSummary } from "../client/tool-summary.ts";
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
  /**
   * Where the human is up to in the Enquiry blocking this turn, or absent.
   *
   * Deliberately **not** an `Overlay`. Every Overlay is opened by the human with a chord and closed
   * with Escape; this one is opened by the model and cannot be closed at all — so folding it into
   * that union would hand `handleOverlayKey`'s Escape a dismissal that must not exist. It is also
   * drawn *with* the transcript rather than over it: an Overlay hides the transcript because it is a
   * different task, but the message that motivated the question is the last thing on screen and is
   * the reason the question makes any sense.
   *
   * Which Enquiry it belongs to is `view.asking`; this is only the cursor's place within it.
   */
  answering?: Answering;
  /**
   * Where the cursor is in the Permission Prompt picker. Deliberately not an `Overlay`, for the
   * reason `answering` is not one: it is opened by the model, and Escape must not dismiss it.
   *
   * A bare index rather than an `Answering`, because there is nothing else to hold: the three choices
   * are fixed, none is typed, and which prompt it belongs to is `view.authorising`.
   */
  deciding?: number;
  notice?: string;
  /** Passed in rather than read from the clock, so a frame renders identically twice. */
  now?: number;
};

export type Size = { columns: number; rows: number };

export function renderFrame(ui: UiState, size: Size): string[] {
  const width = Math.max(20, size.columns);
  const height = Math.max(6, size.rows);
  // Only ever one of the two: an Enquiry and a Permission Prompt are both a callback the CLI is
  // blocked on, and the composer is locked to whichever is in hand. Concatenated rather than chosen
  // between, so if the impossible happens the human can see both rather than one of them silently
  // going missing behind a lockout.
  const picker = [...enquiryLines(ui, width), ...permissionLines(ui, width)];
  // The picker takes its rows off the transcript rather than replacing it, which is the difference
  // between this and an Overlay. Bounded so a four-option Question on a short terminal still leaves
  // something of the conversation visible.
  const body = height - 3 - picker.length;

  const lines = [header(ui, width)];
  lines.push(...(ui.overlay.kind === "none" ? transcript(ui.view, width, body) : overlay(ui, width, body)));
  lines.push(...picker);
  lines.push(status(ui, width));
  lines.push(promptLine(ui, width));
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

/**
 * The Enquiry picker: the Question on screen, its Options, and where the cursor is.
 *
 * Empty when nothing is being asked, which is what keeps `renderFrame` free of a conditional — the
 * rows are simply zero and the transcript gets its full height back.
 *
 * Numbers are a visible column, and that is the one thing this does that an arrow-driven list
 * cannot: a row can be addressed without being travelled to. It is what "numbered picker" means, and
 * it is why the digits are worth borrowing from the prompt line to get.
 */
function enquiryLines(ui: UiState, width: number): string[] {
  const asking = ui.view.asking;
  const state = ui.answering;
  if (!asking || !state) return [];
  const question = asking.questions[state.index];
  if (!question) return [];

  const rows = rowsFor(question, ui.input);
  const progress = progressLabel(state, asking.questions);
  const mode = question.multiSelect ? "  (choose any)" : "";
  const title = `${question.header}${progress ? `  (${progress})` : ""}${mode}`;

  const lines = [rule(title, width), ...wrap(question.question, width)];
  rows.forEach((row, index) => {
    const onCursor = index === state.cursor;
    const cursor = onCursor ? ">" : " ";
    // The box only where it means something. A single-select has exactly one answer at all times,
    // so drawing an empty one beside every row would offer a choice that is not on offer.
    const box = question.multiSelect ? ((state.chosen[state.index] ?? []).includes(row.label) ? "[x] " : "[ ] ") : "";
    const head = `${cursor} ${index + 1} ${box}${row.label}`;

    /*
     * The row under the cursor gets its whole description, wrapped underneath; the rest get one
     * clipped line.
     *
     * An Option's description is not a nicety the way a Skill's is in the `/` menu — it is the
     * deciding information, and the model writes it long: a hundred characters saying what the
     * trade-off is, with the trade-off itself at the end. Clipping every row to the width of a
     * terminal reliably cuts off the half that decides it.
     *
     * So the one being considered is shown in full and the others stay scannable. The picker's
     * height therefore changes as the cursor moves, which is the cost of this and is paid
     * deliberately: what it buys is never having to choose between options whose descriptions have
     * been cut in the same place.
     */
    if (!row.description) {
      lines.push(clip(head, width));
      return;
    }
    if (onCursor) {
      lines.push(clip(head, width));
      // Indented under the number, so the wrapped text reads as belonging to the row above it.
      for (const line of wrap(row.description, Math.max(8, width - 6))) lines.push(clip(`      ${line}`, width));
      return;
    }
    lines.push(ellipsised(`${head}  ${row.description}`, width));
  });
  return lines;
}

/**
 * The Permission Prompt picker: what wants to run, and the three things a human can do about it.
 *
 * Empty when nothing is waiting, which keeps `renderFrame` free of a conditional, exactly as
 * `enquiryLines` does.
 *
 * What is being authorised is read off the `tool` Entry this prompt shares an id with, rather than
 * carried on the prompt itself: `toolSummary` already précises a call's arguments for both
 * front-ends, and a second description of the same call is a second thing to keep in step. The tool
 * name alone would be the withholding `tool-summary.ts` exists to stop — "authorise Bash?" is not a
 * question anyone can answer.
 */
function permissionLines(ui: UiState, width: number): string[] {
  const authorising = ui.view.authorising;
  if (!authorising) return [];
  const cursor = ui.deciding ?? 0;

  const call = ui.view.entries.find(
    (entry): entry is Extract<Entry, { kind: "tool" }> =>
      entry.kind === "tool" && entry.id === authorising.callId,
  );
  const summary = call ? toolSummary(call.input) : undefined;

  const lines = [rule(`Authorise ${authorising.tool}?`, width)];
  if (summary) lines.push(...wrap(summary, width));

  PERMISSION_CHOICES.forEach((choice, index) => {
    const onCursor = index === cursor;
    const head = `${onCursor ? ">" : " "} ${index + 1} ${choice.label}`;
    // The description in full on the cursor row and clipped elsewhere, the rule `enquiryLines`
    // sets — and here the row it matters for is Always, whose description is the whole warning.
    if (!onCursor) {
      lines.push(ellipsised(`${head}  ${choice.description}`, width));
      return;
    }
    lines.push(clip(head, width));
    for (const line of wrap(choice.description, Math.max(8, width - 6))) {
      lines.push(clip(`      ${line}`, width));
    }
  });
  return lines;
}

/**
 * The prompt line, and — while an Enquiry is open — the whole of how the lockout is stated.
 *
 * The TUI has no placeholder to put it in, so the sigil carries it: `?` rather than `>`, because a
 * `>` over a box that cannot send a message tells exactly the lie the web client's placeholder is
 * careful to refuse.
 */
function promptLine(ui: UiState, width: number): string {
  // A Permission Prompt takes no text at all, so there is nothing to type and nothing to show
  // typed. `!` rather than `?`: the difference between being asked something and being asked to
  // allow something is the whole distinction between an Enquiry and this, and the sigil is the only
  // place a terminal has to say it.
  if (ui.view.authorising) return clip("! [1-3 to decide]", width);
  if (!ui.view.asking) return clip(`> ${ui.input}`, width);
  return clip(ui.input === "" ? "? [type your own answer]" : `? ${ui.input}`, width);
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
  /*
   * While an Enquiry is open the hints are replaced rather than added to, because most of them are
   * no longer true: nothing here sends a message, and `^K` is refused. `esc abort` survives and is
   * the one way out — the TUI has no Abort button to give Escape a second job, which is why it means
   * abort here where on the web it means going back a Question.
   */
  parts.push(
    ui.view.authorising
      ? "↑↓ choose  1-3 pick  enter decide  esc deny"
      : ui.view.asking
      ? "↑↓ choose  1-9 pick  enter answer  esc abort"
      : `^S sessions  ^P models  ^E effort  ^G branches${compact}  esc abort  ^C quit`,
  );
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
    case "tool": {
      // The authorisation only where there is one — most rows have none, and a terminal that printed
      // something for them would suggest a decision nobody was asked to make.
      const authorised = authorisationLabel(entry.authorisation);
      return [clip(`  [${entry.status}] ${entry.name}${authorised ? ` — ${authorised}` : ""}`, width)];
    }
    case "subagent":
      // Indented past a tool call: a Subagent is what one of those is doing, not another of them.
      return [clip(`    ⤷ [${entry.waitingOn ?? entry.status}] ${entry.name}`, width)];
    case "background_call":
      // Indented for the same reason, and for the same relationship: this is what the tool call
      // above it is still doing. Its own glyph, because the row above says `complete` — that call
      // handed back a receipt, and this is the work the receipt promised (ADR 0021).
      return [clip(`    ⟳ [${entry.status}] ${entry.tool}`, width)];
    case "enquiry": {
      // What was asked and what was chosen, which is the whole requirement of this row. The lines
      // come from the shared module, so the terminal and the browser cannot disagree about what an
      // answered Enquiry says — only about how it is drawn.
      const head = clip(`  [${entry.status}] asked ${entry.questions.length === 1 ? "a question" : `${entry.questions.length} questions`}`, width);
      if (entry.status !== "answered") return [head];
      return [head, ...answerLines(entry.questions, entry.answers).map((line) => clip(`    ${line}`, width))];
    }
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
      // `restingAt`, which is also what the list is ordered by — a column showing one time while
      // the rows are sorted by another reads as broken the first time they disagree.
      const updated = relativeTime(session.restingAt, now);
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

/**
 * Clipped, but saying so.
 *
 * `clip` cuts silently, which is right for a header where the reader can see the shape of what is
 * missing. It is wrong for an Option's description, where a sentence that stops mid-word is
 * indistinguishable from one the model wrote that way — and the reader is being asked to choose on
 * the strength of it.
 */
function ellipsised(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function clip(text: string, width: number): string {
  return text.length > width ? text.slice(0, width) : text;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + " ".repeat(width - text.length);
}
