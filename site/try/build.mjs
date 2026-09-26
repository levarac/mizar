// Assembles dist/: the hand-written page, the shared Inter font files and the
// evaluation graph replay (built from docs/demo/graph when its dist is missing).
import { cp, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(here, 'dist');
const graphDist = resolve(root, 'docs/demo/graph/dist');

const exists = (p) => stat(p).then(() => true, () => false);

if (!(await exists(resolve(graphDist, 'index.html')))) {
  execFileSync(process.execPath, [resolve(root, 'docs/demo/graph/build.mjs')], { stdio: 'inherit' });
}

await rm(out, { recursive: true, force: true });
await cp(resolve(here, 'public'), out, { recursive: true });
await cp(resolve(root, 'web/public/fonts'), resolve(out, 'fonts'), { recursive: true });
await cp(graphDist, resolve(out, 'graph'), { recursive: true });
console.log(`Static build: ${out}`);
