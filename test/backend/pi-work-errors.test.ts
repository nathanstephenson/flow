import assert from "node:assert/strict";
import { it } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate, piFixture, until, userText } from "./pi-fixture.ts";

it("holds completions outside a manual compaction and delivers them afterwards", { timeout: 15_000 }, async (t) => {
  const child = gate();
  const compaction = gate();
  let summarising = false;
  const fixture = await piFixture(t, async (request) => {
    if (userText(request) === "Child") { await child.promise; return { text: "Child result after summary started" }; }
    if (!request.tools?.length) {
      summarising = true;
      await compaction.promise;
      return { text: "## Summary\nA Subagent was launched." };
    }
    if (userText(request) === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [{
      id: "spawn-1", name: "subagent", arguments: { prompt: "Child", description: "Independent work" },
    }] };
    return { text: "Parent response" };
  });
  t.after(() => { child.release(); compaction.release(); });
  const session = await fixture.create();
  await session.prompt("Launch");
  await session.compact?.("Keep decisions");
  await until(() => summarising);
  child.release();
  await until(() => fixture.events.some((event) => event.type === "subagent" && event.state === "complete"));
  assert.equal(fixture.events.filter((event) => event.type === "turn_started").length, 2);
  assert.equal(fixture.events.filter((event) => event.type === "turn_ended").length, 1);
  compaction.release();
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 3);
  assert.equal(fixture.events.filter((event) => event.type === "compacted").length, 1);
  assert.ok(JSON.stringify(fixture.requests.at(-1)?.messages).includes("Child result after summary started"));
});

it("does not label a later background completion aborted after an idle abort", { timeout: 15_000 }, async (t) => {
  const child = gate();
  const fixture = await piFixture(t, async (request) => {
    if (userText(request) === "Child") { await child.promise; return { text: "Child completed" }; }
    if (userText(request) === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [{
      id: "spawn-1", name: "subagent", arguments: { prompt: "Child", description: "Independent work" },
    }] };
    return { text: "Parent response" };
  });
  t.after(() => child.release());
  const session = await fixture.create();
  await session.prompt("Launch");
  await session.abort();
  child.release();
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 2);
  assert.deepEqual(fixture.events.filter((event) => event.type === "turn_ended").map((event) => event.reason), ["complete", "complete"]);
});

for (const background of [false, true]) {
  it(`reports a ${background ? "background" : "foreground"} Subagent provider failure without leaving work open`, { timeout: 15_000 }, async (t) => {
    const fixture = await piFixture(t, (request) => {
      if (userText(request) === "Child") return { error: "Child provider refused" };
      if (userText(request) === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [{
        id: "spawn-1", name: "subagent", arguments: { prompt: "Child", description: "Independent work", run_in_background: background },
      }] };
      return { text: "Failure received" };
    });
    const session = await fixture.create();
    await session.prompt("Launch");
    await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === (background ? 2 : 1));
    assert.deepEqual(fixture.events.filter((event) => event.type === "subagent").map((event) => event.state), ["running", "error"]);
    assert.ok(JSON.stringify(fixture.requests.at(-1)?.messages).includes("Child provider refused"));
    if (!background) {
      const tool = fixture.events.find((event) => event.type === "tool_ended" && event.callId === "spawn-1");
      assert.ok(tool?.type === "tool_ended" && tool.isError);
    }
  });
}

it("refuses unknown Subagent models without making an inference request for them", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => request.messages.at(-1)?.role === "user" ? { tools: [{
    id: "spawn-1", name: "subagent", arguments: { prompt: "Child", description: "Independent work", model: "missing/model", run_in_background: false },
  }] } : { text: "Failure received" });
  const session = await fixture.create();
  await session.prompt("Launch");
  assert.equal(fixture.requests.length, 2);
  assert.deepEqual(fixture.events.filter((event) => event.type === "subagent").map((event) => event.state), ["running", "error"]);
  assert.ok(JSON.stringify(fixture.requests.at(-1)?.messages).includes("Unknown model"));
});

it("aborts foreground Subagents without cancelling independent background Subagents", { timeout: 15_000 }, async (t) => {
  const foreground = gate();
  const background = gate();
  const fixture = await piFixture(t, async (request) => {
    const text = userText(request);
    if (text === "Foreground" || text === "Background") {
      await (text === "Foreground" ? foreground : background).promise;
      return { text: `${text} result` };
    }
    if (text === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [false, true].map((detached) => ({
      id: detached ? "background" : "foreground", name: "subagent", arguments: {
        prompt: detached ? "Background" : "Foreground", description: "Independent work", run_in_background: detached,
      },
    })) };
    return { text: "Parent response" };
  });
  t.after(() => { foreground.release(); background.release(); });
  const session = await fixture.create();
  const turn = session.prompt("Launch");
  await until(() => fixture.requests.some((request) => userText(request) === "Foreground") && fixture.requests.some((request) => userText(request) === "Background"));
  await session.abort();
  await turn;
  assert.ok(fixture.events.some((event) => event.type === "subagent" && event.subagentId === "foreground" && event.state === "aborted"));
  assert.equal(fixture.events.some((event) => event.type === "subagent" && event.subagentId === "background" && event.state !== "running"), false);
  background.release();
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 2);
  assert.deepEqual(fixture.events.filter((event) => event.type === "turn_ended").map((event) => event.reason), ["aborted", "complete"]);
});

it("ends a foreground Subagent's Background Calls when that Subagent returns", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (userText(request) === "Child") {
      if (request.messages.at(-1)?.role === "user") return { tools: [{ id: "bash-1", name: "bash", arguments: {
        command: "while :; do sleep 1; done", run_in_background: true,
      } }] };
      return { text: "Child finished" };
    }
    if (userText(request) === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [{
      id: "spawn-1", name: "subagent", arguments: { prompt: "Child", description: "Independent work", run_in_background: false },
    }] };
    return { text: "Parent response" };
  });
  const session = await fixture.create();
  await session.prompt("Launch");
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 2);
  assert.deepEqual(fixture.events.filter((event) => event.type === "background_call").map((event) => event.state), ["running", "aborted"]);
  assert.ok(fixture.events.findIndex((event) => event.type === "background_call" && event.state === "aborted")
    < fixture.events.findIndex((event) => event.type === "subagent" && event.state === "complete"));
});

it("reports a failed Background Call separately from its successful launch", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (userText(request) === "Launch" && request.messages.at(-1)?.role === "user") return { tools: [{
      id: "bash-1", name: "bash", arguments: { command: "printf failure; exit 9", run_in_background: true },
    }] };
    return { text: "Parent response" };
  });
  const session = await fixture.create();
  await session.prompt("Launch");
  await until(() => fixture.events.filter((event) => event.type === "turn_ended").length === 2);
  const launch = fixture.events.find((event) => event.type === "tool_ended" && event.callId === "bash-1");
  assert.ok(launch?.type === "tool_ended" && !launch.isError);
  assert.deepEqual(fixture.events.filter((event) => event.type === "background_call").map((event) => event.state), ["running", "error"]);
  assert.ok(JSON.stringify(fixture.requests.at(-1)?.messages).includes("failure"));
});

it("disables Subagents and background execution for Summary Model calls", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, (request) => request.messages.at(-1)?.role === "user" ? { tools: [
    { id: "spawn-1", name: "subagent", arguments: { prompt: "Child", description: "Independent work" } },
    { id: "bash-1", name: "bash", arguments: { command: "printf forbidden", run_in_background: true } },
  ] } : { text: "No tools" });
  const session = await fixture.create({ tools: "none" });
  assert.equal(session.capabilities.subagents, false);
  await session.prompt("Launch");
  assert.equal(fixture.events.some((event) => event.type === "subagent" || event.type === "background_call"), false);
  assert.equal(fixture.requests[0]?.tools?.length ?? 0, 0);
  assert.deepEqual(fixture.events.filter((event) => event.type === "tool_ended").map((event) => event.isError), [true, true]);
});

it("reports a Subagent waiting on its Provider and running again when tools resume", { timeout: 15_000 }, async (t) => {
  let attempts = 0;
  const fixture = await piFixture(t, (request) => {
    if (request.model === "child") {
      if (++attempts === 1) return { error: "overloaded", status: 529 };
      if (attempts === 2) return { tools: [{ id: "read-1", name: "read", arguments: { path: "source" } }] };
      return { text: "Recovered" };
    }
    if (request.messages.at(-1)?.role === "user") return { tools: [{ id: "spawn-1", name: "subagent", arguments: {
      prompt: "Child", description: "Independent work", model: "flow-test/child", run_in_background: false,
    } }] };
    return { text: "Parent response" };
  });
  writeFileSync(join(fixture.scope, "source"), "Source content");
  writeFileSync(join(fixture.scope, "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 5, provider: { maxRetries: 0 } }, compaction: { enabled: false },
  }));
  const session = await fixture.create();
  await session.prompt("Launch");
  assert.deepEqual(fixture.events.filter((event) => event.type === "subagent").map((event) => event.state),
    ["running", "waiting", "running", "complete"]);
  const resumed = fixture.events.findIndex((event, index) => index > 0 && event.type === "subagent" && event.state === "running"
    && fixture.events.slice(0, index).some((prior) => prior.type === "subagent" && prior.state === "waiting"));
  const tool = fixture.events.findIndex((event) => event.type === "tool_started" && event.producer);
  assert.ok(resumed <= tool && resumed >= 0);
  assert.equal(fixture.events.filter((event) => event.type === "turn_ended").length, 1);
});

it("ends an aborted retry wait as aborted rather than complete", { timeout: 15_000 }, async (t) => {
  const fixture = await piFixture(t, () => ({ error: "overloaded", status: 529 }));
  writeFileSync(join(fixture.scope, "settings.json"), JSON.stringify({
    retry: { enabled: true, maxRetries: 1, baseDelayMs: 1000, provider: { maxRetries: 0 } }, compaction: { enabled: false },
  }));
  const session = await fixture.create();
  const turn = session.prompt("Work");
  await until(() => fixture.events.some((event) => event.type === "notice" && event.level === "warn"));
  await session.abort();
  await turn;
  assert.deepEqual(fixture.events.filter((event) => event.type === "turn_ended").map((event) => event.reason), ["aborted"]);
});
