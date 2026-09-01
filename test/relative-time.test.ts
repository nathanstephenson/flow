import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { relativeTime } from "../src/client/relative-time.ts";

const NOW = Date.parse("2026-09-01T12:00:00.000Z");
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The "last updated" badge both front-ends render, which is why there is only one of these. */
describe("relative time", () => {
  it("reads anything under a minute as just now", () => {
    assert.equal(relativeTime(ago(0), NOW), "just now");
    assert.equal(relativeTime(ago(59 * SECOND), NOW), "just now");
  });

  it("counts minutes up to the hour", () => {
    assert.equal(relativeTime(ago(MINUTE), NOW), "1m");
    assert.equal(relativeTime(ago(59 * MINUTE), NOW), "59m");
  });

  it("counts hours up to the day", () => {
    assert.equal(relativeTime(ago(HOUR), NOW), "1h");
    assert.equal(relativeTime(ago(90 * MINUTE), NOW), "1h");
    assert.equal(relativeTime(ago(23 * HOUR), NOW), "23h");
  });

  it("falls back to the date past a day", () => {
    assert.equal(relativeTime(ago(DAY), NOW), "2026-08-31");
    assert.equal(relativeTime(ago(400 * DAY), NOW), "2025-07-28");
  });

  /** Clock skew between writing a timestamp and reading it should read as recent, not negative. */
  it("treats a future timestamp as just now", () => {
    assert.equal(relativeTime(new Date(NOW + HOUR).toISOString(), NOW), "just now");
  });

  it("renders nothing rather than 'Invalid Date' for a missing or unparseable stamp", () => {
    assert.equal(relativeTime(undefined, NOW), "");
    assert.equal(relativeTime("", NOW), "");
    assert.equal(relativeTime("not a date", NOW), "");
  });
});
