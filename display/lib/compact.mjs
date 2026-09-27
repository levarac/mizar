// Turns the evaluator's NON-CANONICAL graph.json (one full frame per window)
// into change points, and checks that replaying them reproduces every frame.
import { frameAt } from '../public/model.js';

const lower = value => value.toLowerCase();
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const pickNode = n => ({ address: n.address, credentialed: n.credentialed, status: n.status,
  partnerCount: n.partnerCount, qualifyingPartners: n.qualifyingPartners, reason: n.reason ?? null });
const pickEdge = e => ({ source: e.source, target: e.target, windows: e.windows, counted: e.counted });

export function compactFrames(graph) {
  if (graph?.kind !== 'NON-CANONICAL' || graph.version !== 1 || !Array.isArray(graph.frames) || graph.frames[0]?.slot !== null)
    throw new Error('unexpected graph export');
  const keys = graph.nodes.map(n => ({ address: n.address, credentialed: n.credentialed, changes: [] }));
  const keyOf = new Map(keys.map(k => [k.address, k]));
  const pairs = new Map();
  for (const frame of graph.frames) {
    for (const node of frame.nodes) {
      const key = keyOf.get(node.address);
      if (!key || key.credentialed !== node.credentialed) throw new Error('graph keys changed between frames');
      const state = [frame.slot, node.status, node.qualifyingPartners, node.partnerCount, node.reason ?? null];
      const last = key.changes.at(-1);
      if (!last || !same(last.slice(1), state.slice(1))) key.changes.push(state);
    }
    const present = new Set();
    for (const edge of frame.edges) {
      const id = `${edge.source}|${edge.target}`;
      let pair = pairs.get(id);
      if (!pair) pairs.set(id, pair = { a: edge.source, b: edge.target, counted: edge.counted, changes: [], current: new Set() });
      if (pair.counted !== edge.counted) throw new Error('edge credential flag changed between frames');
      present.add(id);
      const next = new Set(edge.windows);
      const added = edge.windows.filter(w => !pair.current.has(w));
      const removed = [...pair.current].filter(w => !next.has(w)).sort((a, b) => a - b);
      if (added.length || removed.length) pair.changes.push([frame.slot, added, removed]);
      pair.current = next;
    }
    // A later RPID conflict can remove a pair's windows entirely.
    for (const [id, pair] of pairs) if (!present.has(id) && pair.current.size) {
      pair.changes.push([frame.slot, [], [...pair.current].sort((a, b) => a - b)]);
      pair.current = new Set();
    }
  }
  const slots = graph.frames.slice(1).map(f => f.slot);
  return {
    rule: graph.rule,
    slots: { first: slots[0] ?? null, last: slots.at(-1) ?? null },
    keys,
    pairs: [...pairs.values()].map(({ current, ...pair }) => pair)
      .sort((x, y) => lower(x.a + x.b).localeCompare(lower(y.a + y.b))),
  };
}

// Hard gate: the page must be able to show exactly what the exporter computed.
export function checkRoundTrip(graph, feed) {
  for (const frame of graph.frames) {
    const expected = { slot: frame.slot, nodes: frame.nodes.map(pickNode), edges: frame.edges.map(pickEdge) };
    const actual = frameAt(feed, frame.slot);
    if (!same(expected, { slot: actual.slot, nodes: actual.nodes.map(pickNode), edges: actual.edges.map(pickEdge) }))
      throw new Error(`compact feed does not reproduce graph frame ${frame.slot}`);
  }
}

// Commitments as anchored on chain, with the window range of their verified observations.
export function anchorList(pages, blocks, cutoffBlock, evidence) {
  const byDigest = new Map();
  for (const page of pages) for (const item of page.commitments) {
    const digest = lower(item.anchor.commitmentDigest);
    let entry = byDigest.get(digest);
    if (!entry) byDigest.set(digest, entry = { sequence: item.anchor.sequence, digest, block: blocks[digest],
      committedAt: item.anchor.committedAt, included: [] });
    // Continuation pages repeat a commitment with its next inclusions.
    for (const inclusion of item.inclusions) entry.included.push(inclusion.observationDigest);
  }
  const eninOf = new Map(evidence.observations.map(o => [o.digest, o.enin]));
  const invalid = new Set(evidence.invalid.map(o => o.digest));
  return [...byDigest.values()].sort((a, b) => a.sequence - b.sequence).map(({ included, ...entry }) => {
    const enins = included.map(d => eninOf.get(d)).filter(e => e !== undefined);
    if (!Number.isSafeInteger(entry.block)) throw new Error('commitment without an anchor block');
    return { ...entry, observations: included.length, invalid: included.filter(d => invalid.has(d)).length,
      slots: enins.length ? [Math.min(...enins), Math.max(...enins)] : null, afterCutoff: entry.block > cutoffBlock };
  });
}
