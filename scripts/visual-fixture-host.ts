// Isolated Session Host serving the normal production web build, with FakeBackend.
// Run `npm run build:web` first. No preview plugin or operator/model credentials.
import { cp, mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { FakeBackend } from '../src/backend/fake/index.ts';
import { SessionHost } from '../src/daemon/host.ts';
import { TranscriptStore } from '../src/daemon/store.ts';
import { ConfigStore } from '../src/daemon/config-store.ts';
import { serve } from '../src/daemon/server.ts';
import { manifestOf } from '../src/web/manifest.ts';

const requestedRoot = process.env.FLOW_VISUAL_STATE_DIR;
const root = resolve(requestedRoot ?? await mkdtemp(join(tmpdir(), 'flow-visual-')));
if (!root.startsWith(`${resolve(tmpdir())}/`)) throw new Error('Visual fixtures require isolated temporary state');
if (requestedRoot) await mkdir(root); // Refuse reused state or a symlink, including operator state.
if (!(await realpath(root)).startsWith(`${await realpath(tmpdir())}/`)) throw new Error('Visual fixture state must resolve inside the temporary directory');
const store = new TranscriptStore(root);
const config = new ConfigStore(root);
const backend = new FakeBackend();
const host = new SessionHost({ store, defaultBackend: () => 'fake' });
host.registerBackend(backend);
const scope = join(root, 'workspace', 'flow');
await mkdir(scope, { recursive: true });
execFileSync('git', ['init', '-b', 'main', scope], { stdio: 'ignore' });
await writeFile(join(scope, 'README.md'), '# Visual alignment fixture\n');
execFileSync('git', ['-C', scope, 'add', 'README.md']);
execFileSync('git', ['-C', scope, '-c', 'user.name=Preview', '-c', 'user.email=preview@localhost', 'commit', '-m', 'Preview fixture'], { stdio: 'ignore' });
execFileSync('git', ['-C', scope, 'checkout', '-b', 'rail-refinement'], { stdio: 'ignore' });
await writeFile(join(scope, 'README.md'), '# Visual alignment fixture\n\nNative fills and cursor-local gloss across controls.\n');
const titles = ['Refine the session rail', 'Review the adapter contract', 'Polish keyboard navigation', 'Inspect workflow retries', 'Confirm migration'];
const ids: string[] = [];
for (const title of titles) {
  const sessionScope = ids.length === 0 ? scope : join(root, 'workspace', `fixture-${ids.length}`, 'flow');
  if (sessionScope !== scope) await cp(scope, sessionScope, { recursive: true });
  if (ids.length === 3) {
    // Load a genuine detached Lifecycle, not an Idle row with simulated classes.
    const id = randomUUID(), now = new Date().toISOString();
    store.writeMeta({ id, scope: sessionScope, backend: 'fake', title, titleSource: 'first-line', lifecycle: 'dormant', createdAt: now, updatedAt: now, outputPreview: 'No Backend Session is attached. This Agent Session can be Revived.' });
    await host.load();
    ids.push(id);
    continue;
  }
  const id = await host.create({ scope: sessionScope, backend: 'fake', effort: 'high' });
  ids.push(id);
  await host.send(id, title, 'now');
  const session = backend.latest;
  if (ids.length === 1) {
    session.say('The production controls should keep native fills, readable labels and keyboard focus. Selection, status and cursor-local gloss have distinct jobs.');
    session.useTool('read', { path: 'web/src/components/ui/button.tsx' }, 'Inspected the shared Button and existing rail controls.');
    session.completeTurn();
    await host.send(id, 'Keep the texture primarily on controls. Make the lighting respond across the interface.', 'now');
    const contrast = session.beginSubagent('Contrast audit', 'Check selected controls in both themes');
    contrast.say('Check the dark labels over silver faces and the status colours on graphite.');
    contrast.finish();
    const interaction = session.beginSubagent('Interaction review', 'Check hover, focus, tabs, and reduced motion');
    interaction.say('Native tab and dropdown fills stay stable; button gloss follows the cursor locally.');
    interaction.finish();
    session.say('The normal production build now carries visual alignment in the real Flow components. Status-coloured edges stay stable, selected rows flow rightward, and cursor-local gloss overlays native control fills.\n\n- Reduced motion keeps selection static.\n- Connected tab and action strips use their available space.\n- Selection, hover, and keyboard focus remain distinct.');
    session.completeTurn();
  } else if (ids.length === 2) {
    session.say('Checking the event boundaries and the adapter contract.', false);
  } else if (ids.length === 5) {
    session.askPermission('Edit', { path: 'schema.ts' });
  } else {
    session.say('The review is complete. No changes needed.');
    session.completeTurn();
  }
  await new Promise(resolve => setImmediate(resolve));
  const summary = host.list().find(s => s.id === id);
  if (summary?.attention?.group === 'unread') host.acknowledge(id, summary.attention.version);
}
const settledScope = join(root, 'workspace', 'fixture-settled', 'flow');
await cp(scope, settledScope, { recursive: true });
const settledId = await host.create({ scope: settledScope, backend: 'fake' });
await host.send(settledId, 'Review complete', 'now');
backend.latest.say('This review is Settled. It remains readable and Revivable.');
backend.latest.completeTurn();
await new Promise(resolve => setImmediate(resolve));
await host.settle(settledId);
const token = randomBytes(32).toString('hex');
const server = await serve({ host, store, config, token, scope, port: Number(process.env.FLOW_VISUAL_PORT ?? 4392), assets: manifestOf(fileURLToPath(new URL('../web/dist', import.meta.url))) });
await writeFile(join(root, 'token'), token, { mode: 0o600 });
await writeFile(join(root, 'daemon.json'), JSON.stringify({ url: server.url, token }), { mode: 0o600 });
await writeFile(join(root, 'study.json'), JSON.stringify({ ids, settledId }), { mode: 0o600 });
console.log(`Isolated production UI fixture host: ${server.url}\nState root: ${root}`);
const stop = async () => { await server.close(); await host.shutdown(); process.exit(0); };
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
