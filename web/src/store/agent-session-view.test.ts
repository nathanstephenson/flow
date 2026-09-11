import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { SubscribeOptions } from "../../../src/client/connection.ts";
import type { AgentEvent } from "../../../src/protocol/events.ts";
import { createAgentSessionView, sameChrome, type TranscriptTransport } from "./agent-session-view.ts";

/**
 * The state layer under `node --test`: no DOM, no React, no network. The transport and the frame
 * scheduler are both injected, so a test drives an SSE burst and the frame it coalesces into
 * synchronously — which is the only way the coalescing and the key index are testable at all.
 */
function harness() {
  const frames: Array<() => void> = [];
  let subscription: SubscribeOptions | undefined;
  let stops = 0;
  let seq = 0;

  const transport: TranscriptTransport = {
    subscribe(options) {
      subscription = options;
      return () => {
        stops += 1;
      };
    },
  };

  const view = createAgentSessionView("s1", transport, {
    schedule: (task) => {
      frames.push(task);
    },
  });

  return {
    view,
    stops: () => stops,
    subscription: () => subscription,
    pendingFrames: () => frames.length,
    emit(event: AgentEvent): void {
      seq += 1;
      subscription?.onEntry({ seq, sessionId: "s1", at: "2026-09-01T00:00:00.000Z", event });
    },
    flush(): void {
      const pending = [...frames];
      frames.length = 0;
      for (const task of pending) task();
    },
  };
}

const started: AgentEvent = {
  type: "session_started",
  backend: "fake",
  scope: "/tmp/scope",
  capabilities: { providers: ["anthropic"], models: [], compaction: false, fork: false, subagents: false, enquiries: false, permissions: false },
};

describe("an Agent Session view", () => {
  it("does not start the transport when something subscribes", () => {
    const seen = harness();
    seen.view.subscribeChrome(() => {});
    seen.view.subscribeTranscript(() => {});

    // StrictMode subscribes twice. If subscribing started the transport, the second mount would
    // replay the whole Presentation Transcript.
    assert.equal(seen.subscription(), undefined);

    seen.view.start();
    assert.notEqual(seen.subscription(), undefined);
  });

  it("starts the transport once, however many times start is called", () => {
    const seen = harness();
    seen.view.start();
    const first = seen.subscription();
    seen.view.start();

    assert.equal(seen.subscription(), first);
  });

  it("resumes from the last seq it saw rather than replaying", () => {
    const seen = harness();
    seen.view.start();
    assert.equal(seen.subscription()?.since, 0);

    seen.emit(started);
    seen.emit({ type: "message", id: "a1", text: "hello", final: true });
    seen.view.stop();
    seen.view.start();

    assert.equal(seen.stops(), 1);
    assert.equal(seen.subscription()?.since, 2);
  });

  it("holds the key list still while a snapshot merely grows", () => {
    const seen = harness();
    seen.view.start();
    seen.emit({ type: "message", id: "a1", text: "hel", final: false });
    seen.flush();

    const keys = seen.view.getKeys();
    assert.deepEqual([...keys], ["assistant:a1"]);

    seen.emit({ type: "message", id: "a1", text: "hello there", final: false });
    seen.flush();
    // Identity, not contents: this is what keeps TranscriptView out of the streaming path.
    assert.equal(seen.view.getKeys(), keys);

    seen.emit({ type: "tool_started", callId: "t1", name: "Edit", input: {} });
    seen.flush();
    const grown = seen.view.getKeys();
    assert.notEqual(grown, keys);
    assert.deepEqual([...grown], ["assistant:a1", "tool:t1"]);

    // And the earlier array is still the one it was, so a component holding it has not been mutated
    // out from under React's bail-out check.
    assert.deepEqual([...keys], ["assistant:a1"]);
  });

  it("changes one entry's identity per tick, and leaves the others alone", () => {
    const seen = harness();
    seen.view.start();
    seen.emit({ type: "user_message", id: "u1", text: "go" });
    seen.emit({ type: "message", id: "a1", text: "wor", final: false });
    seen.flush();

    const user = seen.view.getEntry("user:u1");
    const assistant = seen.view.getEntry("assistant:a1");

    seen.emit({ type: "message", id: "a1", text: "working", final: false });
    seen.flush();

    const grown = seen.view.getEntry("assistant:a1");
    assert.equal(seen.view.getEntry("user:u1"), user);
    assert.notEqual(grown, assistant);
    assert.equal(grown?.kind === "assistant" ? grown.text : undefined, "working");
  });

  it("distinguishes entries that share an id across kinds", () => {
    const seen = harness();
    seen.view.start();
    seen.emit({ type: "message", id: "shared", text: "text", final: true });
    seen.emit({ type: "tool_started", callId: "shared", name: "Bash", input: { command: "ls" } });
    seen.flush();

    assert.equal(seen.view.getEntry("assistant:shared")?.kind, "assistant");
    assert.equal(seen.view.getEntry("tool:shared")?.kind, "tool");
  });

  it("coalesces a burst of events into one notification", () => {
    const seen = harness();
    let transcriptNotifies = 0;
    seen.view.subscribeTranscript(() => {
      transcriptNotifies += 1;
    });
    seen.view.start();

    // An initial replay arrives as one burst of SSE frames, which is the case this exists for.
    for (let index = 0; index < 50; index += 1) {
      seen.emit({ type: "message", id: `a${index}`, text: "x", final: true });
    }
    assert.equal(seen.pendingFrames(), 1);
    assert.equal(transcriptNotifies, 0);

    seen.flush();
    assert.equal(transcriptNotifies, 1);
    assert.equal(seen.view.getKeys().length, 50);

    // And the next event gets a frame of its own rather than being swallowed by the flushed one.
    seen.emit({ type: "message", id: "a50", text: "x", final: true });
    seen.flush();
    assert.equal(transcriptNotifies, 2);
  });

  it("does not touch the transcript for an event that changed nothing in it", () => {
    const seen = harness();
    let transcriptNotifies = 0;
    seen.view.subscribeTranscript(() => {
      transcriptNotifies += 1;
    });
    seen.view.start();
    seen.emit({ type: "message", id: "a1", text: "hi", final: true });
    seen.flush();
    const keys = seen.view.getKeys();
    const entry = seen.view.getEntry("assistant:a1");

    // A tool_ended for a call this client never saw. patchTool hands back the same entries array
    // (reduce.ts:184), which is the identity check that saves the work — reduce's documented
    // same-object bail-out does not fire here, because applyEvent spreads state on every branch.
    seen.emit({ type: "tool_ended", callId: "never-seen", result: "ok", isError: false });
    seen.flush();

    assert.equal(transcriptNotifies, 1, "one, from the message — not two");
    assert.equal(seen.view.getKeys(), keys);
    assert.equal(seen.view.getEntry("assistant:a1"), entry);
  });

  it("publishes chrome, including the link state and the Steering Queue's depth", () => {
    const seen = harness();
    let chromeNotifies = 0;
    seen.view.subscribeChrome(() => {
      chromeNotifies += 1;
    });
    seen.view.start();

    assert.equal(seen.view.getChrome().link, "connecting");
    seen.subscription()?.onLink?.("live");
    seen.emit(started);
    seen.emit({ type: "queue_changed", pending: ["one", "two"] });
    seen.flush();

    const chrome = seen.view.getChrome();
    assert.equal(chrome.link, "live");
    assert.equal(chrome.backend, "fake");
    assert.equal(chrome.scope, "/tmp/scope");
    assert.equal(chrome.queueDepth, 2);
    assert.equal(chromeNotifies, 1);
  });

  it("does not republish chrome for a link transition that is not one", () => {
    const seen = harness();
    seen.view.start();
    seen.subscription()?.onLink?.("live");
    seen.flush();

    let chromeNotifies = 0;
    seen.view.subscribeChrome(() => {
      chromeNotifies += 1;
    });
    seen.subscription()?.onLink?.("live");

    assert.equal(seen.pendingFrames(), 0);
    assert.equal(chromeNotifies, 0);
  });

  it("does not republish chrome for an event that moved nothing in the header", () => {
    const seen = harness();
    seen.view.start();
    seen.emit({ type: "queue_changed", pending: ["one"] });
    seen.flush();

    let chromeNotifies = 0;
    seen.view.subscribeChrome(() => {
      chromeNotifies += 1;
    });
    seen.emit({ type: "queue_changed", pending: ["one"] });
    seen.flush();

    // Nothing a reader can see changed — same depth, same status — so the header does not re-render.
    // This is `0` rather than `1` because Chrome no longer carries lastSeq: the reducer stamped a new
    // one, and the shallow compare is now able to see that nothing else moved.
    assert.equal(chromeNotifies, 0);
    assert.equal(seen.view.getChrome().queueDepth, 1);
  });

  it("publishes queued messages when their IDs change at the same depth", () => {
    const seen = harness();
    seen.view.start();
    seen.emit({ type: "queue_changed", pending: ["same"], ids: ["first"] });
    seen.flush();
    let notifications = 0;
    seen.view.subscribeChrome(() => { notifications += 1; });
    seen.emit({ type: "queue_changed", pending: ["same"], ids: ["second"] });
    seen.flush();
    assert.equal(notifications, 1);
    assert.deepEqual(seen.view.getChrome().queuedMessages, [{ id: "second", text: "same" }]);
    seen.emit({ type: "queue_changed", pending: [] });
    seen.flush();
    assert.deepEqual(seen.view.getChrome().queuedMessages, []);
  });

  it("publishes queued attachment changes and preserves unchanged snapshots", () => {
    const seen = harness();
    seen.view.start();
    seen.emit({ type: "queue_changed", pending: [""], ids: ["message"], attachments: [["first.png"]] });
    seen.flush();
    let notifications = 0;
    seen.view.subscribeChrome(() => { notifications += 1; });
    seen.emit({ type: "queue_changed", pending: [""], ids: ["message"], attachments: [["first.png"]] });
    seen.flush();
    assert.equal(notifications, 0);
    seen.emit({ type: "queue_changed", pending: [""], ids: ["message"], attachments: [["second.png"]] });
    seen.flush();
    assert.equal(notifications, 1);
    assert.deepEqual(seen.view.getChrome().queuedMessages?.[0]?.attachments, ["second.png"]);
  });

  it("records the markers that punctuate an Agent Session's life", () => {
    const seen = harness();
    seen.view.start();
    seen.emit({ type: "session_settled" });
    seen.emit({ type: "revived", fromSeq: 412 });
    seen.flush();

    assert.deepEqual([...seen.view.getKeys()], ["marker:settled-0", "marker:revived-412"]);
    assert.equal(seen.view.getChrome().status, "idle");
    const settled = seen.view.getEntry("marker:settled-0");
    assert.equal(settled?.kind === "marker" ? settled.marker : undefined, "settled");
  });

  it("stops notifying once the transport is stopped", () => {
    const seen = harness();
    seen.view.start();
    seen.view.stop();

    assert.equal(seen.stops(), 1);
  });
});

describe("the Chrome shallow compare", () => {
  const chrome = {
    status: "running" as const,
    backend: "fake",
    scope: "/tmp",
    capabilities: undefined,
    model: undefined,
    effort: undefined,
    branch: undefined,
    worktree: undefined,
    contextUsage: undefined,
    endedReason: undefined,
    queueDepth: 0,
    activeSubagents: 0,
    activeBackgroundCalls: 0,
    asking: undefined,
    authorising: undefined,
    compacting: false,
    spoken: false,
    link: "live" as const,
  };

  it("treats two chromes with the same fields as the same chrome", () => {
    assert.equal(sameChrome(chrome, { ...chrome }), true);
  });

  it("notices a field that moved", () => {
    assert.equal(sameChrome(chrome, { ...chrome, status: "settled" }), false);
    assert.equal(sameChrome(chrome, { ...chrome, queueDepth: 1 }), false);
    // A count rather than a list, precisely so this compares by value and a streaming tick that
    // changes nothing about the Subagents cannot force a chrome publish.
    assert.equal(sameChrome(chrome, { ...chrome, activeSubagents: 2 }), false);
    assert.equal(sameChrome(chrome, { ...chrome, activeSubagents: 0 }), true);
    assert.equal(sameChrome(chrome, { ...chrome, activeBackgroundCalls: 1 }), false);
    assert.equal(sameChrome(chrome, { ...chrome, activeBackgroundCalls: 0 }), true);
    assert.equal(sameChrome(chrome, { ...chrome, link: "gone" }), false);
  });

  it("compares nested chrome objects by identity, so an equal-valued rebuild counts as a change", () => {
    const usage = { used: 10, window: 100 };
    assert.equal(sameChrome({ ...chrome, contextUsage: usage }, { ...chrome, contextUsage: usage }), true);
    assert.equal(
      sameChrome({ ...chrome, contextUsage: usage }, { ...chrome, contextUsage: { used: 10, window: 100 } }),
      false,
    );
  });
});
