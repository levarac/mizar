// Assembles dist/: the static page, the shared Inter font and a recorded feed
// built offline from the posted snapshot archive the claim page serves. A live
// feed (feed.ts without --snapshot) later replaces dist/live.json in place.
import { cp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const out = resolve(here, 'dist');
const tsx = resolve(root, 'evaluator/node_modules/.bin/tsx');
const config = JSON.parse(await readFile(resolve(root, 'web/public/claim-config.json'), 'utf8'));

await rm(out, { recursive: true, force: true });
await cp(resolve(here, 'public'), out, { recursive: true });
await cp(resolve(root, 'web/public/fonts'), resolve(out, 'fonts'), { recursive: true });
execFileSync(tsx, [resolve(here, 'feed.ts'), '--snapshot', resolve(root, 'web/public/snapshots', String(config.snapshotId)),
  '--out', resolve(out, 'live.json')], { stdio: 'inherit' });
console.log(`Static build: ${out}`);
