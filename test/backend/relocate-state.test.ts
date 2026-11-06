import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { projectKey, relocateClaudeState } from "../../src/backend/worker/claude-state.ts";
import { relocatePiState } from "../../src/backend/pi/state.ts";

const uuid = "12345678-1234-4567-89ab-123456789abc";

for (const [label, from, to] of [
  ["short", "/home/node/workspace/api", "/Users/me/api"],
  ["long hashed", `/home/node/${"a".repeat(220)}`, `/Users/me/${"b".repeat(220)}`],
] as const) {
  test(`relocateClaudeState moves a ${label} record folder`, () => {
    const stateDir = mkdtempSync(join(tmpdir(), "flow-relocate-"));
    const old = join(stateDir, "claude-projects", projectKey(from));
    mkdirSync(join(old, uuid), { recursive: true });
    writeFileSync(join(old, `${uuid}.jsonl`), "{}\n");

    relocateClaudeState(stateDir, from, to);

    assert.equal(existsSync(old), false);
    assert.equal(readFileSync(join(stateDir, "claude-projects", projectKey(to), `${uuid}.jsonl`), "utf8"), "{}\n");
    assert.equal(existsSync(join(stateDir, "claude-projects", projectKey(to), uuid)), true);
  });
}

test("relocateClaudeState does nothing when there is no record", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "flow-relocate-"));
  relocateClaudeState(stateDir, "/old", "/new");
  assert.equal(existsSync(join(stateDir, "claude-projects", projectKey("/new"))), false);
});

test("relocateClaudeState refuses to replace an existing record folder", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "flow-relocate-"));
  mkdirSync(join(stateDir, "claude-projects", projectKey("/old")), { recursive: true });
  mkdirSync(join(stateDir, "claude-projects", projectKey("/new")), { recursive: true });
  assert.throws(() => relocateClaudeState(stateDir, "/old", "/new"), /already/);
});

test("relocatePiState rewrites the header cwd of sessions in the old Scope only", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "flow-relocate-"));
  const body = `{"type":"message","id":"a","message":{"role":"user","content":"cwd /old"}}\n`;
  const header = (cwd: string) => `${JSON.stringify({ type: "session", version: 3, id: uuid, timestamp: "t", cwd })}\n`;
  writeFileSync(join(stateDir, "one.jsonl"), header("/old") + body);
  writeFileSync(join(stateDir, "two.jsonl"), header("/elsewhere") + body);

  relocatePiState(stateDir, "/old", "/new");

  assert.equal(readFileSync(join(stateDir, "one.jsonl"), "utf8"), header("/new") + body);
  assert.equal(readFileSync(join(stateDir, "two.jsonl"), "utf8"), header("/elsewhere") + body);
});
