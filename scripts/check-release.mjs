import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const tag = process.env.GITHUB_REF_NAME ?? '';
if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
  throw new Error('Release tags must be stable versions: vX.Y.Z');
}
execFileSync('git', ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const version = tag.slice(1);
if (metadata.name !== '@nathanstephenson/flow' || metadata.private === true ||
    metadata.version !== version || lock.version !== version ||
    lock.packages?.['']?.version !== version) {
  throw new Error('The release tag, package and lockfile must identify the same publishable Flow version');
}
console.log(`Release verified: ${metadata.name}@${version}`);
