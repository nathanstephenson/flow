import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { coalesce, scheduleFrame } from "./frame-scheduler.ts";

describe("frame coalescing", () => {
  it("runs the flush once however many times it is asked", () => {
    const frames: Array<() => void> = [];
    let flushes = 0;
    const request = coalesce(() => {
      flushes += 1;
    }, (task) => frames.push(task));

    for (let index = 0; index < 100; index += 1) request();
    assert.equal(frames.length, 1);
    assert.equal(flushes, 0);

    frames.pop()?.();
    assert.equal(flushes, 1);
  });

  it("gives an event that arrives during a flush a frame of its own", () => {
    const frames: Array<() => void> = [];
    let flushes = 0;
    const request = coalesce(() => {
      flushes += 1;
      // A listener notified by this flush provokes another change — a search field that reacts to a
      // new entry, say. It must not be dropped.
      if (flushes === 1) request();
    }, (task) => frames.push(task));

    request();
    frames.shift()?.();
    assert.equal(frames.length, 1);
    frames.shift()?.();
    assert.equal(flushes, 2);
  });

  it("falls back to a microtask where there is no animation frame to wait for", async () => {
    // Which is the case here, under node --test, and also the case in a hidden tab, where rAF
    // callbacks are parked and a transcript would stop updating altogether.
    let ran = false;
    scheduleFrame(() => {
      ran = true;
    });
    assert.equal(ran, false, "not synchronously");
    await Promise.resolve();
    assert.equal(ran, true);
  });
});
