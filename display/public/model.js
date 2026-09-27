// Pure helpers over the compact feed. Shared by the page and by the feed's
// round-trip check, so the page never re-derives relations or the rule: it only
// replays change points that the evaluator's graph exporter produced.

// Frame slots are window indices; `null` is the frame before any observation.
const atOrBefore = (change, slot) => change === null || (slot !== null && change <= slot);

export function nodeAt(key, slot) {
  let state = key.changes[0];
  for (const change of key.changes) {
    if (!atOrBefore(change[0], slot)) break;
    state = change;
  }
  const [, status, qualifyingPartners, partnerCount, reason] = state;
  return { address: key.address, credentialed: key.credentialed, status, partnerCount, qualifyingPartners, reason };
}

export function windowsAt(pair, slot) {
  const windows = new Set();
  for (const [at, added, removed] of pair.changes) {
    if (!atOrBefore(at, slot)) break;
    for (const w of added) windows.add(w);
    for (const w of removed) windows.delete(w);
  }
  return [...windows].sort((a, b) => a - b);
}

// Same shape and order as one frame of the exporter's graph.json.
export function frameAt(feed, slot) {
  return {
    slot,
    nodes: feed.keys.map(key => nodeAt(key, slot)),
    edges: feed.pairs
      .map(pair => ({ source: pair.a, target: pair.b, windows: windowsAt(pair, slot), counted: pair.counted }))
      .filter(edge => edge.windows.length),
  };
}

// Pairs that gained a mutual window in exactly this slot.
export function encountersIn(feed, slot) {
  return feed.pairs.filter(pair => pair.changes.some(([at, added]) => at === slot && added.includes(slot)));
}

// Encounter count per slot, first..last, for the timeline.
export function activity(feed) {
  const { first, last } = feed.slots;
  if (first === null) return [];
  const counts = new Array(last - first + 1).fill(0);
  for (const pair of feed.pairs)
    for (const [at, added] of pair.changes) if (at !== null && added.includes(at)) counts[at - first]++;
  return counts;
}

export const slotStart = (feed, slot) => slot * feed.rule.slotSeconds * 1000;
