import assert from "node:assert/strict";
import { it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { piFixture, until } from "./pi-fixture.ts";

it("Pi Ask intercepts the SDK's tool execution and refuses or allows without machine-wide grants", { timeout: 15000 }, async (t) => {
  let call = 0;
  const fixture = await piFixture(t, () => (++call === 1
    ? { tools: [{ id: "write-1", name: "write", arguments: { path: "permission-check.txt", content: "allowed" } }] }
    : { text: "done" }));
  const session = await fixture.create({ permissionMode: "ask" });
  const first = session.prompt("write file");
  await until(() => fixture.events.some((event) => event.type === "permission" && event.state === "asked"));
  assert.equal(existsSync(join(fixture.scope, "permission-check.txt")), false);
  assert.equal(await session.answerPermission?.("write-1", "deny"), true);
  await first;
  assert.equal(existsSync(join(fixture.scope, "permission-check.txt")), false);

  const next = await piFixture(t, (_request) => next.requests.length === 1
    ? { tools: [{ id: "write-2", name: "write", arguments: { path: "permission-check.txt", content: "allowed" } }] }
    : { text: "done" });
  const permitted = await next.create({ permissionMode: "ask" });
  const second = permitted.prompt("write file");
  await until(() => next.events.some((event) => event.type === "permission" && event.state === "asked"));
  assert.equal(await permitted.answerPermission?.("write-2", "allow"), true);
  await second;
  assert.equal(readFileSync(join(next.scope, "permission-check.txt"), "utf8"), "allowed");
});

it("Pi Always and Standing Authorisations run without prompting; live Ask applies to the next call", { timeout: 15000 }, async (t) => {
  const fixture = await piFixture(t, () => fixture.requests.length % 2 === 0
    ? { text: "done" }
    : { tools: [{ id: `write-${fixture.requests.length}`, name: "write", arguments: { path: `file-${fixture.requests.length}.txt`, content: "done" } }] });
  const session = await fixture.create({ permissionMode: "always" });
  await session.prompt("write");
  assert.equal(fixture.events.filter((event) => event.type === "permission").length, 0);
  assert.ok(existsSync(join(fixture.scope, "file-1.txt")));
  await session.setPermissionMode?.("ask");
  const second = session.prompt("write again");
  await until(() => fixture.events.some((event) => event.type === "permission" && event.state === "asked"));
  assert.ok(fixture.events.some((event) => event.type === "permission" && event.state === "asked"));
  await session.abort();
  await second;
  assert.equal(fixture.events.filter((event) => event.type === "permission" && event.state === "aborted").length, 1);
  const standing = await piFixture(t, (request) => request.messages.some((message) => message.role === "tool")
    ? { text: "done" }
    : { tools: [{ id: "standing-write", name: "write", arguments: { path: "standing.txt", content: "ok" } }] });
  const granted = await standing.create({ permissionMode: "ask", standingAuthorisations: ["write"] });
  await granted.prompt("write");
  assert.equal(standing.events.filter((event) => event.type === "permission").length, 0);
  assert.ok(existsSync(join(standing.scope, "standing.txt")));
});

it("background Subagent prompts remain answerable from the parent after its turn", { timeout: 15000 }, async (t) => {
  const fixture = await piFixture(t, (request) => {
    if (request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Write child"))) return request.messages.some((message) => message.tool_call_id === "child-write")
      ? { text: "child done" } : { tools: [{ id: "child-write", name: "write", arguments: { path: "child.txt", content: "child" } }] };
    return fixture.requests.filter((entry) => entry.model === "parent").length === 1
      ? { tools: [{ id: "agent-call", name: "subagent", arguments: { name: "Writer", description: "Write child", prompt: "Write child", run_in_background: true } }] }
      : { text: "parent done" };
  });
  const session = await fixture.create({ permissionMode: "ask" });
  await session.prompt("delegate");
  await until(() => fixture.events.some((event) => event.type === "permission" && event.state === "asked" && !!event.producer));
  const prompt = fixture.events.find((event) => event.type === "permission" && event.state === "asked" && event.producer);
  assert.ok(prompt?.type === "permission" && prompt.producer?.subagentId === "agent-call");
  assert.equal(existsSync(join(fixture.scope, "child.txt")), false);
  assert.equal(await session.answerPermission?.(prompt.callId, "allow"), true);
  await until(() => existsSync(join(fixture.scope, "child.txt")));
});

it("aborting a Subagent with an open Ask prompt denies the call and releases its callback", { timeout: 15000 }, async (t) => {
  const fixture = await piFixture(t, (request) => request.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Write child"))
    ? { tools: [{ id: "child-write", name: "write", arguments: { path: "aborted-child.txt", content: "no" } }] }
    : fixture.requests.length === 1
      ? { tools: [{ id: "agent-call", name: "subagent", arguments: { name: "Writer", description: "Write child", prompt: "Write child", run_in_background: true } }] }
      : { text: "parent done" });
  const session = await fixture.create({ permissionMode: "ask" });
  await session.prompt("delegate");
  await until(() => fixture.events.some((event) => event.type === "permission" && event.state === "asked" && !!event.producer));
  await session.dispose();
  assert.ok(fixture.events.some((event) => event.type === "permission" && event.state === "aborted" && !!event.producer));
  assert.equal(existsSync(join(fixture.scope, "aborted-child.txt")), false);
});
