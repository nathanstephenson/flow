import assert from "node:assert/strict";
import { it } from "node:test";
import type { ReadOnlyScope } from "../../src/backend/types.ts";
import { piFixture, userText } from "./pi-fixture.ts";

for (const [readOnly, denied, kept] of [
  [undefined, [], ["read", "edit", "write", "bash"]],
  ["mounted", ["edit", "write"], ["read", "bash", "subagent"]],
  ["tools", ["edit", "write", "bash", "bash_output", "kill_shell"], ["read", "subagent"]],
] as [ReadOnlyScope | undefined, string[], string[]][]) {
  it(`offers ${readOnly ?? "writable"} Scope tools to the session and its Subagents`, { timeout: 15_000 }, async (t) => {
    const fixture = await piFixture(t, (request) => {
      if (userText(request) === "Child") return { text: "Child result" };
      if (request.messages.at(-1)?.role === "user") return { tools: [{
        id: "spawn-1", name: "subagent", arguments: { description: "Look", prompt: "Child", run_in_background: false },
      }] };
      return { text: "Done" };
    });
    const session = await fixture.create(readOnly ? { readOnly } : {});
    await session.prompt("Parent");
    const parent = fixture.requests[0]!.tools!.map((tool) => tool.function.name);
    const child = fixture.requests.find((request) => userText(request) === "Child")!.tools!.map((tool) => tool.function.name);
    for (const tool of denied) assert.equal(parent.includes(tool) || child.includes(tool), false, tool);
    for (const tool of kept) assert.ok(parent.includes(tool), tool);
    for (const tool of kept.filter((tool) => tool !== "subagent")) assert.ok(child.includes(tool), tool);
  });
}
