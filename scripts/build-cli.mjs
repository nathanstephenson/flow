import { execFileSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
rmSync(resolve(root, 'dist'), { recursive: true, force: true });
execFileSync(process.execPath, [resolve(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
const buildId = randomUUID();
writeFileSync(resolve(root, 'dist/build-id'), buildId);
await build({ entryPoints: [resolve(root, 'src/cli/bootstrap.ts')], outfile: resolve(root, 'dist/cli/bootstrap.js'), bundle: true, platform: 'node', format: 'esm', target: 'node22', define: { FLOW_BUILD_ID: JSON.stringify(buildId) } });
