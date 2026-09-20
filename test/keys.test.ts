import assert from "node:assert/strict";
import { it } from "node:test";

import { KeySplitter, KEY } from "../src/tui/keys.ts";

for (const sequence of [KEY.focusIn, KEY.focusOut]) {
  for (let boundary = 1; boundary < sequence.length; boundary += 1) {
    it(`buffers ${JSON.stringify(sequence)} split after byte ${boundary}`, () => {
      const splitter = new KeySplitter();
      assert.deepEqual(splitter.push(sequence.slice(0, boundary)), []);
      assert.deepEqual(splitter.push(sequence.slice(boundary)), [sequence]);
    });
  }
}
