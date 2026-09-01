import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Entry } from "../../../src/client/reduce.ts";
import { entryKey } from "./entry-key.ts";

/**
 * The web app's presentation logic runs under the same `node --test` as everything else, with no DOM
 * and no bundler. That is deliberate: it is what keeps this layer free of the browser, and
 * tsconfig.presentation.json enforces the other half by refusing to compile a `document` reference.
 */
describe("Presentation Transcript entry keys", () => {
  it("separates entries that share an id but not a kind", () => {
    const assistant: Entry = { kind: "assistant", id: "shared", text: "hi", final: true };
    const tool: Entry = { kind: "tool", id: "shared", name: "Edit", input: {}, status: "complete" };

    assert.notEqual(entryKey(assistant), entryKey(tool), "an id is only unique within a kind");
  });

  it("holds still while a snapshot grows, so the entry is replaced rather than appended", () => {
    const partial: Entry = { kind: "assistant", id: "a1", text: "hel", final: false };
    const grown: Entry = { kind: "assistant", id: "a1", text: "hello there", final: true };

    assert.equal(entryKey(partial), entryKey(grown));
  });

  it("distinguishes the markers that punctuate an Agent Session's life", () => {
    const dormant: Entry = { kind: "marker", id: "dormant-3", marker: "dormant", text: "Dormant: x" };
    const revived: Entry = { kind: "marker", id: "revived-3", marker: "revived", text: "Revived from seq 3" };

    assert.equal(entryKey(dormant), "marker:dormant-3");
    assert.notEqual(entryKey(dormant), entryKey(revived));
  });
});
