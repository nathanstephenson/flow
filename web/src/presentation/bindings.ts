/**
 * Keyboard bindings, resolved as data.
 *
 * One `keydown` listener on `window` asks this function what a key meant; everything DOM-shaped —
 * reading the event target, calling `preventDefault`, actually opening the picker — stays in the
 * component that owns it. So the map is testable under `node --test`, which is the only way a
 * shortcut table stays honest as it grows.
 *
 * Two principles it encodes, both from Part 9.6:
 *
 * - **Nothing that spends money or sends text is a single unmodified key.** `n` opens the New Agent
 *   Session dialog rather than starting one, `Enter` moves focus rather than sending, and there is
 *   deliberately no binding that sends a message or Revives an Agent Session.
 * - **Match the TUI where it already chose** (`src/tui/keys.ts`), so the two front-ends teach one
 *   muscle memory rather than two.
 */

import type { Route } from "./route.ts";

export type Binding =
  /** Opens the dialog with the defaults prefilled — it does not create anything. */
  | "new-agent-session"
  | "command-palette"
  | "sidebar-next"
  | "sidebar-previous"
  | "sidebar-first"
  | "sidebar-last"
  /** Move focus into the selected Agent Session's pane. */
  | "focus-pane"
  | "model-picker"
  | "effort-picker"
  | "search"
  /** Blur a typing surface if one has focus, otherwise abort the focused pane's turn. */
  | "blur-or-abort"
  | "settle"
  /** Show or minimise a Dock. Minimising it does not end the Shells inside it. */
  | "toggle-bottom-dock"
  | "toggle-right-dock"
  /** Show or hide the rail. Its width is remembered; whether it is open is not. */
  | "toggle-rail"
  /** Open the Settings at the section listing these bindings. */
  | "keyboard-settings"
  /** Leave the Settings for whatever was on screen before them. */
  | "leave-settings";

/**
 * Every binding, at runtime.
 *
 * `Record<Binding, true>` is what makes this exhaustive: adding a member to the union above without
 * adding it here is a compile error, which is how `shortcuts.ts` can be held to documenting all of
 * them. The values carry nothing — only the keys matter.
 */
const EVERY_BINDING = {
  "new-agent-session": true,
  "command-palette": true,
  "sidebar-next": true,
  "sidebar-previous": true,
  "sidebar-first": true,
  "sidebar-last": true,
  "focus-pane": true,
  "model-picker": true,
  "effort-picker": true,
  search: true,
  "blur-or-abort": true,
  settle: true,
  "toggle-bottom-dock": true,
  "toggle-right-dock": true,
  "toggle-rail": true,
  "keyboard-settings": true,
  "leave-settings": true,
} satisfies Record<Binding, true>;

export const ALL_BINDINGS = Object.keys(EVERY_BINDING) as Binding[];

/**
 * The parts of a `KeyboardEvent` a binding can depend on. A plain shape rather than the event
 * itself, so a test can express a keystroke as an object literal and this file needs no DOM.
 */
export type BindingEvent = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  repeat: boolean;
};

export type BindingContext = {
  /** A dialog, the palette or the keyboard sheet is open, and owns the keyboard while it is. */
  modalOpen: boolean;
  /** Focus is on a typing surface — see `isTypingTarget`. */
  typing: boolean;
  /**
   * What is on screen. Most of this table addresses the Agent Session rail and the pane, neither of
   * which exists in the Settings, so it is resolved here rather than by quietly omitting handlers in
   * the app shell — a key that does nothing should be visible as nothing in the table that owns it.
   */
  view: Route["view"];
};

/**
 * The bindings that survive in the Settings.
 *
 * Everything else addresses an Agent Session — a rail cursor, a pane, a Dock, a model — and the
 * Settings have none of those. `n` stays because starting an Agent Session is reasonable from
 * anywhere, and `?` stays because it lands on a section of the Settings itself.
 */
const IN_SETTINGS = new Set<Binding>([
  "new-agent-session",
  "command-palette",
  "toggle-rail",
  "keyboard-settings",
]);

export function resolveBinding(event: BindingEvent, context: BindingContext): Binding | undefined {
  const binding = resolveKey(event, context);
  if (binding === undefined || context.view !== "settings") return binding;

  // Escape means "leave" here rather than "abort a turn": there is no turn on screen to abort, and
  // leaving is what a reader presses it for in a page they navigated into.
  if (binding === "blur-or-abort") return "leave-settings";
  return IN_SETTINGS.has(binding) ? binding : undefined;
}

function resolveKey(event: BindingEvent, context: BindingContext): Binding | undefined {
  // An open dialog owns the keyboard, Escape included: Base UI closes itself on Escape, and letting
  // `s` through to Settle an Agent Session while someone types a Scope into a dialog is indefensible.
  if (context.modalOpen) return undefined;

  // ⌘ on a Mac, Ctrl everywhere else, from one table. A chord survives a typing surface because it
  // cannot be typed into one.
  if (event.ctrlKey || event.metaKey) {
    if (event.repeat) return undefined;
    if (event.key === "k" || event.key === "K") return "command-palette";
    // ⌘B is what shadcn's Sidebar binds, and the muscle memory is worth matching — but it is
    // resolved here rather than by the component's own window listener, so it can be suppressed
    // while a dialog owns the keyboard and can be printed in the Settings' Keyboard section.
    if (event.key === "b" || event.key === "B") return "toggle-rail";
    // Every other chord belongs to the browser. Stealing ⌘F in particular would break find-in-page
    // over the Presentation Transcript, which ADR 0001 defines as the record of what a human saw.
    return undefined;
  }

  // The one unmodified key that must survive a typing surface, because leaving the Composer is
  // exactly what a reader presses it for. Which of the two things it means is the caller's to
  // decide — it has the focus, this does not.
  if (event.key === "Escape") return "blur-or-abort";

  if (context.typing) return undefined;

  // Auto-repeat walks the list, which is what holding `j` is for. Nothing else repeats: a held `s`
  // would try to Settle an Agent Session several times over.
  switch (event.key) {
    case "j":
    case "ArrowDown":
      return "sidebar-next";
    case "k":
    case "ArrowUp":
      return "sidebar-previous";
  }
  if (event.repeat) return undefined;

  // Shift is not tested: a shifted letter arrives as an uppercase `key`, so it already fails to
  // match, and `?` arrives as `?` on the layouts that need Shift to produce it.
  switch (event.key) {
    // Home and End belong to the rail for the same reason `j` and `k` do: the cursor they move is
    // one piece of state owned by the app shell, and a rail that grew its own cursor for two keys
    // would be two cursors. They are global rather than scoped to the rail because this table is
    // resolved from one window listener — no scroller in this app consumes Home or End today, and
    // `context.typing` has already returned above for anything a caret lives in.
    case "Home":
      return "sidebar-first";
    case "End":
      return "sidebar-last";
    case "n":
      return "new-agent-session";
    case "Enter":
      return "focus-pane";
    case "m":
      return "model-picker";
    case "e":
      return "effort-picker";
    case "s":
      return "settle";
    // The backtick, because every other terminal toggle a reader has met is on this key, and its
    // shifted twin for the other Dock — one physical key, one finger, two sides. Both are safe as
    // unmodified bindings under the first principle above: showing a Dock spends nothing and sends
    // nothing, and minimising one does not end the Shells in it.
    case "`":
      return "toggle-bottom-dock";
    case "~":
      return "toggle-right-dock";
    case "/":
      return "search";
    case "?":
      return "keyboard-settings";
    default:
      return undefined;
  }
}

const TYPING_TAGS = new Set(["input", "textarea", "select"]);

/**
 * Whether focus is somewhere a keystroke is text rather than a command.
 *
 * Taken apart into four primitives so this stays DOM-free, and so the caller cannot pass a target it
 * has not thought about. The predicate the old client used was `target === document.body`, which was
 * too strict in a way that read as flaky rather than as a bug: after clicking any button focus is on
 * that button, not on the body, so every shortcut silently stopped working until the reader clicked
 * the background.
 *
 * `inShell` is the fourth, and it is not optional politeness: a Shell draws itself on a canvas and
 * takes keys through it, so nothing about the element says "text goes here". Without it, typing `s`
 * at a prompt Settles the Agent Session, and four Shells across two Docks make that a matter of time.
 */
export function isTypingTarget(
  tagName: string,
  isContentEditable: boolean,
  role: string | undefined,
  inShell: boolean,
): boolean {
  return (
    TYPING_TAGS.has(tagName.toLowerCase()) ||
    isContentEditable ||
    // A custom widget that says it accepts text is taken at its word.
    role === "textbox" ||
    inShell
  );
}
