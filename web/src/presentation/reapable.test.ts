import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SessionStatus, SessionSummary } from "../../../src/protocol/commands.ts";
import { reapableAt } from "./reapable.ts";

/**
 * This counts what a retention window would delete, so the Settings page can say so before the
 * reader commits. It has to agree with `SessionHost.reap` — the risk in computing it client-side —
 * so these mirror that method's rules: only Settled Agent Sessions, and an unreadable timestamp is
 * left alone (ADR 0006).
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function summary(id: string, status: SessionStatus, agoHours: number): SessionSummary {
  return {
    id,
    scope: "/workspace",
    backend: "fake",
    status,
    title: id,
    updatedAt: new Date(NOW - agoHours * HOUR).toISOString(),
    lastSeq: 0,
  };
}

describe("what a retention window would reap", () => {
  const sessions = [
    summary("fresh", "settled", 1),
    summary("stale", "settled", 30),
    summary("ancient", "settled", 400),
    summary("idle", "idle", 400),
    summary("dormant", "dormant", 400),
    summary("ended", "ended", 400),
  ];

  const ids = (window: string): string[] =>
    reapableAt(sessions, window, NOW).map((session) => session.id);

  it("takes only Settled Agent Sessions past the window", () => {
    assert.deepEqual(ids("1d"), ["stale", "ancient"]);
    assert.deepEqual(ids("36h"), ["ancient"]);
  });

  /**
   * The rule that matters most: an Ended Agent Session is never reaped however old it is, and
   * neither is one that is merely Dormant. Only Settled opts into deletion.
   */
  it("never touches a state that did not opt in", () => {
    for (const id of ids("1s")) {
      assert.ok(!["idle", "dormant", "ended"].includes(id), `${id} must not be reapable`);
    }
    assert.deepEqual(ids("1s"), ["fresh", "stale", "ancient"]);
  });

  it("reaps nothing on 'never'", () => {
    assert.deepEqual(ids("never"), []);
  });

  /**
   * The reader is typing this field, so it is read mid-keystroke. `"3"` and `"3d"` differ by one
   * character and the first must not flash a count — a warning that appears and vanishes as you
   * type teaches you to ignore it.
   */
  it("reaps nothing for a window the daemon would refuse", () => {
    for (const junk of ["", "3", "d", "1w", "-1d", "1 fortnight", "0s"]) {
      assert.deepEqual(ids(junk), [], `expected ${junk} to count nothing`);
    }
  });

  it("leaves an Agent Session whose age cannot be read", () => {
    const broken: SessionSummary = { ...summary("broken", "settled", 0), updatedAt: "not a date" };
    // Not knowing something's age is not a reason to delete it — the same safe failure reap() takes.
    assert.deepEqual(reapableAt([broken], "1s", NOW), []);
  });

  it("counts one exactly at the boundary, as the sweep does", () => {
    // reap() compares `now - settledAt < retention` and skips, so equality is reaped.
    assert.deepEqual(ids("30h"), ["stale", "ancient"]);
  });
});
