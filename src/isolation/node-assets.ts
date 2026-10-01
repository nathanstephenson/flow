import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** Existing Node search trees and linked package targets, never their home/workspace
 * ancestors. These are execution-asset candidates, NOT grants: callers must pass every
 * result through prepareFilesystemIsolation's protected-path validation.
 * Uses Node's search algorithm for both npm installs and dependencies beside a SEA.
 */
export function nodeExecutionAssets(entries: readonly string[]): string[] {
  const assets = new Set<string>();
  const searched = new Set<string>();
  const trees = new Set<string>();
  const pending: string[] = [];
  const addTree = (path: string) => {
    if (!existsSync(path)) return;
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) return;
    // Retain the lookup name too: an ancestor mask hides the original node_modules
    // symlink even when its canonical target is restored. The policy rebuilds only
    // this validated alias, never its containing home/workspace.
    assets.add(path);
    assets.add(canonical);
    if (!trees.has(canonical)) {
      trees.add(canonical); pending.push(canonical);
      // Packages in an aliased tree resolve from its real directory, which need not be
      // named node_modules. Preserve that directory's own ancestor lookup trees too.
      search(canonical);
    }
  };
  const search = (entry: string) => {
    const canonical = realpathSync(entry);
    const directory = statSync(canonical).isDirectory() ? canonical : dirname(canonical);
    if (searched.has(directory)) return;
    searched.add(directory);
    // Node skips node_modules/node_modules, but otherwise searches up to the root.
    // NODE_PATH is scrubbed. Loaders needing Node's default global-prefix directories
    // must supply those roots explicitly (as the SEA SDK loader does).
    for (let ancestor = directory; ; ancestor = dirname(ancestor)) {
      if (basename(ancestor) !== "node_modules") addTree(join(ancestor, "node_modules"));
      if (ancestor === dirname(ancestor)) break;
    }
  };
  for (const entry of entries) search(entry);
  const visitPackage = (path: string) => {
    // Broken optional links are not existing assets. Other filesystem errors fail closed.
    if (!existsSync(path)) return;
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) return;
    if (canonical !== path) { assets.add(canonical); search(canonical); }
    // Nested installs may themselves contain external links, even in unlinked packages.
    addTree(join(canonical, "node_modules"));
  };
  for (let index = 0; index < pending.length; index++) {
    const tree = pending[index]!;
    for (const entry of readdirSync(tree, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue; // .bin and package-manager metadata aren't packages.
      const path = join(tree, entry.name);
      if (!existsSync(path)) continue;
      if (entry.name.startsWith("@") && statSync(path).isDirectory()) {
        const canonical = realpathSync(path);
        if (canonical !== path) assets.add(canonical);
        for (const name of readdirSync(path)) visitPackage(join(path, name));
      } else visitPackage(path);
    }
  }
  return [...assets];
}
