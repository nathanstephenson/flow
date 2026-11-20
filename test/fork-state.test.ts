import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { forkClaudeState, projectKey } from "../src/backend/worker/claude-state.ts";
import { forkPiState, USER_MESSAGE_MAP } from "../src/backend/pi/state.ts";

describe("Fork state copies", () => {
  it("copies a Claude record under the Fork's Scope, without file checkpoints", () => {
    const from = mkdtempSync(join(tmpdir(), "flow-from-")), to = mkdtempSync(join(tmpdir(), "flow-to-"));
    const resume = "0b6c7d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e";
    const source = join(from, "claude-projects", projectKey("/repo"));
    mkdirSync(join(source, resume), { recursive: true });
    writeFileSync(join(source, `${resume}.jsonl`), "{}\n");
    writeFileSync(join(source, resume, "subagent.jsonl"), "{}\n");
    mkdirSync(join(from, "claude-file-history"));

    assert.equal(forkClaudeState({ stateDir: from, scope: "/repo", resume }, { stateDir: to, scope: "/fork" }), resume);

    const destination = join(to, "claude-projects", projectKey("/fork"));
    assert.equal(readFileSync(join(destination, `${resume}.jsonl`), "utf8"), "{}\n");
    assert.ok(existsSync(join(destination, resume, "subagent.jsonl")));
    assert.equal(existsSync(join(to, "claude-file-history")), false);
  });

  it("copies the latest pi session bound to the Fork's Scope, with its user message map", () => {
    const from = mkdtempSync(join(tmpdir(), "flow-from-")), to = mkdtempSync(join(tmpdir(), "flow-to-"));
    writeFileSync(join(from, "a.jsonl"), `${JSON.stringify({ type: "session", cwd: "/repo" })}\n{"type":"message"}\n`);
    writeFileSync(join(from, USER_MESSAGE_MAP), JSON.stringify({ m: "e" }));

    forkPiState(from, to, "/fork");

    const [header, entry] = readFileSync(join(to, "a.jsonl"), "utf8").split("\n");
    assert.equal(JSON.parse(header!).cwd, "/fork");
    assert.equal(entry, '{"type":"message"}');
    assert.deepEqual(JSON.parse(readFileSync(join(to, USER_MESSAGE_MAP), "utf8")), { m: "e" });
  });
});
