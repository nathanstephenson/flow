import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate, piFixture, until, userText } from "./pi-fixture.ts";

it("runs a foreground Subagent with isolated context, model/Effort overrides, and attributed output", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (userText(request) === "Child instructions") return { text: "Child result" };
    if (request.messages.at(-1)?.role === "user") return { tools: [{
      id: "spawn-1", name: "subagent", arguments: { name: "Reviewer", description: "Review the change",
        prompt: "Child instructions", model: "flow-test/child", effort: "high", run_in_background: false },
    }] };
    return { text: "Parent result" };
  });
  const session = await fixture.create();
  assert.equal(session.capabilities.subagents, true);
  await session.prompt("Parent private instructions");
  const child = fixture.requests.find((request) => request.model === "child");
  assert.ok(child);
  assert.equal(child.reasoning_effort, "high");
  assert.equal(JSON.stringify(child.messages).includes("Parent private instructions"), false);
  assert.equal(child.tools?.some((tool) => ["subagent", "ask_question"].includes(tool.function.name)), false);
  const states = fixture.events.filter((event) => event.type === "subagent");
  assert.deepEqual(states.map((event) => [event.subagentId, event.state]), [["spawn-1", "running"], ["spawn-1", "complete"]]);
  assert.ok(fixture.events.some((event) => event.type === "message" && event.text === "Child result" && event.producer?.subagentId === "spawn-1"));
  assert.equal(fixture.events.filter((event) => event.type === "turn_started").length, 1);
  assert.equal(fixture.events.filter((event) => event.type === "turn_ended").length, 1);
  assert.ok(JSON.stringify(fixture.requests.at(-1)?.messages).includes("Child result"));
});

it("backgrounds bash, releases the parent turn, and reports completion exactly once", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (request.messages.at(-1)?.role === "user" && userText(request) === "Launch") return { tools: [{
      id: "bash-1", name: "bash", arguments: { command: "while [ ! -f release ]; do sleep 0.01; done; printf finished", timeout: 5, run_in_background: true },
    }] };
    return { text: request.messages.at(-1)?.role === "tool" ? "Launched" : "Finished" };
  });
  const session = await fixture.create();
  await session.prompt("Launch");
  assert.deepEqual(fixture.events.filter((event) => event.type === "background_call").map((event) => event.state), ["running"]);
  assert.equal(fixture.events.filter((event) => event.type === "turn_ended").length, 1);
  const launch = fixture.events.find((event) => event.type === "tool_ended" && event.callId === "bash-1");
  assert.ok(launch?.type === "tool_ended" && !launch.isError);
  writeFileSync(join(fixture.scope, "release"), "");
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 2);
  assert.deepEqual(fixture.events.filter((event) => event.type === "background_call").map((event) => [event.callId, event.state]),
    [["bash-1", "running"], ["bash-1", "complete"]]);
  assert.ok(JSON.stringify(fixture.requests.at(-1)?.messages.at(-1)?.content).includes("finished"));
  assert.equal(fixture.events.filter((event) => event.type === "tool_ended" && event.callId === "bash-1").length, 1);
});

it("defaults to concurrent background Subagents, inherits at launch, and separates repeated child call ids", { timeout: 15_000 }, async (t) => {
  const first = gate();
  const second = gate();
  const fixture = await piFixture(t, async (request) => {
    const text = userText(request);
    if (text === "Child A" || text === "Child B") {
      if (request.messages.at(-1)?.role === "user") return { tools: [{ id: "read-1", name: "read", arguments: { path: "source" } }] };
      await (text === "Child A" ? first : second).promise;
      return { text: `${text} result` };
    }
    if (request.messages.at(-1)?.role === "user" && text === "Launch") return { tools: ["A", "B"].map((name) => ({
      id: `spawn-${name}`, name: "subagent", arguments: { name: "Reviewer", description: `Review ${name}`, prompt: `Child ${name}` },
    })) };
    return { text: "Parent response" };
  });
  t.after(() => { first.release(); second.release(); });
  writeFileSync(join(fixture.scope, "source"), "Source content");
  const session = await fixture.create();
  await session.prompt("Launch");
  await until(() => fixture.events.filter((event) => event.type === "tool_ended" && event.producer).length === 2);
  assert.equal(fixture.events.filter((event) => event.type === "turn_ended").length, 1);
  await session.setModel("flow-test/child");
  await session.setEffort("low");
  for (const request of fixture.requests.filter((request) => userText(request).startsWith("Child "))) {
    assert.equal(request.model, "parent");
    assert.equal(request.reasoning_effort, "medium");
  }
  assert.deepEqual(fixture.events.filter((event) => event.type === "tool_ended").filter((event) => event.producer).map((event) => event.callId).sort(),
    ["spawn-A/read-1", "spawn-B/read-1"]);
  second.release();
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 2);
  first.release();
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 3);
  const messages = fixture.events.filter((event) => event.type === "message").filter((event) => event.producer && event.final);
  assert.equal(new Set(messages.map((event) => event.id)).size, 2);
  assert.deepEqual(fixture.events.filter((event) => event.type === "subagent").filter((event) => event.state === "complete").map((event) => event.subagentId),
    ["spawn-B", "spawn-A"]);
  const turns = fixture.events.filter((event) => event.type === "turn_started");
  assert.equal(new Set(turns.map((event) => event.turnId)).size, 3);
});

it("inherits tool restrictions and refuses nested Subagents and child Enquiries", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (userText(request) === "Child") {
      if (request.messages.at(-1)?.role === "user") return { tools: [
        { id: "nested", name: "subagent", arguments: { prompt: "Nested", description: "Forbidden" } },
        { id: "question", name: "ask_question", arguments: { questions: [] } },
      ] };
      return { text: "Returned to parent" };
    }
    if (request.messages.at(-1)?.role === "user") return { tools: [{ id: "spawn-1", name: "subagent", arguments: {
      prompt: "Child", description: "Independent work", run_in_background: false,
    } }] };
    return { text: "Parent response" };
  });
  writeFileSync(join(fixture.scope, "settings.json"), JSON.stringify({ defaultTools: ["read"], compaction: { enabled: false } }));
  const session = await fixture.create();
  await session.prompt("Launch");
  const child = fixture.requests.find((request) => userText(request) === "Child");
  assert.deepEqual(child?.tools?.map((tool) => tool.function.name), ["read"]);
  assert.equal(fixture.events.some((event) => event.type === "enquiry"), false);
  assert.equal(fixture.events.filter((event) => event.type === "subagent").length, 2);
  const results = fixture.events.filter((event) => event.type === "tool_ended").filter((event) => event.producer);
  assert.deepEqual(results.map((event) => [event.callId, event.isError]), [["spawn-1/nested", true], ["spawn-1/question", true]]);
});
