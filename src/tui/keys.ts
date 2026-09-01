/** Terminal key sequences, named so the input handler reads as intent rather than escape codes. */
export const KEY = {
  ctrlC: "\u0003",
  ctrlE: "\u0005",
  ctrlP: "\u0010",
  ctrlS: "\u0013",
  escape: "\u001b",
  enter: "\r",
  newline: "\n",
  backspace: "\u007f",
  backspaceAlt: "\b",
  up: "\u001b[A",
  down: "\u001b[B",
} as const;

export function isPrintable(key: string): boolean {
  return key.length === 1 && key >= " " && key !== KEY.backspace;
}

/**
 * Split a stdin chunk into individual keys.
 *
 * A chunk is not a keystroke: a paste arrives as one chunk of many characters, and an arrow key
 * arrives as a three-byte escape sequence. Treating a chunk as one key silently drops both.
 */
export function splitKeys(chunk: string): string[] {
  const keys: string[] = [];
  let index = 0;
  while (index < chunk.length) {
    const char = chunk[index] ?? "";
    if (char === "\u001b" && chunk[index + 1] === "[") {
      // CSI sequence: ESC [ ... final byte in @-~
      let end = index + 2;
      while (end < chunk.length && !/[@-~]/.test(chunk[end] ?? "")) end += 1;
      keys.push(chunk.slice(index, end + 1));
      index = end + 1;
      continue;
    }
    keys.push(char);
    index += 1;
  }
  return keys;
}
