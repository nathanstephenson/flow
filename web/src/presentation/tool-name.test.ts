import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toolLabel } from "./tool-name.ts";

const connections = [
  { id: "github", name: "GitHub" },
  { id: "my_db", name: "Database" },
  { id: "my_db__ro", name: "Database (read only)" },
];

describe("toolLabel", () => {
  it("names a known connection", () => {
    assert.deepEqual(toolLabel("mcp__github__create_issue", connections), {
      connection: "GitHub",
      tool: "create_issue",
    });
  });

  it("ignores an unknown connection", () => {
    assert.equal(toolLabel("mcp__gitlab__create_issue", connections), undefined);
  });

  it("matches ids that contain underscores", () => {
    assert.deepEqual(toolLabel("mcp__my_db__query", connections), {
      connection: "Database",
      tool: "query",
    });
  });

  it("uses the longest matching id", () => {
    assert.deepEqual(toolLabel("mcp__my_db__ro__query", connections), {
      connection: "Database (read only)",
      tool: "query",
    });
  });

  it("ignores tools that are not MCP tools", () => {
    assert.equal(toolLabel("Bash", connections), undefined);
    assert.equal(toolLabel("github", connections), undefined);
  });

  it("ignores Flow's built-in workflow tools", () => {
    assert.equal(toolLabel("mcp__flow_workflow__workflow_inspect", connections), undefined);
  });

  it("accepts no connections", () => {
    assert.equal(toolLabel("mcp__github__create_issue", undefined), undefined);
  });
});
