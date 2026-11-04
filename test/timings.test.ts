import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { recordTiming, trimTimings } from "../src/daemon/timings.ts";

it("appends one line per record and trims a large file to its last lines", (t) => {
  const root = mkdtempSync(join(tmpdir(), "flow-timings-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "timings.jsonl");
  recordTiming(root, { kind: "skills", total: 3 });
  const [line] = readFileSync(file, "utf8").trim().split("\n");
  assert.deepEqual({ ...JSON.parse(line!), at: undefined }, { at: undefined, kind: "skills", total: 3 });

  trimTimings(root);
  assert.equal(readFileSync(file, "utf8").trim().split("\n").length, 1);

  writeFileSync(file, Array.from({ length: 3000 }, (_, index) => JSON.stringify({ index, pad: "x".repeat(400) })).join("\n") + "\n");
  trimTimings(root);
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 2000);
  assert.equal(JSON.parse(lines[0]!).index, 1000);
});
