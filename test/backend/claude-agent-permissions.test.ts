import assert from "node:assert/strict";
import { it } from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeBackend, AutoPermissionUnavailable } from "../../src/backend/claude/index.ts";

it("Claude's pinned SDK sends native Auto through its control protocol and reports rejection, not a local substitute", { timeout: 10000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "flow-claude-permission-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "commands.jsonl");
  const executable = join(root, "cli.js");
  writeFileSync(executable, `
const fs = require('node:fs');
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const request = JSON.parse(line);
  if (request.type !== 'control_request') return;
  fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify(request.request) + '\\n');
  const rejected = request.request.subtype === 'set_permission_mode' && process.env.FLOW_REJECT_AUTO === '1';
  process.stdout.write(JSON.stringify({ type: 'control_response', response: {
    subtype: rejected ? 'error' : 'success', request_id: request.request_id,
    ...(rejected ? { error: 'Auto unavailable' } : { response: { models: [{ value: 'opus', displayName: 'Opus', description: '' }] } }),
  } }) + '\\n');
});
`);
  const backend = new ClaudeBackend({ pathToClaudeCodeExecutable: executable, allowedTools: [] });
  const session = await backend.create({ scope: root, emit: () => {}, permissionMode: "auto" });
  const controls = readFileSync(output, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { subtype: string; mode?: string });
  assert.ok(controls.some((command) => command.subtype === "set_permission_mode" && command.mode === "auto"));
  await session.setPermissionMode?.("ask");
  const after = readFileSync(output, "utf8");
  assert.ok(after.includes('"mode":"default"'));
  await session.dispose();
  const previous = process.env.FLOW_REJECT_AUTO;
  process.env.FLOW_REJECT_AUTO = "1";
  try {
    await assert.rejects(backend.create({ scope: root, emit: () => {}, permissionMode: "auto" }), AutoPermissionUnavailable);
  } finally {
    if (previous === undefined) delete process.env.FLOW_REJECT_AUTO; else process.env.FLOW_REJECT_AUTO = previous;
  }
});
