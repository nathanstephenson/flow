import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { nodeExecutionAssets } from './node-assets.ts';

/** Discover assets only; the filesystem policy must validate and pin every returned path. */
export function pathToolchainAssets(path: string, scope: string, hidden: (path: string) => boolean,
  protectedPath: (path: string) => boolean): { path: string; assets: string[] } {
  const assets = new Set<string>();
  const entries = path.split(':').map(entry => {
    const logical = isAbsolute(entry) ? entry : resolve(scope, entry || '.');
    if (!existsSync(logical) || !statSync(logical).isDirectory()) return entry;
    const directory = realpathSync(logical);
    // Intentionally masked stores (e.g. Pi's credential directory in an inherited PATH) stay
    // hidden. Only collateral ancestor-mask damage is repaired; explicit protected commands
    // are still refused by the launch policy, and SDK resources use their narrow staging path.
    if (protectedPath(directory)) return entry;
    const masked = hidden(logical) || hidden(directory);
    if (masked) assets.add(directory);
    // Rewriting masked directory aliases preserves command selection without mounting a broad
    // home ancestor merely to restore a symlink such as ~/.nvm/current/bin -> versions/.../bin.
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isSymbolicLink()) continue;
      const candidate = join(directory, entry.name);
      if (!existsSync(candidate)) continue;
      const target = realpathSync(candidate);
      if (!hidden(target) || protectedPath(target)) continue;
      if (statSync(target).isDirectory()) { assets.add(target); continue; }
      let root = dirname(target);
      // npm/npx/corepack launch scripts need their package's relative modules, not just the
      // target file. A manifest identifies a narrow package; never infer an arbitrary ancestor.
      for (let parent = root; parent !== dirname(parent); parent = dirname(parent)) {
        if (existsSync(join(parent, 'package.json'))) { root = parent; break; }
      }
      assets.add(root);
    }
    if (masked && basename(directory) === 'bin') {
      const root = dirname(directory);
      // Python virtual environments resolve their interpreter's prefix through this file.
      if (existsSync(join(root, 'pyvenv.cfg'))) assets.add(root);
      else for (const name of ['lib', 'lib64']) {
        const library = join(root, name);
        if (existsSync(library) && statSync(library).isDirectory() && hidden(library)) assets.add(realpathSync(library));
      }
    }
    return masked ? directory : entry;
  });
  const paths = [...assets];
  return { path: entries.join(':'), assets: [...paths, ...nodeExecutionAssets(paths)] };
}
