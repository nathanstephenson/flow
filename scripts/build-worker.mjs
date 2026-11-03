import { build } from 'esbuild';
import { mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const out = resolve(root, 'build');
const temporary = join(out, `.backend-worker-${process.pid}`);
await build({ entryPoints: { 'backend-worker': resolve(root, 'src/backend/worker/entry.ts') }, outdir: temporary, chunkNames: 'backend-worker-chunks/[name]-[hash]',
  outExtension: { '.js': '.mjs' }, platform: 'node', target: 'node22', format: 'esm', bundle: true, splitting: true, external: ['@earendil-works/*'],
  banner: { js: `import { createRequire as __flowCreateRequire } from 'node:module'; const require = __flowCreateRequire(import.meta.url);` } });
const chunks = join(out, 'backend-worker-chunks');
const fresh = readdirSync(join(temporary, 'backend-worker-chunks'));
mkdirSync(chunks, { recursive: true });
for (const name of fresh) renameSync(join(temporary, 'backend-worker-chunks', name), join(chunks, name));
renameSync(join(temporary, 'backend-worker.mjs'), join(out, 'backend-worker.mjs'));
for (const name of readdirSync(chunks)) if (!fresh.includes(name)) rmSync(join(chunks, name));
rmSync(temporary, { recursive: true });
console.log(join(out, 'backend-worker.mjs'));
