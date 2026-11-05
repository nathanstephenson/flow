import type { Binding } from "./bindings.ts";

/**
 * The shortcuts, as prose — the reading half of `bindings.ts`.
 *
 * Separate from the table because the two answer different questions. `resolveBinding` decides what
 * a keystroke *means*, and has to be a switch over `event.key` to do it; this says what each binding
 * is *for*, in the order a reader wants to meet them. Deriving either from the other would mean
 * putting prose in the switch or a keystroke parser here, and both are worse than a test.
 *
 * That test is shortcuts.test.ts: it presses every `keys` entry through `resolveBinding`, or through
 * the Composer keymap named by `composer`, and checks it lands on the stated binding, and that every
 * `Binding` is documented exactly once. So a key that
 * stops working cannot keep being advertised, and a binding that is added cannot go unmentioned.
 *
 * DOM-free, like everything here — a keystroke is a string, not a KeyboardEvent.
 */

export type Shortcut = {
  /** The global binding. Absent for keys the Composer takes, which `bindings.ts` never sees. */
  binding?: Binding;
  /** The Composer's keymap that takes the key, so the test can press it through that keymap. */
  composer?: "menu" | "enquiry" | "permission";
  /** Exactly what `event.key` reports, so the test can press what is printed. */
  keys: string[];
  /** Held with ⌘ or Ctrl. Only chords survive a typing surface, because they cannot be typed into one. */
  chord?: true;
  /** Held with Shift. Not set for `?` and `~`, which are the characters Shift makes. */
  shift?: true;
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
      "The rail cursor is not the Agent Session on screen. Move the cursor, then press Enter to open that Agent Session.",
    shortcuts: [
      { binding: "sidebar-next", keys: ["j", "ArrowDown"], description: "Next Agent Session in the rail" },
      {
        binding: "sidebar-previous",
        keys: ["k", "ArrowUp"],
        description: "Previous Agent Session in the rail",
      },
      { binding: "sidebar-first", keys: ["Home"], description: "First Agent Session in the rail" },
      { binding: "sidebar-last", keys: ["End"], description: "Last Agent Session in the rail" },
      {
        binding: "focus-pane",
        keys: ["Enter"],
        description: "Open the Agent Session at the cursor and move focus to its Composer",
      },
    ],
  },
  {
    title: "With an Agent Session on screen",
    description: "No single key here spends money or sends text.",
    shortcuts: [
      {
        binding: "toggle-bottom-dock",
        keys: ["`"],
        description: "Show or minimise the bottom Dock. Minimising does not end its Shells",
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
        description: "Find in the Presentation Transcript. Escape closes the field",
      },
      {
        binding: "blur-or-abort",
        keys: ["Escape"],
        description:
          "Leave the Composer. If nothing has focus, abort the turn. Abort discards the Steering Queue",
      },
    ],
  },
  {
    title: "In the Composer",
    description: "These keys apply when the Composer has focus.",
    shortcuts: [
      { keys: ["Enter"], description: "Send the message" },
      { keys: ["Enter"], shift: true, description: "Add a new line" },
      {
        composer: "menu",
        keys: ["ArrowUp", "ArrowDown"],
        description: "In the / menu: move the highlight",
      },
      { composer: "menu", keys: ["Tab"], description: "In the / menu: complete the name" },
      { composer: "menu", keys: ["Enter"], description: "In the / menu: complete the name and send it" },
      { composer: "menu", keys: ["Escape"], description: "In the / menu: close it" },
      {
        composer: "permission",
        keys: ["1", "2", "3"],
        description: "Permission Prompt: choose a decision",
      },
      { composer: "permission", keys: ["Enter"], description: "Permission Prompt: decide" },
      { composer: "permission", keys: ["Escape"], description: "Permission Prompt: deny" },
      {
        composer: "enquiry",
        keys: ["1", "2", "3", "4", "5"],
        description: "Enquiry, with the box empty: choose an Option",
      },
      {
        composer: "enquiry",
        keys: [" "],
        description: "Enquiry, with the box empty: add or remove an Option, if more than one can apply",
      },
      { composer: "enquiry", keys: ["Enter"], description: "Enquiry: answer the Question" },
      { composer: "enquiry", keys: ["Escape"], description: "Enquiry: go back to the previous Question" },
    ],
  },
  {
    title: "Everywhere",
    shortcuts: [
      {
        binding: "new-agent-session",
        keys: ["n"],
        description: "Open the New Agent Session view. It does not start an Agent Session",
      },
      {
        binding: "toggle-rail",
        keys: ["b"],
        chord: true,
        description: "Show or hide the rail. Drag its right edge to change its width",
      },
      { binding: "keyboard-settings", keys: ["?"], description: "Show this list" },
      { binding: "leave-settings", keys: ["Escape"], description: "Leave the Settings" },
    ],
  },
];

const ARROWS: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Space",
};

/**
 * A key as it should be printed on a cap.
 *
 * The stored form is `event.key` so the test can press it verbatim. The arrows are spelled as arrows,
 * and Space, which `event.key` reports as a blank, is spelled out.
 */
export function displayKey(key: string): string {
  return ARROWS[key] ?? key;
}
