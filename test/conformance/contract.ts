import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BackendSession } from "../../src/backend/types.ts";
import type { BackendEvent } from "../../src/protocol/events.ts";

export type ConformanceTarget = {
  name: string;
  /** Longest a single turn may take on this adapter. */
  turnTimeoutMs: number;
  createSession(emit: (event: BackendEvent) => void): Promise<BackendSession>;
  /** Drive one plain-text turn to completion, however this adapter needs to be driven. */
  runTurn(session: BackendSession, text: string): Promise<void>;
};

const HOST_OWNED = new Set(["user_message", "queue_changed", "revived", "session_ended"]);

/**
 * The Backend Adapter contract. Every adapter runs this same spec unmodified — it is what stops
 * the Agent Event union quietly becoming the shape of whichever backend was written first.
 */
export function runContract(target: ConformanceTarget): void {
  describe(`Backend Adapter contract: ${target.name}`, () => {
    it("declares at least one provider", async () => {
      const { session, dispose } = await start(target);
      try {
        assert.ok(session.capabilities.providers.length > 0);
      } finally {
        await dispose();
      }
    });

    it("brackets a turn with exactly one turn_started and one turn_ended", async () => {
      const { session, events, dispose } = await start(target);
      try {
        await target.runTurn(session, "Reply with exactly: ok");

        const types = events.map((event) => event.type);
        assert.equal(count(types, "turn_started"), 1, `saw: ${types.join(",")}`);
        assert.equal(count(types, "turn_ended"), 1, `saw: ${types.join(",")}`);
        assert.ok(
          types.indexOf("turn_started") < types.indexOf("turn_ended"),
          "turn_started must precede turn_ended",
        );
      } finally {
        await dispose();
      }
    });

    it("never emits events the Session Host owns", async () => {
      const { session, events, dispose } = await start(target);
      try {
        await target.runTurn(session, "Reply with exactly: ok");
        const trespass = events.map((event) => event.type).filter((type) => HOST_OWNED.has(type));
        assert.deepEqual(trespass, [], "adapters must not emit host-owned events");
      } finally {
        await dispose();
      }
    });

    it("pairs every tool_started with a tool_ended", async () => {
      const { session, events, dispose } = await start(target);
      try {
        await target.runTurn(session, "Reply with exactly: ok");
        const started = events.filter((event) => event.type === "tool_started").map((event) => event.callId);
        const ended = new Set(events.filter((event) => event.type === "tool_ended").map((event) => event.callId));
        for (const callId of started) assert.ok(ended.has(callId), `tool ${callId} never ended`);
      } finally {
        await dispose();
      }
    });

    it("emits message events as growing snapshots, not deltas", async () => {
      const { session, events, dispose } = await start(target);
      try {
        await target.runTurn(session, "Reply with exactly: ok");

        const byId = new Map<string, string[]>();
        for (const event of events) {
          if (event.type !== "message") continue;
          const seen = byId.get(event.id) ?? [];
          seen.push(event.text);
          byId.set(event.id, seen);
        }
        for (const [id, texts] of byId) {
          for (let index = 1; index < texts.length; index += 1) {
            const previous = texts[index - 1] ?? "";
            const current = texts[index] ?? "";
            assert.ok(
              current.startsWith(previous),
              `message ${id} shrank or diverged: ${JSON.stringify(previous)} -> ${JSON.stringify(current)}`,
            );
          }
        }
      } finally {
        await dispose();
      }
    });

    it("tolerates being disposed twice", async () => {
      const { dispose } = await start(target);
      await dispose();
      await dispose();
    });
  });
}

async function start(target: ConformanceTarget): Promise<{
  session: BackendSession;
  events: BackendEvent[];
  dispose: () => Promise<void>;
}> {
  const events: BackendEvent[] = [];
  const session = await target.createSession((event) => events.push(event));
  return { session, events, dispose: () => session.dispose() };
}

function count(values: string[], value: string): number {
  return values.filter((candidate) => candidate === value).length;
}
