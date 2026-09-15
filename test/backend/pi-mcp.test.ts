import { it } from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { McpSession } from "../../src/backend/mcp.ts";
import type { WorkflowSubagentOptions } from "../../src/backend/types.ts";
import { piFixture, until, userText } from "./pi-fixture.ts";

it(
  "Pi parent, Subagents, and Workflow Steps inherit MCP tools and workflow permission rules",
  { timeout: 15_000 },
  async (t) => {
    const fixture = await piFixture(t, (request) => {
      if (request.messages.at(-1)?.role !== "user")
        return { text: '{"ok":true}' };
      assert.ok(
        request.tools?.some(
          (tool) => tool.function.name === "mcp__fixture__echo",
        ),
      );
      if (userText(request) === "delegate")
        return {
          tools: [
            {
              id: "delegate",
              name: "subagent",
              arguments: {
                name: "Child",
                description: "Check MCP",
                prompt: "Use MCP",
                run_in_background: false,
              },
            },
          ],
        };
      return {
        tools: [
          {
            id: "echo-call",
            name: "mcp__fixture__echo",
            arguments: { text: "MCP reached" },
          },
        ],
      };
    });
    const mcp = new McpSession(
      [
        {
          id: "fixture",
          name: "Fixture",
          enabledByDefault: true,
          transport: "stdio",
          command: process.execPath,
          args: [
            "--experimental-strip-types",
            resolve("test/fixtures/mcp-server.ts"),
          ],
        },
      ],
      fixture.scope,
    );
    t.after(() => mcp.dispose());
    const session = await fixture.create({ mcp });
    await mcp.open();
    await session.refreshMcp!();
    await session.prompt("Use MCP");
    assert.ok(
      fixture.events.some(
        (event) => event.type === "tool_ended" && event.callId === "echo-call",
      ),
    );
    await session.prompt("delegate");
    assert.ok(
      fixture.events.some(
        (event) =>
          event.type === "tool_started" &&
          event.name === "mcp__fixture__echo" &&
          event.producer?.subagentId,
      ),
    );
    const activity: Parameters<WorkflowSubagentOptions["emit"]>[0][] = [];
    const handle = session.startWorkflowSubagent!({
      id: "workflow",
      name: "Workflow",
      instructions: "Check MCP",
      input: {},
      modelId: "flow-test/child",
      effort: "high",
      permissionMode: "ask",
      emit: (event) => activity.push(event),
    });
    await until(() =>
      activity.some(
        (entry) =>
          entry.event.type === "permission" && entry.event.state === "asked",
      ),
    );
    assert.equal(await handle.answerPermission("echo-call", "allow"), true);
    assert.equal(await handle.done, '{"ok":true}');
  },
);
