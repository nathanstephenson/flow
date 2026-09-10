import type { Binding } from "./bindings.ts";

/**
 * The shortcuts, as prose — the reading half of `bindings.ts`.
 *
 * Separate from the table because the two answer different questions. `resolveBinding` decides what
 * a keystroke *means*, and has to be a switch over `event.key` to do it; this says what each binding
 * is *for*, in the order a reader wants to meet them. Deriving either from the other would mean
 * putting prose in the switch or a keystroke parser here, and both are worse than a test.
 *
 * That test is shortcuts.test.ts: it presses every `keys` entry through `resolveBinding` and checks
 * it lands on the stated binding, and that every `Binding` is documented exactly once. So a key that
 * stops working cannot keep being advertised, and a binding that is added cannot go unmentioned.
 *
 * DOM-free, like everything here — a keystroke is a string, not a KeyboardEvent.
 */

export type Shortcut = {
  binding: Binding;
  /** Exactly what `event.key` reports, so the test can press what is printed. */
  keys: string[];
  /** Held with ⌘ or Ctrl. Only chords survive a typing surface, because they cannot be typed into one. */
  chord?: true;
  description: string;
};

export type ShortcutGroup = {
  title: string;
  description?: string;
  shortcuts: Shortcut[];
};

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Moving around",
    description:
      "The rail's cursor is not the Agent Session on screen. Move it, then press Enter to open what it is on.",
    shortcuts: [
      { binding: "sidebar-next", keys: ["j", "ArrowDown"], description: "Next Agent Session in the rail" },
      {
        binding: "sidebar-previous",
        keys: ["k", "ArrowUp"],
        description: "Previous Agent Session in the rail",
      },
      { binding: "sidebar-first", keys: ["Home"], description: "First Agent Session" },
      { binding: "sidebar-last", keys: ["End"], description: "Last Agent Session" },
      { binding: "focus-pane", keys: ["Enter"], description: "Open the cursored one and type in it" },
    ],
  },
  {
    title: "Doing things",
    description:
      "Nothing here spends money or sends text on a single unmodified key: n opens the New Agent Session view rather than starting one, and no shortcut sends a message or Revives one.",
    shortcuts: [
      { binding: "new-agent-session", keys: ["n"], description: "New Agent Session — opens the view" },
      { binding: "settle", keys: ["s"], description: "Settle the Agent Session on screen" },
      {
        binding: "toggle-bottom-dock",
        keys: ["`"],
        description: "Show or minimise the bottom Dock — minimising does not end its Shells",
      },
      {
        binding: "toggle-right-dock",
        keys: ["~"],
        description: "Show or minimise the right Dock",
      },
      {
        binding: "search",
        keys: ["f"],
        chord: true,
        description: "Find in the Presentation Transcript — opens the field, Escape closes it",
      },
      { binding: "model-picker", keys: ["m"], description: "Model picker" },
      { binding: "effort-picker", keys: ["e"], description: "Effort picker" },
      {
        binding: "blur-or-abort",
        keys: ["Escape"],
        description: "Leave the Composer, or abort the turn — aborting discards the Steering Queue",
      },
    ],
  },
  {
    title: "Everywhere",
    shortcuts: [
      { binding: "command-palette", keys: ["k"], chord: true, description: "Command palette" },
      {
        binding: "toggle-rail",
        keys: ["b"],
        chord: true,
        description: "Show or hide the rail — drag its right edge to resize instead",
      },
      { binding: "keyboard-settings", keys: ["?"], description: "This list" },
      { binding: "leave-settings", keys: ["Escape"], description: "Leave the Settings" },
    ],
  },
];

const ARROWS: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * A key as it should be printed on a cap.
 *
 * The stored form is `event.key` so the test can press it verbatim; the arrow names are the only
 * ones nobody wants to read spelled out.
 */
export function displayKey(key: string): string {
  return ARROWS[key] ?? key;
}
