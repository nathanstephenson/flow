// Step 0 spike. Proves the three load-bearing assumptions before any real config is written:
//   (a) Vite resolves the repo's `.ts`-suffixed import specifiers unchanged,
//   (b) the shared client modules typecheck under a DOM lib with no node types,
//   (c) the reducer actually runs in the browser when imported as TypeScript.
import { createRoot } from "react-dom/client";

// The whole point of the migration: import the reducer the TUI uses, as TypeScript, extension and
// all. src/client/reduce.ts imports "../protocol/events.ts" the same way.
import { initialState, reduce, type ViewState } from "@client/reduce.ts";
import { editDiff } from "@client/diff.ts";
import { relativeTime } from "@client/relative-time.ts";
import type { LoggedEvent } from "../../src/protocol/events.ts";

const framed = (seq: number, event: LoggedEvent["event"]): LoggedEvent => ({
  seq,
  sessionId: "spike",
  at: "2026-01-01T00:00:00.000Z",
  event,
});

let view: ViewState = initialState();
for (const entry of [
  framed(1, { type: "session_started", backend: "fake", scope: "/tmp", capabilities: { providers: ["p"], models: [{ id: "m" }], compaction: false, fork: false } }),
  framed(2, { type: "user_message", id: "u1", text: "hello" }),
  framed(3, { type: "turn_started", turnId: "t1" }),
  framed(4, { type: "message", id: "a1", text: "hi there", final: true }),
  framed(5, { type: "turn_ended", turnId: "t1", reason: "complete" }),
]) {
  view = reduce(view, entry);
}

const diff = editDiff({ file_path: "/a/b.ts", old_string: "x", new_string: "y" });

createRoot(document.getElementById("root")!).render(
  <pre id="spike-result">
    {JSON.stringify(
      {
        status: view.status,
        entries: view.entries.map((e) => `${e.kind}:${e.id}`),
        lastSeq: view.lastSeq,
        diffPath: diff?.path,
        relative: relativeTime("2026-01-01T00:00:00.000Z", Date.parse("2026-01-01T00:30:00.000Z")),
      },
      null,
      2,
    )}
  </pre>,
);
