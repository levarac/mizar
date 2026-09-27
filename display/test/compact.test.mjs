import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anchorList, checkRoundTrip, compactFrames } from '../lib/compact.mjs';
import { frameAt, windowsAt } from '../public/model.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const evaluator = join(root, 'evaluator');

// Runs the evaluator's own NON-CANONICAL exporter and returns its graph.json.
function exported(args) {
  const scratch = mkdtempSync(join(tmpdir(), 'display-test-'));
  try {
    execFileSync(join(evaluator, 'node_modules/.bin/tsx'), ['src/cli.ts', 'graph', ...args, '--out', join(scratch, 'graph')],
      { cwd: evaluator, stdio: 'pipe' });
    return JSON.parse(readFileSync(join(scratch, 'graph/graph.json'), 'utf8'));
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

for (const [name, args] of [
  ['synthetic default fixture', ['--params', 'test/fixtures/params.json']],
  ['synthetic comparison fixture', ['--params', 'test/fixtures/comparison/params.json']],
  ['posted snapshot 1 archive', ['--snapshot', join(root, 'web/public/snapshots/1')]],
]) {
  test(`compact feed reproduces every exported frame: ${name}`, () => {
    const graph = exported(args);
    const feed = compactFrames(graph);
    checkRoundTrip(graph, feed);
    assert.equal(feed.keys.length, graph.nodes.length);
    assert.equal(feed.slots.first, graph.frames[1]?.slot ?? null);
    assert.equal(feed.slots.last, graph.frames.at(-1).slot);
    assert.ok(JSON.stringify(feed).length < JSON.stringify(graph).length);
  });
}

test('the round-trip check rejects a feed that differs from the export', () => {
  const graph = exported(['--params', 'test/fixtures/params.json']);
  const feed = compactFrames(graph);
  const pair = feed.pairs.find(p => p.changes.length);
  pair.changes[0][1] = [...pair.changes[0][1], pair.changes[0][0] + 1];
  assert.throws(() => checkRoundTrip(graph, feed), /does not reproduce/);
});

// A later RPID conflict can drop windows a pair already had, or the whole pair.
test('window removals and vanished pairs are kept as change points', () => {
  const node = (address, status) => ({ address, credentialed: true, status, partnerCount: 0, qualifyingPartners: 0, reason: null });
  const nodes = [node('0xA', 'no_qualifying_partner'), node('0xB', 'no_qualifying_partner'), node('0xC', 'no_qualifying_partner')];
  const edge = (source, target, windows) => ({ source, target, windows, counted: true });
  const graph = {
    version: 1, kind: 'NON-CANONICAL', rule: { minPartners: 2, minWindowsPerPartner: 2, slotSeconds: 300 }, nodes,
    frames: [
      { slot: null, nodes, edges: [] },
      { slot: 10, nodes, edges: [edge('0xA', '0xB', [10]), edge('0xA', '0xC', [10])] },
      { slot: 11, nodes, edges: [edge('0xA', '0xB', [10, 11]), edge('0xA', '0xC', [10, 11])] },
      { slot: 12, nodes, edges: [edge('0xA', '0xB', [11, 12])] },
    ],
  };
  const feed = compactFrames(graph);
  checkRoundTrip(graph, feed);
  const ab = feed.pairs.find(p => p.b === '0xB'), ac = feed.pairs.find(p => p.b === '0xC');
  assert.deepEqual(windowsAt(ab, 11), [10, 11]);
  assert.deepEqual(windowsAt(ab, 12), [11, 12]);
  assert.deepEqual(windowsAt(ac, 12), []);
  assert.deepEqual(frameAt(feed, 12).edges.map(e => e.target), ['0xB']);
});

test('anchor list merges continuation pages and maps observations to their windows', () => {
  const commitment = (sequence, digest, inclusions) => ({ anchor: { sequence, commitmentDigest: digest, committedAt: 1000 + sequence },
    inclusions: inclusions.map(d => ({ observationDigest: d })) });
  const pages = [
    { commitments: [commitment(1, 'AA', ['o1', 'o2'])] },
    { commitments: [commitment(1, 'AA', ['o3'])] },
    { commitments: [commitment(2, 'BB', ['o4'])] },
  ];
  const evidence = { observations: [{ digest: 'o1', enin: 7 }, { digest: 'o2', enin: 9 }, { digest: 'o3', enin: 8 }], invalid: [{ digest: 'o4' }] };
  const anchors = anchorList(pages, { aa: 100, bb: 120 }, 110, evidence);
  assert.deepEqual(anchors, [
    { sequence: 1, digest: 'aa', block: 100, committedAt: 1001, observations: 3, invalid: 0, slots: [7, 9], afterCutoff: false },
    { sequence: 2, digest: 'bb', block: 120, committedAt: 1002, observations: 1, invalid: 1, slots: null, afterCutoff: true },
  ]);
});
