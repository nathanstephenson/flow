import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "node:test";
import { SessionHost } from "../../src/daemon/host.ts";
import { gate, piFixture, until, userText } from "./pi-fixture.ts";

it("delivers a background completion after the current turn and queued human messages", { timeout: 15_000 }, async (t) => {
  const child = gate();
  const working = gate();
  const fixture = await piFixture(t, async (request) => {
    const text = userText(request);
    if (text === "Child") { await child.promise; return { text: "Child completed" }; }
    if (text === "Working") { await working.promise; return { text: "Work completed" }; }
    if (text === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [{
      id: "spawn-1", name: "subagent", arguments: { description: "Independent work", prompt: "Child" },
    }] };
    return { text: "Parent response" };
  });
  t.after(() => { child.release(); working.release(); });
  const host = new SessionHost();
  host.registerBackend({ name: "pi", create: fixture.create });
  const id = await host.create({ scope: fixture.scope, backend: "pi", modelId: "flow-test/parent" });
  const events = () => host.logFor(id).since(0).map((entry) => entry.event);
  await host.send(id, "Launch", "now");
  assert.equal(host.list()[0]?.status, "idle");
  assert.equal(host.list()[0]?.activeSubagents, 1);
  const sending = host.send(id, "Working", "now");
  await until(() => fixture.requests.some((request) => userText(request) === "Working"));
  await host.send(id, "Queued", "after_turn");
  child.release();
  await until(() => events().some((event) => event.type === "subagent" && event.state === "complete"));
  assert.equal(events().filter((event) => event.type === "turn_ended").length, 1);
  working.release();
  await sending;
  await until(() => events().filter((event) => event.type === "turn_ended").length === 4);
  const prompts = fixture.requests.map(userText);
  assert.ok(prompts.indexOf("Queued") > prompts.indexOf("Working"));
  assert.ok(prompts.findIndex((text) => text.includes("Child completed") && text !== "Child") > prompts.indexOf("Queued"));
  let open: string | undefined;
  for (const event of events()) {
    if (event.type === "turn_started") { assert.equal(open, undefined); open = event.turnId; }
    if (event.type === "turn_ended") { assert.equal(event.turnId, open); open = undefined; }
  }
  assert.equal(open, undefined);
  await host.shutdown();
});

it("keeps a background Subagent's Background Call attributed after the Subagent finishes", { timeout: 15_000 }, async (t) => {
  const child = gate();
  const fixture = await piFixture(t, async (request) => {
    if (userText(request) === "Child") {
      if (request.messages.at(-1)?.role === "user") {
        await child.promise;
        return { tools: [{ id: "bash-1", name: "bash", arguments: {
          command: "while [ ! -f release ]; do sleep 0.01; done; printf child-output", timeout: 5, run_in_background: true,
        } }] };
      }
      return { text: "Child launched a command" };
    }
    if (userText(request) === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [{
      id: "spawn-1", name: "subagent", arguments: { description: "Launch a command", prompt: "Child" },
    }] };
    return { text: "Parent response" };
  });
  t.after(() => child.release());
  const session = await fixture.create();
  await session.prompt("Launch");
  child.release();
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 2);
  const running = fixture.events.find((event) => event.type === "background_call");
  assert.deepEqual(running, { type: "background_call", callId: "spawn-1/bash-1", tool: "bash", producer: { subagentId: "spawn-1" }, state: "running" });
  writeFileSync(join(fixture.scope, "release"), "");
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 3);
  assert.deepEqual(fixture.events.filter((event) => event.type === "background_call"), [running, { ...running, state: "complete" }]);
  assert.ok(JSON.stringify(fixture.requests.at(-1)?.messages).includes("child-output"));
});

it("reads and stops a Background Call through tools without duplicating its terminal event", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (request.messages.at(-1)?.role === "user") {
      if (userText(request) === "Launch") return { tools: [{ id: "bash-1", name: "bash", arguments: {
        command: "printf started; printf $$ > call.pid; while :; do sleep 1; done", run_in_background: true,
      } }] };
      if (userText(request) === "Read") return { tools: [{ id: "read-1", name: "bash_output", arguments: { call_id: "bash-1" } }] };
      if (userText(request) === "Stop") return { tools: [{ id: "stop-1", name: "kill_shell", arguments: { call_id: "bash-1" } }] };
    }
    return { text: "Parent response" };
  });
  const session = await fixture.create();
  await session.prompt("Launch");
  await until(() => existsSync(join(fixture.scope, "call.pid")));
  const pid = Number(readFileSync(join(fixture.scope, "call.pid"), "utf8"));
  await session.prompt("Read");
  const read = fixture.events.find((event) => event.type === "tool_ended" && event.callId === "read-1");
  assert.ok(read?.type === "tool_ended" && !read.isError);
  assert.match(JSON.stringify(read.result), /running/);
  await session.prompt("Stop");
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 4);
  assert.deepEqual(fixture.events.filter((event) => event.type === "background_call").map((event) => event.state), ["running", "aborted"]);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

it("does not start inference when disposal races prompt preflight", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ text: "Must not run" }));
  const session = await fixture.create();
  const turn = session.prompt("Late prompt");
  await session.dispose();
  await turn;
  assert.equal(fixture.requests.length, 0);
});

it("disposes background Subagents and process trees without starting a completion turn", { timeout: 15_000 }, async (t) => {
  const child = gate();
  const fixture = await piFixture(t, async (request) => {
    if (userText(request) === "Child") { await child.promise; return { text: "Late child result" }; }
    if (userText(request) === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [
      { id: "spawn-1", name: "subagent", arguments: { description: "Background work", prompt: "Child" } },
      { id: "bash-1", name: "bash", arguments: { command: "printf $$ > call.pid; while :; do sleep 1; done", run_in_background: true } },
    ] };
    return { text: "Launched" };
  });
  t.after(() => child.release());
  const session = await fixture.create();
  await session.prompt("Launch");
  await until(() => existsSync(join(fixture.scope, "call.pid")) && fixture.requests.some((request) => userText(request) === "Child"));
  const pid = Number(readFileSync(join(fixture.scope, "call.pid"), "utf8"));
  await session.dispose();
  child.release();
  assert.deepEqual(fixture.events.filter((event) => event.type === "subagent").map((event) => event.state), ["running", "aborted"]);
  assert.deepEqual(fixture.events.filter((event) => event.type === "background_call").map((event) => event.state), ["running", "aborted"]);
  assert.equal(fixture.events.filter((event) => event.type === "turn_started").length, 1);
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});
