import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
const here = dirname(fileURLToPath(import.meta.url));
const evaluator = resolve(here, '../../../evaluator');
const scratch = await mkdtemp(join(tmpdir(), 'evaluation-graph-build-'));
try {
  for (const [name, params] of [['comparison', 'test/fixtures/comparison/params.json'], ['default', 'test/fixtures/params.json']]) {
    execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'graph', '--params', params, '--out', join(scratch, name)], { cwd: evaluator, stdio: 'inherit' });
  }
  const out = resolve(here, 'dist');
  await mkdir(out, { recursive: true });
  for (const file of ['index.html', 'style.css', 'app.js']) await cp(join(here, file), join(out, file));
  await cp(resolve(here, '../../../web/public/fonts'), join(out, 'fonts'), { recursive: true });
  await cp(join(scratch, 'comparison/graph.json'), join(out, 'graph.json'));
  await cp(join(scratch, 'default/graph.json'), join(out, 'default-graph.json'));
  const data = JSON.parse(await readFile(join(out, 'graph.json')));
  console.log(`Static build: ${out}; ${data.nodes.length} keys, ${data.frames.length - 1} slots; all assets local.`);
} finally { await rm(scratch, { recursive: true, force: true }); }
