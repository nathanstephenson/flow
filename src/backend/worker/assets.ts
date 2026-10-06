import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Match the SEA optional-SDK loader, including Node's default $PREFIX/lib/node lookup.
 * These are candidates only: all trees and linked package targets still pass the mount policy.
 */
export function seaSdkExecutionAssets(): string[] {
  const sdk = '@earendil-works/pi-coding-agent';
  const assets: string[] = [];
  for (const root of createRequire(process.execPath).resolve.paths(sdk) ?? []) {
    const pkg = join(root, sdk);
    if (existsSync(join(pkg, 'package.json'))) assets.push(root, pkg);
  }
  return assets;
}
