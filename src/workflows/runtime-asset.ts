import { getAsset, isSea } from 'node:sea';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
let extracted: string | undefined;
export function embeddedWorkflowRuntime(): string {
  if (extracted) return extracted;
  if (!isSea()) throw new Error('Supply runtimePath from build:workflow-runtime for a source installation');
  const bytes = getAsset('workflow-runtime.cjs');
  const directory = mkdtempSync(join(tmpdir(), 'flow-workflow-runtime-'));
  extracted = join(directory, 'runtime.cjs');
  writeFileSync(extracted, Buffer.from(bytes), { mode: 0o400 });
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
  return extracted;
}
