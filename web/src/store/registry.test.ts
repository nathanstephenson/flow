import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { OwnedAgentSessionView } from "./agent-session-view.ts";
import type { Chrome } from "./contract.ts";
import { createAgentSessionViewRegistry, type Delay } from "./registry.ts";

type FakeView = OwnedAgentSessionView & { starts: number; stops: number };

function fakeView(sessionId: string): FakeView {
  const view: FakeView = {
    sessionId,
    starts: 0,
    stops: 0,
    subscribeChrome: () => () => {},
    getChrome: (): Chrome => {
      throw new Error("the registry does not read chrome");
    },
    subscribeTranscript: () => () => {},
    getKeys: () => [],
    getEntry: () => undefined,
    start() {
      view.starts += 1;
    },
    stop() {
      view.stops += 1;
    },
  };
  return view;
}

/** A cancellable delay a test runs by hand, standing in for the fifteen-second grace period. */
function manualDelay(): { delay: Delay; run: () => void; pending: () => number } {
  let tasks: Array<() => void> = [];
  return {
    delay: (task) => {
      tasks.push(task);
      return () => {
        tasks = tasks.filter((candidate) => candidate !== task);
      };
    },
    run: () => {
      const due = tasks;
      tasks = [];
      for (const task of due) task();
    },
    pending: () => tasks.length,
  };
}

function harness() {
  const views = new Map<string, FakeView>();
  const timer = manualDelay();
  const registry = createAgentSessionViewRegistry({
    createView: (sessionId) => {
      const view = fakeView(sessionId);
      views.set(sessionId, view);
      return view;
    },
    delay: timer.delay,
    graceMs: 15_000,
  });
  return { registry, timer, view: (sessionId: string) => views.get(sessionId) };
}

describe("the Agent Session view registry", () => {
  it("starts one transport for however many holders an Agent Session has", () => {
    const seen = harness();
    const first = seen.registry.acquire("s1");
    const second = seen.registry.acquire("s1");

    assert.equal(first, second);
    assert.equal(seen.view("s1")?.starts, 1);
  });

  it("keeps the view alive while anything still holds it", () => {
    const seen = harness();
    seen.registry.acquire("s1");
    seen.registry.acquire("s1");
    seen.registry.release("s1");
    seen.timer.run();

    assert.equal(seen.timer.pending(), 0);
    assert.equal(seen.view("s1")?.stops, 0);
  });

  it("tears the transport down only after the grace period", () => {
    const seen = harness();
    seen.registry.acquire("s1");
    seen.registry.release("s1");

    assert.equal(seen.view("s1")?.stops, 0, "released is not stopped");
    seen.timer.run();
    assert.equal(seen.view("s1")?.stops, 1);
  });

  it("survives StrictMode's mount, unmount and mount again with no replay", () => {
    const seen = harness();
    const mounted = seen.registry.acquire("s1");
    seen.registry.release("s1");
    const remounted = seen.registry.acquire("s1");
    seen.timer.run();

    // The same view, still started once: a new view here would resume from seq 0 and replay the
    // whole Presentation Transcript, which is the failure this registry exists to prevent.
    assert.equal(remounted, mounted);
    assert.equal(seen.view("s1")?.starts, 1);
    assert.equal(seen.view("s1")?.stops, 0);
  });

  it("starts a fresh view once the old one has been torn down", () => {
    const seen = harness();
    seen.registry.acquire("s1");
    const first = seen.view("s1");
    seen.registry.release("s1");
    seen.timer.run();

    seen.registry.acquire("s1");
    assert.notEqual(seen.view("s1"), first);
    assert.equal(seen.view("s1")?.starts, 1);
  });

  it("does not schedule a second teardown for a release it has already handled", () => {
    const seen = harness();
    seen.registry.acquire("s1");
    seen.registry.release("s1");
    seen.registry.release("s1");

    assert.equal(seen.timer.pending(), 1);
    seen.timer.run();
    assert.equal(seen.view("s1")?.stops, 1);
  });

  it("ignores a release for an Agent Session it is not holding", () => {
    const seen = harness();
    seen.registry.release("never-acquired");

    assert.equal(seen.timer.pending(), 0);
  });

  it("keeps Agent Sessions apart", () => {
    const seen = harness();
    const one = seen.registry.acquire("s1");
    const two = seen.registry.acquire("s2");
    seen.registry.release("s1");
    seen.timer.run();

    assert.notEqual(one, two);
    assert.equal(seen.view("s1")?.stops, 1);
    assert.equal(seen.view("s2")?.stops, 0);
  });
});
