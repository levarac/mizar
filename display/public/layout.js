// Keys sit evenly on a ring that fills the drawing box, so discs and labels never
// overlap and replaying slots never moves a node. Keys that met often are placed
// next to each other. A refresh keeps the existing order and only inserts new keys
// beside their strongest partner, so the picture stays put.

// Pair weights: every pair, heavier when both keys count and they met often.
export function pairWeights(feed) {
  const weights = new Map();
  for (const pair of feed.pairs) {
    const windows = new Set(pair.changes.flatMap(([, added]) => added)).size;
    const w = (pair.counted ? 2 : 1) * Math.log2(1 + windows);
    for (const [a, b] of [[pair.a, pair.b], [pair.b, pair.a]]) {
      if (!weights.has(a)) weights.set(a, new Map());
      weights.get(a).set(b, w);
    }
  }
  return weights;
}

export function ringOrder(addresses, weights, previous = []) {
  const w = (a, b) => weights.get(a)?.get(b) ?? 0;
  const total = a => [...(weights.get(a)?.values() ?? [])].reduce((s, x) => s + x, 0);
  const known = new Set(addresses);
  const order = previous.filter(a => known.has(a));
  const rest = addresses.filter(a => !order.includes(a))
    .sort((a, b) => total(b) - total(a) || a.toLowerCase().localeCompare(b.toLowerCase()));
  if (!order.length && rest.length) {
    // First layout: greedy chain, each next key being the strongest partner of the last one.
    order.push(rest.shift());
    while (rest.length) {
      const last = order.at(-1);
      rest.sort((a, b) => w(last, b) - w(last, a) || total(b) - total(a) || a.toLowerCase().localeCompare(b.toLowerCase()));
      order.push(rest.shift());
    }
    return order;
  }
  for (const address of rest) {
    // Insert next to the strongest placed partner, or at the end for keys without encounters.
    let best = -1, score = 0;
    order.forEach((placed, i) => { if (w(address, placed) > score) { score = w(address, placed); best = i; } });
    order.splice(best < 0 ? order.length : best + 1, 0, address);
  }
  return order;
}

export function ringPositions(order, { width = 1000, height = 800, margin = 110 } = {}) {
  const n = order.length, cx = width / 2, top = margin * 0.7, bottom = margin * 1.35;
  const cy = top + (height - top - bottom) / 2;
  const rx = Math.max(0, width / 2 - margin * 1.2), ry = Math.max(0, (height - top - bottom) / 2);
  if (n === 1) return new Map([[order[0], { x: cx, y: cy }]]);
  // Two keys sit side by side; more go round the ring starting at the top. Keys are
  // spaced by arc length, since equal angles bunch up at the ends of a wide ellipse.
  const start = n === 2 ? Math.PI : -Math.PI / 2, samples = 720;
  const points = [], lengths = [0];
  for (let k = 0; k <= samples; k++) {
    const t = start + (2 * Math.PI * k) / samples;
    points.push({ x: cx + rx * Math.cos(t), y: cy + ry * Math.sin(t) });
    if (k) lengths.push(lengths[k - 1] + Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y));
  }
  let k = 1;
  return new Map(order.map((address, i) => {
    const target = (lengths[samples] * i) / n;
    while (k < samples && lengths[k] < target) k++;
    const f = lengths[k] === lengths[k - 1] ? 0 : (target - lengths[k - 1]) / (lengths[k] - lengths[k - 1]);
    const a = points[k - 1], b = points[k];
    return [address, { x: a.x + (b.x - a.x) * Math.max(0, f), y: a.y + (b.y - a.y) * Math.max(0, f) }];
  }));
}
