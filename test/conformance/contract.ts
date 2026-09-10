import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { BackendSession } from "../../src/backend/types.ts";
import { HOST_OWNED_EVENT_TYPES } from "../../src/protocol/events.ts";
import type { BackendEvent, ModelInfo } from "../../src/protocol/events.ts";

export type ConformanceTarget = {
  name: string;
  /** Longest a single turn may take on this adapter. */
  turnTimeoutMs: number;
  /**
   * `tools` is passed through verbatim, so the contract can ask for a one-shot text call — the
   * shape the Summary Model runs in (ADR 0020). An adapter that ignores it fails the case below.
   */
  createSession(emit: (event: BackendEvent) => void, tools?: "none"): Promise<BackendSession>;
  /** Drive one plain-text turn to completion, however this adapter needs to be driven. */
  runTurn(session: BackendSession, text: string): Promise<void>;
};

const HOST_OWNED = new Set<string>(HOST_OWNED_EVENT_TYPES);

/**
 * The Backend Adapter contract. Every adapter runs this same spec unmodified — it is what stops
 * the Agent Event union quietly becoming the shape of whichever backend was written first.
 */
export function runContract(target: ConformanceTarget): void {
  describe(`Backend Adapter contract: ${target.name}`, () => {
    /**
     * A session that runs no tools still answers.
     *
     * Cheap on purpose: asserting against a real SDK that *no tool ran* would mean provoking one
     * and waiting to be sure it did not. What this rules out is the failure that actually bites —
     * an adapter that ignores the option, or worse honours it by *parking* the tool call it should
     * have denied, which holds the turn open until its caller gives up.
     */
    it("answers a turn with no tools at all", async () => {
      const { session, events, dispose } = await start(target, "none");
      try {
        await target.runTurn(session, "Reply with exactly: ok");
        const types = events.map((event) => event.type);
        assert.equal(count(types, "turn_ended"), 1, `saw: ${types.join(",")}`);
      } finally {
        await dispose();
      }
    });

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

    /**
     * Gated on `capabilities.subagents`, the way the Effort assertions gate on
     * `effortLevels.length`: an adapter that does not report Subagents is not a broken one, and
     * these must skip rather than fail for it.
     *
     * Deliberately not "before the turn ends" any more. A backgrounded Subagent outlives the turn
     * that spawned it (ADR 0016), so pairing is what an adapter owes and turn-scoped pairing is not
     * — what this rules out is the card left spinning with nothing that will ever close it.
     */
    it("pairs every Subagent with a terminal snapshot", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (!session.capabilities.subagents) return;
        await target.runTurn(session, "Reply with exactly: ok");

        const terminal = new Set(["complete", "aborted", "error"]);
        const open = new Set<string>();
        for (const event of events) {
          if (event.type !== "subagent") continue;
          if (terminal.has(event.state)) open.delete(event.subagentId);
          else open.add(event.subagentId);
        }
        assert.deepEqual([...open], [], "a Subagent was left running with nothing to ever close it");
      } finally {
        await dispose();
      }
    });

    /**
     * The same pairing as compaction below, for the same reason, and with one thing more at stake:
     * a client that offers a picker for an Enquiry nothing can answer holds a turn open forever.
     */
    it("backs a declared Enquiry capability with a method, and an undeclared one with neither", async () => {
      const { session, dispose } = await start(target);
      try {
        assert.equal(
          typeof session.answerEnquiry === "function",
          session.capabilities.enquiries,
          "capabilities.enquiries and BackendSession.answerEnquiry must say the same thing",
        );
      } finally {
        await dispose();
      }
    });

    /**
     * Gated on the flag, as the Subagent assertions are: an adapter with no channel to ask through
     * is not a broken one. Vacuous for a turn that asks nothing, which is how the Subagent
     * assertions already behave.
     */
    it("pairs every Enquiry with a terminal snapshot before the turn ends", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (!session.capabilities.enquiries) return;
        await target.runTurn(session, "Reply with exactly: ok");

        const open = new Set<string>();
        for (const event of events) {
          if (event.type !== "enquiry") continue;
          if (event.state === "asked") open.add(event.askId);
          else open.delete(event.askId);
        }
        // An Enquiry left open is a turn nobody can end: the CLI is still blocked on the permission
        // callback, and the Session Host never clears `turnInFlight`.
        assert.deepEqual([...open], [], "an Enquiry left open outlives the turn that asked it");
      } finally {
        await dispose();
      }
    });

    it("reports no Enquiry unless it declared it could ask", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (session.capabilities.enquiries) return;
        await target.runTurn(session, "Reply with exactly: ok");

        assert.deepEqual(
          events.filter((event) => event.type === "enquiry"),
          [],
          "a client hides the affordance on the flag, so an event behind it can never be answered",
        );
      } finally {
        await dispose();
      }
    });

    /** The same pairing, and the same thing at stake: buttons that settle nothing hold a turn open. */
    it("backs a declared Permission capability with a method, and an undeclared one with neither", async () => {
      const { session, dispose } = await start(target);
      try {
        assert.equal(
          typeof session.answerPermission === "function",
          session.capabilities.permissions,
          "capabilities.permissions and BackendSession.answerPermission must say the same thing",
        );
      } finally {
        await dispose();
      }
    });

    /**
     * Gated on the flag, and vacuous for a turn that asks nothing — the shape the two assertions
     * above already have.
     */
    it("pairs every Permission Prompt with a terminal snapshot before the turn ends", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (!session.capabilities.permissions) return;
        await target.runTurn(session, "Reply with exactly: ok");

        const open = new Set<string>();
        for (const event of events) {
          if (event.type !== "permission") continue;
          if (event.state === "asked") open.add(event.callId);
          else open.delete(event.callId);
        }
        // A prompt left open is a turn nobody can end: the CLI is still blocked on the callback, and
        // the Session Host never clears `turnInFlight`.
        assert.deepEqual([...open], [], "a Permission Prompt left open outlives the turn that raised it");
      } finally {
        await dispose();
      }
    });

    it("reports no Permission Prompt unless it declared it could ask", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (session.capabilities.permissions) return;
        await target.runTurn(session, "Reply with exactly: ok");

        assert.deepEqual(
          events.filter((event) => event.type === "permission"),
          [],
          "a client hides the affordance on the flag, so an event behind it can never be decided",
        );
      } finally {
        await dispose();
      }
    });

    /**
     * The flag and the method must agree, because the host gates on the flag alone and every client
     * hides its control on the flag alone. An adapter declaring `compaction` without a `compact` is
     * a control that throws a TypeError the first time anyone uses it.
     */
    it("backs a declared compaction with a method, and an undeclared one with neither", async () => {
      const { session, dispose } = await start(target);
      try {
        assert.equal(
          typeof session.compact === "function",
          session.capabilities.compaction,
          "capabilities.compaction and BackendSession.compact must say the same thing",
        );
      } finally {
        await dispose();
      }
    });

    /**
     * A compaction occupies the session, and it is never the model talking.
     *
     * Two halves, and they used to be one. The reply must not read as the model: the Claude SDK has
     * no `compact()`, so the adapter asks by putting `/compact` down the prompt channel, and the
     * CLI's answer comes back as an ordinary `assistant` message — left alone, "Not enough messages
     * to compact." appears in the Presentation Transcript as something the model said.
     *
     * **But it must read as a turn**, which is the half this asserted backwards. The reasoning was
     * that a local command is not billed and that a turn would leave the Steering Queue believing
     * the session busy. One session's transcript falsified both: summarising billed $3.85 and held
     * the backend for three minutes, during which "not busy" was the false belief — so a message
     * typed meanwhile was pushed into the backend ahead of the compaction, and a second request
     * sailed past the host's refusal. Occupancy is the fact every one of those depends on.
     *
     * An empty Conversation Context has nothing to compact, which is the point: this asserts the
     * shape of the exchange, not that a summary was produced.
     */
    it("occupies the session for a compaction, without it reading as the model talking", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (!session.compact) return;
        await session.compact();

        const started = events.filter((event) => event.type === "turn_started");
        assert.equal(started.length, 1, "the session is occupied before `compact` returns");

        // Polled rather than slept: a turn left open pins the session in `running` forever, so what
        // matters is that it closes at all, not how long an adapter's backend took to say so.
        const ended = await waitFor(events, (event) => event.type === "turn_ended", 60_000);
        assert.ok(ended, "a compaction that never ends its turn refuses every later message");
        assert.equal(
          ended.type === "turn_ended" ? ended.turnId : undefined,
          started[0]?.type === "turn_started" ? started[0].turnId : "",
          "it ends the turn it opened",
        );

        assert.deepEqual(
          events.filter((event) => event.type === "message"),
          [],
          "a local command's reply is not an assistant message",
        );
      } finally {
        await dispose();
      }
    });

    /**
     * Skills only — never the backend's own built-in commands.
     *
     * The Claude CLI answers `supportedCommands()` with 52 entries, of which 18 are Skills and the
     * rest are its own controls: `/model`, `/clear`, `/config`, `/compact`. Offering those in the
     * composer would be a second way to change state the Session Host already owns and can disagree
     * with — a `/model` there would move the backend without the host, the picker, or the transcript
     * ever hearing about it.
     */
    it("offers Skills and none of the backend's own controls", async () => {
      const { session, dispose } = await start(target);
      try {
        if (!session.skills) return;
        const skills = await session.skills();

        for (const skill of skills) {
          assert.ok(skill.name.length > 0, "a Skill with no name cannot be typed");
          assert.ok(!skill.name.startsWith("/"), "the name is the name, not the keystroke that finds it");
        }
        const offered = new Set(skills.map((skill) => skill.name));
        for (const control of ["model", "clear", "compact", "config", "effort", "rename"]) {
          assert.ok(!offered.has(control), `${control} is the backend's own control, not a Skill`);
        }
      } finally {
        await dispose();
      }
    });

    it("attributes every producer to a Subagent it declared", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (!session.capabilities.subagents) return;
        await target.runTurn(session, "Reply with exactly: ok");

        const declared = new Set(
          events.filter((event) => event.type === "subagent").map((event) => event.subagentId),
        );
        const attributed = events
          .map((event) => ("producer" in event ? event.producer?.subagentId : undefined))
          .filter((id): id is string => id !== undefined);
        for (const id of attributed) {
          assert.ok(declared.has(id), `event attributed to ${id}, which no subagent event declared`);
        }
      } finally {
        await dispose();
      }
    });

    /**
     * The same three assertions for Background Calls (ADR 0021), and deliberately **ungated**.
     *
     * `capabilities.subagents` exists so a client can hide an affordance — the Subagents surface —
     * rather than show an empty tree. A Background Call has no affordance behind it: it is a
     * transcript row, so an adapter that emits none simply shows none, the shape `notice` already
     * has. These therefore pass vacuously for such an adapter rather than skipping.
     *
     * What the first rules out is sharper than for a Subagent: the card is the *only* thing on
     * screen claiming this work is in flight, and the Composer's strip counts the same events — so
     * an unpaired Call leaves a session permanently reporting work that finished.
     */
    it("pairs every Background Call with a terminal snapshot", async () => {
      const { session, events, dispose } = await start(target);
      try {
        await target.runTurn(session, "Reply with exactly: ok");

        const terminal = new Set(["complete", "aborted", "error"]);
        const open = new Set<string>();
        for (const event of events) {
          if (event.type !== "background_call") continue;
          if (terminal.has(event.state)) open.delete(event.callId);
          else open.add(event.callId);
        }
        assert.deepEqual([...open], [], "a Background Call was left running with nothing to close it");
      } finally {
        await dispose();
      }
    });

    it("gives a Background Call the id of the tool call that was backgrounded", async () => {
      const { session, events, dispose } = await start(target);
      try {
        await target.runTurn(session, "Reply with exactly: ok");

        const calls = new Set(events.filter((event) => event.type === "tool_started").map((event) => event.callId));
        for (const event of events) {
          if (event.type !== "background_call") continue;
          // What puts the card under its own tool row. A fresh id would scatter the two.
          assert.ok(calls.has(event.callId), `background call ${event.callId} shares no id with any tool call`);
          assert.notEqual(event.tool, "", "a client always needs something to print");
        }
      } finally {
        await dispose();
      }
    });

    it("gives a Subagent the id of the tool call that spawned it", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (!session.capabilities.subagents) return;
        await target.runTurn(session, "Reply with exactly: ok");

        const calls = new Set(events.filter((event) => event.type === "tool_started").map((event) => event.callId));
        for (const event of events) {
          if (event.type !== "subagent") continue;
          assert.ok(
            calls.has(event.subagentId),
            `subagent ${event.subagentId} shares no id with any tool call (ADR 0015)`,
          );
        }
      } finally {
        await dispose();
      }
    });

    it("names a Subagent on every snapshot, so a client always has something to print", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (!session.capabilities.subagents) return;
        await target.runTurn(session, "Reply with exactly: ok");

        for (const event of events) {
          if (event.type !== "subagent") continue;
          assert.ok(event.name.length > 0, "a snapshot is the whole state, so it always carries a name");
        }
      } finally {
        await dispose();
      }
    });

    it("reports no Subagent unless it declared the capability", async () => {
      const { session, events, dispose } = await start(target);
      try {
        if (session.capabilities.subagents) return;
        await target.runTurn(session, "Reply with exactly: ok");

        const seen = events.filter((event) => event.type === "subagent");
        assert.deepEqual(seen, [], "an adapter that says it cannot report Subagents must not");
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

async function start(target: ConformanceTarget, tools?: "none"): Promise<{
  session: BackendSession;
  events: BackendEvent[];
  dispose: () => Promise<void>;
}> {
  const events: BackendEvent[] = [];
  const session = await target.createSession((event) => events.push(event), tools);
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

/** The first event matching `match`, or undefined if none arrives before the deadline. */
async function waitFor(
  events: BackendEvent[],
  match: (event: BackendEvent) => boolean,
  timeoutMs: number,
): Promise<BackendEvent | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = events.find(match);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return events.find(match);
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
