import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { ClaudeBackend } from "../../src/backend/claude/index.ts";
import { until } from "./pi-fixture.ts";

it("Claude passes startup overrides through the SDK and keeps them on a live model change", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "flow-claude-auto-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, "environment.json");
  const executable = join(root, "cli.js");
  writeFileSync(executable, `
const fs = require("node:fs");
const readline = require("node:readline");
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  disabled: process.env.DISABLE_AUTO_COMPACT,
  percent: process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE,
  args: process.argv,
}));
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type !== "control_request") return;
  process.stdout.write(JSON.stringify({ type: "control_response", response: {
    subtype: "success", request_id: request.request_id,
    response: { models: [{ value: "opus", displayName: "Opus", description: "" }] },
  } }) + "\\n");
});
`);
  const backend = new ClaudeBackend({ pathToClaudeCodeExecutable: executable, allowedTools: [] });
  const session = await backend.create({ scope: root, modelId: "opus", emit: () => {}, autoCompaction: {
    opus: { mode: "enabled", targetPercent: 80 }, sonnet: { mode: "disabled" },
  } });
  t.after(() => session.dispose());
  await until(() => { try { return Boolean(readFileSync(output)); } catch { return false; } });
  const opened = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(opened.disabled, "0");
  assert.equal(opened.percent, "80");
  assert.equal(session.capabilities.autoCompaction, "startup");
  await session.setModel("sonnet");
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), opened);
  await session.dispose();
  rmSync(output);
  const revived = await backend.create({ scope: root, modelId: "sonnet", resume: "previous-backend-session", emit: () => {}, autoCompaction: {
    sonnet: { mode: "disabled" },
  } });
  t.after(() => revived.dispose());
  await until(() => { try { return Boolean(readFileSync(output)); } catch { return false; } });
  const restarted = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(restarted.disabled, "1");
  assert.equal(restarted.percent, undefined);
  assert.ok(restarted.args.includes("--resume=previous-backend-session"));
  await revived.dispose();
  rmSync(output);
  const reset = await backend.create({ scope: root, modelId: "sonnet", emit: () => {}, autoCompaction: {} });
  t.after(() => reset.dispose());
  await until(() => { try { return Boolean(readFileSync(output)); } catch { return false; } });
  const defaults = JSON.parse(readFileSync(output, "utf8"));
  assert.equal(defaults.disabled, process.env.DISABLE_AUTO_COMPACT);
  assert.equal(defaults.percent, process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE);
});
