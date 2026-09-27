// Assembles dist/: the static page, the shared Inter font and a recorded feed
// built offline from the posted snapshot archive the claim page serves, as
// snapshot-<id>.json (the page's ?view=snapshot<id>) and as the initial
// live.json. A live feed (feed.ts without --snapshot) later replaces live.json.
import { copyFile, cp, readFile, rm } from 'node:fs/promises';
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
const recorded = resolve(out, `snapshot-${config.snapshotId}.json`);
execFileSync(tsx, [resolve(here, 'feed.ts'), '--snapshot', resolve(root, 'web/public/snapshots', String(config.snapshotId)),
  '--out', recorded], { stdio: 'inherit' });
await copyFile(recorded, resolve(out, 'live.json'));
console.log(`Static build: ${out}`);
