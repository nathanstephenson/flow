import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BackendSession } from "../../src/backend/types.ts";
import type { BackendEvent, ModelInfo } from "../../src/protocol/events.ts";

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

    it("declares Effort per model, never as an empty list", async () => {
      const { session, dispose } = await start(target);
      try {
        for (const model of await models(session)) {
          assert.ok(
            model.effortLevels === undefined || model.effortLevels.length > 0,
            `${model.id} declares an empty effort list; absent is how "no effort control" is said`,
          );
        }
      } finally {
        await dispose();
      }
    });

    it("announces the model in force, so a client knows which Effort levels apply", async () => {
      const { session, events, dispose } = await start(target);
      try {
        const inForce = await modelInForce(session, events);
        assert.ok(
          (await models(session)).some((model) => model.id === inForce),
          `the announced model ${inForce} must be one the picker offers`,
        );
      } finally {
        await dispose();
      }
    });

    it("honours a level the model in force serves, and shrugs off one it does not", async () => {
      const { session, events, dispose } = await start(target);
      try {
        // The model in force, rather than any model on the list: it is the one this account can
        // certainly reach, and it is the one whose levels a client is allowed to offer.
        const inForce = await modelInForce(session, events);
        const levels = (await models(session)).find((model) => model.id === inForce)?.effortLevels ?? [];
        events.length = 0;

        if (levels.length === 0) {
          // No effort control on this model. Asking anyway must be a no-op, not an error.
          await session.setEffort("high");
          assert.deepEqual(effortEvents(events), [], "a model with no effort control must report none");
          return;
        }

        const wanted = levels[0];
        await session.setEffort(wanted ?? "high");
        assert.deepEqual(
          effortEvents(events),
          [wanted],
          "setting a level the model serves must report exactly that level, once",
        );
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

/** Claude fetches its model list over the control channel, so it lands shortly after create(). */
async function models(session: BackendSession, timeoutMs = 15_000): Promise<ModelInfo[]> {
  const deadline = Date.now() + timeoutMs;
  while (session.capabilities.models.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return session.capabilities.models;
}

/** Adapters announce the model in force with model_changed as the session opens. */
async function modelInForce(session: BackendSession, events: BackendEvent[], timeoutMs = 15_000): Promise<string> {
  const announced = (): string | undefined =>
    events.filter((event) => event.type === "model_changed").at(-1)?.model.id;
  const deadline = Date.now() + timeoutMs;
  while (announced() === undefined && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const model = announced();
  assert.ok(model, "an adapter must say which model its session is running");
  return model;
}

function effortEvents(events: BackendEvent[]): string[] {
  return events.filter((event) => event.type === "effort_changed").map((event) => event.effort);
}

function count(values: string[], value: string): number {
  return values.filter((candidate) => candidate === value).length;
}
