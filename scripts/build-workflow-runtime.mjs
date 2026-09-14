import { build } from 'esbuild';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const root = resolve(import.meta.dirname, '..');
const out = process.argv[2] ?? resolve(root, 'build/workflow-runtime.cjs');
mkdirSync(dirname(out), { recursive: true });
const lib = dirname(require.resolve('typescript'));
const libraries = Object.fromEntries(readdirSync(lib).filter(name => /^lib\..*\.d\.ts$/.test(name)).map(name => [name, readFileSync(resolve(lib, name), 'utf8')]));
const wasm = readFileSync(resolve(dirname(require.resolve('@jitl/quickjs-wasmfile-release-sync')), 'emscripten-module.wasm')).toString('base64');
await build({ entryPoints: [resolve(root, 'src/workflows/runtime.ts')], outfile: out, platform: 'node', target: 'node22', format: 'cjs', bundle: true,
  banner: { js: `const __flowMetaUrl = require('node:url').pathToFileURL(__filename).href;` }, define: { 'import.meta.url': '__flowMetaUrl' },
  plugins: [{ name: 'runtime-data', setup(builder) {
    builder.onLoad({ filter: /runtime-libs\.ts$/ }, () => ({ contents: `export const libraries = ${JSON.stringify(libraries)};` }));
    builder.onResolve({ filter: /^quickjs-emscripten$/ }, () => ({ path: 'quickjs', namespace: 'runtime' }));
    builder.onLoad({ filter: /.*/, namespace: 'runtime' }, () => ({ resolveDir: root, contents: `import { newQuickJSWASMModuleFromVariant, newVariant } from 'quickjs-emscripten-core'; import variant from '@jitl/quickjs-wasmfile-release-sync'; export const getQuickJS = () => newQuickJSWASMModuleFromVariant(newVariant(variant, { wasmBinary: Uint8Array.from(Buffer.from('${wasm}', 'base64')).buffer }));` }));
  } }],
});
console.log(out);
