import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { messageTime } from "./message-time.ts";

const local = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).toISOString();
const now = new Date(2026, 10, 8, 18, 0);

describe("a message's time", () => {
  it("is the time of day today", () => {
    const text = messageTime(local(2026, 10, 8, 9, 5), now);
    assert.match(text, /09.05/);
    assert.doesNotMatch(text, /,/);
  });

  it("adds the date on another day, and the year in another year", () => {
    assert.match(messageTime(local(2026, 10, 7, 9, 5), now), /7.*,.*09.05/);
    assert.match(messageTime(local(2025, 10, 7, 9, 5), now), /2025/);
  });
});
