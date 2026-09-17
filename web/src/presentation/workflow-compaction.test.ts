import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { reduceAll } from "../../../src/client/reduce.ts";
import type { BackendEvent, LoggedEvent } from "../../../src/protocol/events.ts";
import { showWorkflowCompacting } from "./workflow-compaction.ts";

const transcript = (events: BackendEvent[]) => reduceAll(events.map((event, index): LoggedEvent => ({
  sessionId: "workflow-attempt",
  seq: index + 1,
  at: new Date(index).toISOString(),
  event,
})));

describe("Workflow attempt compaction activity", () => {
  it("shows only an observable live lifecycle and clears it on completion", () => {
    const active = transcript([{ type: "compacting", active: true }]);
    assert.equal(showWorkflowCompacting(active.compacting, false), true);

    const stopped = transcript([
      { type: "compacting", active: true },
      { type: "compacting", active: false },
    ]);
    assert.equal(showWorkflowCompacting(stopped.compacting, false), false);
  });

  it("retains successful markers without fabricating unknown token counts", () => {
    const complete = transcript([
      { type: "compacting", active: true },
      { type: "compacted", trigger: "auto", before: 84_000 },
    ]);
    assert.equal(showWorkflowCompacting(complete.compacting, false), false);
    assert.deepEqual(complete.entries.at(-1), {
      kind: "marker",
      id: "compacted-0",
      marker: "compacted",
      text: "Compacted automatically, from 84k tokens",
    });
  });

  it("never leaves terminal attempts showing stale progress", () => {
    const stale = transcript([{ type: "compacting", active: true }]);
    for (const terminal of ["completed", "failed", "cancelled"]) {
      assert.equal(showWorkflowCompacting(stale.compacting, true), false, terminal);
    }
  });
});
