// Run the real Vite UI with a dev-only material layer. Production sources are unchanged.
import { createServer } from 'vite';
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = process.env.MOCKUP_STATE_DIR;
if (!root) throw new Error('Set MOCKUP_STATE_DIR to the isolated dev-host.ts state root.');
const handoff = JSON.parse(await readFile(join(root, 'daemon.json'), 'utf8'));
const { ids } = JSON.parse(await readFile(join(root, 'study.json'), 'utf8'));
const initialLayout = { [ids[0]]: {
  bottom: { tabs: [], size: 240, minimised: true },
  right: { tabs: [{ id: 'study-agents', content: { kind: 'subagents' } }, { id: 'study-git', content: { kind: 'git' } }], activeId: 'study-agents', size: 350, minimised: false },
} };
process.env.FLOW_STATE_DIR = root;
process.env.FLOW_URL = handoff.url;
// This preview uses its isolated local token gate, never the operator's OIDC service.
delete process.env.FLOW_OIDC_ISSUER;
const material = fileURLToPath(new URL('./live-material.js', import.meta.url));
const server = await createServer({
  configFile: fileURLToPath(new URL('../../web/vite.config.ts', import.meta.url)),
  server: { port: Number(process.env.MOCKUP_PORT ?? 5191), host: '127.0.0.1', fs: { allow: [fileURLToPath(new URL('../../', import.meta.url)), await realpath(fileURLToPath(new URL('../../node_modules', import.meta.url)))] } },
  plugins: [{
    name: 'nat-91-dev-material',
    transformIndexHtml() {
      return [
        { tag: 'script', children: `if (!localStorage.getItem('flow.docks')) localStorage.setItem('flow.docks', ${JSON.stringify(JSON.stringify(initialLayout))});`, injectTo: 'head' },
        { tag: 'script', attrs: { type: 'module', src: `/@fs/${material}` }, injectTo: 'body' },
      ];
    },
    configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (req.url !== '/study') { next(); return; }
        res.statusCode = 302;
        res.setHeader('Location', `/auth?token=${handoff.token}#/s/${ids[0]}`);
        res.end();
      });
    },
  }],
});
await server.listen();
console.log(`NAT-91 real UI dev preview: http://127.0.0.1:${server.config.server.port}/study`);
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
