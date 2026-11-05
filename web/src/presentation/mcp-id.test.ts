import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mcpConnectionsSchema } from "../../../src/protocol/mcp.ts";
import { connectionId } from "./mcp-id.ts";

describe("connectionId", () => {
  it("slugs the name", () => {
    assert.equal(connectionId("  My GitHub (work)! ", []), "my-github-work");
  });

  it("caps the id at 20 characters", () => {
    assert.equal(connectionId("Linear Issue Tracker Production", []), "linear-issue-tracker");
    assert.equal(connectionId("abcdefghijklmnopqrs tuv", []), "abcdefghijklmnopqrs");
  });

  it("falls back to mcp for names with no letters or digits", () => {
    assert.equal(connectionId("", []), "mcp");
    assert.equal(connectionId("!!! ???", []), "mcp");
  });

  it("avoids the reserved workflow id", () => {
    assert.equal(connectionId("Workflow", []), "workflow-2");
  });

  it("adds a suffix on collision and stays within 20 characters", () => {
    assert.equal(connectionId("GitHub", ["github"]), "github-2");
    assert.equal(connectionId("GitHub", ["github", "github-2"]), "github-3");
    assert.equal(
      connectionId("Linear Issue Tracker", ["linear-issue-tracker"]),
      "linear-issue-track-2",
    );
  });

  it("passes the connection schema", () => {
    const ids: string[] = [];
    for (const name of ["Workflow", "GitHub", "GitHub", "?", "?", "Linear Issue Tracker Production"]) {
      ids.push(connectionId(name, ids));
    }
    const result = mcpConnectionsSchema.safeParse(
      ids.map((id) => ({ id, name: id, transport: "stdio", command: "x" })),
    );
    assert.ok(result.success);
  });
});
