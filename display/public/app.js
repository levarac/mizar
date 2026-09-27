import { activity, frameAt, slotStart, windowsAt } from './model.js';
import { tagFor } from './tags.js';
import { pairWeights, ringOrder, ringPositions } from './layout.js';

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const POLL_MS = 15000;
const STALE_MS = 8 * 60 * 1000;
const params = new URLSearchParams(location.search);
if (params.get('theme') === 'light') document.documentElement.dataset.theme = 'light';
// ?view=snapshot1 shows the recorded, posted snapshot; the default is the live feed.
const recordedView = /^snapshot(\d+)$/.exec(params.get('view') ?? '');
const FEED_URL = recordedView ? `snapshot-${recordedView[1]}.json` : 'live.json';
const AUTOPLAY_MS = Math.max(0, Number(params.get('autoplay') ?? 0)) * 60000;

let feed, status, cursor = null, player, lastInteraction = Date.now();
let grownPairs = new Set(), grownUntil = 0, landedFrom = Infinity, toastTimer;

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};
const svg = (tag, attrs = {}, text) => {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
};
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockSeconds = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const num = n => n.toLocaleString('en-US');
const shortHex = value => `${value.slice(0, 6)}…${value.slice(-4)}`;
const lower = value => value.toLowerCase();
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const live = () => feed.mode === 'live-preview';
const shownSlot = () => cursor ?? feed.slots.last;
const slotText = slot => `${clock.format(slotStart(feed, slot))}–${clock.format(slotStart(feed, slot + 1))}`;
const pairId = (a, b) => `${a}|${b}`;

const STATUS = {
  passed: 'Meets the rule',
  credentialed_not_passed: 'Meeting people',
  no_qualifying_partner: 'No encounters yet',
  not_credentialed: 'No human check',
  excluded_duplicate: 'Duplicate human check',
};

// Graph: elements are kept per key and per pair, so frames update in place and
// layout changes glide instead of redrawing.
const graphView = { layers: null, nodes: new Map(), edges: new Map(), shown: new Map(), order: [], frame: 0, layoutKey: '' };

function layers() {
  if (graphView.layers) return graphView.layers;
  const edges = svg('g', { class: 'edges' }), labels = svg('g', { class: 'labels' }), nodes = svg('g', { class: 'nodes' });
  $('graph').replaceChildren(edges, labels, nodes);
  return graphView.layers = { edges, labels, nodes };
}

function nodeView(address) {
  let view = graphView.nodes.get(address);
  if (view) return view;
  const tag = tagFor(address), g = svg('g', { class: 'node' }), body = svg('g', { class: 'body' });
  const title = svg('title', {}, tag.label);
  const flag = svg('text', { y: 128, class: 'flag' });
  body.append(svg('circle', { r: 62, class: 'halo' }), svg('circle', { r: 46, class: 'disc', fill: tag.color, stroke: tag.color }),
    svg('text', { y: 16, class: 'emoji' }, tag.emoji), svg('text', { y: 80, class: 'name' }, tag.name),
    svg('text', { y: 104, class: 'short' }, tag.short), flag);
  g.append(title, body);
  layers().nodes.append(g);
  graphView.nodes.set(address, view = { g, flag, title, tag });
  return view;
}

function edgeView(a, b) {
  const id = pairId(a, b);
  let view = graphView.edges.get(id);
  if (view) return view;
  const line = svg('line', { class: 'edge' }), title = svg('title');
  line.append(title);
  const label = svg('text', { class: 'edge-count' });
  layers().edges.append(line);
  layers().labels.append(label);
  graphView.edges.set(id, view = { a, b, line, label, title });
  return view;
}

function placeAll() {
  for (const [address, view] of graphView.nodes) {
    const p = graphView.shown.get(address);
    if (p) view.g.setAttribute('transform', `translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})`);
  }
  for (const view of graphView.edges.values()) {
    const p = graphView.shown.get(view.a), q = graphView.shown.get(view.b);
    if (!p || !q) continue;
    view.line.setAttribute('x1', p.x.toFixed(1)); view.line.setAttribute('y1', p.y.toFixed(1));
    view.line.setAttribute('x2', q.x.toFixed(1)); view.line.setAttribute('y2', q.y.toFixed(1));
    view.label.setAttribute('x', ((p.x + q.x) / 2).toFixed(1)); view.label.setAttribute('y', ((p.y + q.y) / 2 + 6).toFixed(1));
  }
}

// The drawing box follows the figure's shape; phones get larger units so labels stay legible.
function viewport() {
  const box = $('graph').getBoundingClientRect();
  const height = box.width && box.width < 700 ? 620 : 800;
  const ratio = box.width && box.height ? box.width / box.height : 1.25;
  return { width: Math.round(Math.min(2.2, Math.max(0.8, ratio)) * height), height };
}

// Recompute the layout only when the keys, the pairs or the drawing box change.
function updateLayout() {
  const box = viewport();
  const dims = `${box.width}x${box.height}`;
  const key = dims + '#' + feed.keys.map(k => k.address).join() + '#' + feed.pairs.map(p => pairId(p.a, p.b)).join();
  if (key === graphView.layoutKey) return;
  if (!graphView.layoutKey.startsWith(dims + '#')) graphView.shown = new Map();
  graphView.layoutKey = key;
  $('graph').setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  $('graph').classList.toggle('dense', feed.keys.length > 12);
  graphView.order = ringOrder(feed.keys.map(k => k.address), pairWeights(feed), graphView.order);
  const target = ringPositions(graphView.order, { width: box.width, height: box.height, margin: box.height * 0.14 });
  const from = new Map(graphView.shown);
  for (const [address, p] of target) if (!from.has(address)) from.set(address, { ...p });
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const start = performance.now(), duration = from.size && !reduce ? 900 : 0;
  cancelAnimationFrame(graphView.frame);
  const step = now => {
    const t = duration ? Math.min(1, (now - start) / duration) : 1, ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    for (const [address, p] of target) {
      const f = from.get(address);
      graphView.shown.set(address, { x: f.x + (p.x - f.x) * ease, y: f.y + (p.y - f.y) * ease });
    }
    placeAll();
    if (t < 1) graphView.frame = requestAnimationFrame(step);
  };
  step(start);
}

function renderGraph(frame, slot) {
  updateLayout();
  const minWindows = feed.rule.minWindowsPerPartner, present = new Set();
  const grown = live() && cursor === null && Date.now() < grownUntil ? grownPairs : new Set();
  for (const edge of frame.edges) {
    const view = edgeView(edge.source, edge.target), id = pairId(edge.source, edge.target);
    present.add(id);
    const kind = !edge.counted ? 'uncounted' : edge.windows.length >= minWindows ? 'complete' : 'progress';
    const classes = ['edge', kind];
    if (edge.windows.includes(slot)) classes.push('fresh');
    if (grown.has(id)) classes.push('grown');
    view.line.setAttribute('class', classes.join(' '));
    view.line.setAttribute('stroke-width', edge.counted ? Math.min(3 + edge.windows.length, 12) : 2.5);
    view.label.setAttribute('class', `edge-count ${kind}`);
    view.label.textContent = String(edge.windows.length);
    view.title.textContent = `${tagFor(edge.source).label} and ${tagFor(edge.target).label}: ${plural(edge.windows.length, 'slot')} together` +
      (edge.counted ? '' : '; does not count, a key lacks the human check');
  }
  for (const [id, view] of graphView.edges) if (!present.has(id)) {
    view.line.setAttribute('class', 'edge gone'); view.label.setAttribute('class', 'edge-count gone');
  }
  const active = new Set(frame.edges.flatMap(e => [e.source, e.target]));
  for (const node of frame.nodes) {
    const view = nodeView(node.address);
    const quiet = !active.has(node.address) && node.status !== 'passed';
    view.g.setAttribute('class', `node ${node.status}${quiet ? ' quiet' : ''}`);
    view.flag.textContent = !node.credentialed ? 'NO HUMAN CHECK' : node.status === 'passed' ? '✓ MEETS RULE' : '';
    view.flag.setAttribute('class', `flag${node.status === 'passed' ? ' pass' : ''}`);
    view.title.textContent = `${view.tag.label}: ${STATUS[node.status]}`;
  }
  const keys = new Set(frame.nodes.map(n => n.address));
  for (const [address, view] of graphView.nodes) if (!keys.has(address)) { view.g.remove(); graphView.nodes.delete(address); }
  placeAll();
}

function partnersOf(address, frame) {
  return frame.edges.filter(e => e.counted && (e.source === address || e.target === address))
    .map(e => ({ address: e.source === address ? e.target : e.source, windows: e.windows.length }))
    .sort((a, b) => b.windows - a.windows);
}

function renderKeys(frame) {
  const list = $('keys');
  list.replaceChildren();
  const posted = new Set((feed.posted?.eligible ?? []).map(lower));
  const order = { passed: 0, credentialed_not_passed: 1, no_qualifying_partner: 2, excluded_duplicate: 3, not_credentialed: 4 };
  const nodes = [...frame.nodes].sort((a, b) => order[a.status] - order[b.status] ||
    b.qualifyingPartners - a.qualifyingPartners || lower(a.address).localeCompare(lower(b.address)));
  for (const node of nodes) {
    const tag = tagFor(node.address), item = el('li', `key ${node.status}`);
    const avatar = el('span', 'avatar', tag.emoji);
    avatar.style.borderColor = tag.color;
    const who = el('span', 'who');
    who.append(el('b', '', tag.name), el('code', '', tag.short));
    const human = el('span', `human ${node.credentialed ? 'yes' : 'no'}`, node.credentialed ? '✓ human check' : '✗ no human check');
    const progress = el('span', 'progress'), pips = el('span', 'pips');
    for (let i = 0; i < feed.rule.minPartners; i++) pips.append(el('i', i < node.qualifyingPartners ? 'on' : ''));
    progress.append(pips, el('span', '', `${node.qualifyingPartners}/${feed.rule.minPartners} partners`));
    const detail = el('span', 'partners');
    for (const p of partnersOf(node.address, frame).slice(0, 4)) {
      const other = tagFor(p.address);
      const pill = el('span', `pill${p.windows >= feed.rule.minWindowsPerPartner ? ' ok' : ''}`);
      const dot = el('i');
      dot.style.background = other.color;
      pill.append(dot, document.createTextNode(`${other.emoji} ${p.windows}`));
      pill.title = `${other.label}: ${plural(p.windows, 'slot')} together`;
      detail.append(pill);
    }
    const state = el('span', 'state', STATUS[node.status]);
    if (posted.has(lower(node.address))) state.append(el('small', '', `in posted snapshot ${feed.posted.snapshotId}`));
    item.append(avatar, who, human, progress, detail, state);
    list.append(item);
  }
}

const anchorSlots = anchor => !anchor.slots ? '' : anchor.slots[0] === anchor.slots[1]
  ? clock.format(slotStart(feed, anchor.slots[0]))
  : `${clock.format(slotStart(feed, anchor.slots[0]))}–${clock.format(slotStart(feed, anchor.slots[1] + 1))}`;

function visibleAnchors(slot) {
  const until = cursor === null ? Infinity : slotStart(feed, slot + 1) / 1000;
  return feed.anchors.filter(a => a.committedAt <= until);
}

// Anchors already on chain whose evidence the operator has not published yet (live view only).
const pendingAnchors = () => live() && cursor === null ? feed.unservedAnchors ?? [] : [];

function renderAnchors(slot) {
  const list = $('anchors'), shown = visibleAnchors(slot), pending = pendingAnchors();
  list.replaceChildren();
  $('anchors-note').textContent = `${num(shown.length)} with evidence${pending.length ? ` · ${pending.length} awaiting evidence` : ''}`;
  const landedNow = anchor => live() && cursor === null && Date.now() < grownUntil && anchor.sequence >= landedFrom;
  for (const anchor of pending.slice(-6).reverse()) {
    const item = el('li', `anchor pending${landedNow(anchor) ? ' landed' : ''}`);
    item.append(el('b', '', `#${anchor.sequence}`), el('span', 'block', `block ${num(anchor.block)}`),
      el('span', 'when', clockSeconds.format(anchor.committedAt * 1000)), el('span', 'what', 'evidence not published yet'));
    item.title = 'Recorded in the Sepolia commitment registry; the operator has not published its observations yet.';
    list.append(item);
  }
  const rows = Math.max(0, 6 - pending.length);
  for (const anchor of (rows ? shown.slice(-rows) : []).reverse()) {
    const item = el('li', `anchor${anchor.afterCutoff ? ' after' : ''}${landedNow(anchor) ? ' landed' : ''}`);
    item.append(el('b', '', `#${anchor.sequence}`), el('span', 'block', `block ${num(anchor.block)}`),
      el('span', 'when', clockSeconds.format(anchor.committedAt * 1000)),
      el('span', 'what', `${anchor.observations} obs${anchor.slots ? ' · ' + anchorSlots(anchor) : ''}`));
    item.title = anchor.afterCutoff ? 'Anchored after this preview\'s cutoff; counted on the next refresh.'
      : `Commitment ${anchor.sequence}, recorded in the Sepolia commitment registry at block ${num(anchor.block)}.`;
    list.append(item);
  }
}

function renderTimeline(slot) {
  const counts = activity(feed), bars = $('bars'), first = feed.slots.first;
  bars.replaceChildren();
  if (!counts.length) return;
  const max = Math.max(1, ...counts), width = counts.length;
  const chart = svg('svg', { viewBox: `0 0 ${width} 40`, preserveAspectRatio: 'none' });
  counts.forEach((count, i) => {
    if (count) chart.append(svg('rect', { x: i, y: 40 - (4 + 30 * count / max), width: 1, height: 4 + 30 * count / max, class: `bar${first + i > slot ? ' future' : ''}` }));
  });
  // Anchor ticks: when each commitment landed, on the same time axis.
  for (const [anchors, kind] of [[visibleAnchors(slot), 'tick'], [pendingAnchors(), 'tick pending']]) for (const anchor of anchors) {
    const x = anchor.committedAt / feed.rule.slotSeconds - first;
    if (x >= 0 && x <= width + 12) chart.append(svg('rect', { x: Math.min(width - 0.35, x).toFixed(2), y: 0, width: 0.35, height: 5, class: kind }));
  }
  chart.append(svg('rect', { x: slot - first, y: 0, width: 1, height: 40, class: 'cursor' }));
  bars.append(chart);
  if (feed.posted) {
    const x = feed.posted.cutoffTimestamp / feed.rule.slotSeconds - first;
    if (x >= 0 && x <= width) {
      const mark = el('span', 'cutoff-mark', `snapshot ${feed.posted.snapshotId} cutoff`);
      mark.style.left = `${(100 * x / width).toFixed(2)}%`;
      bars.append(mark);
      // Put the label on the left of the line when it would run off the right edge.
      if (mark.offsetLeft + mark.offsetWidth > bars.clientWidth) mark.classList.add('flip');
    }
  }
  const scrub = $('scrub');
  scrub.max = String(counts.length - 1);
  scrub.value = String(slot - first);
  const start = slotStart(feed, first), end = slotStart(feed, feed.slots.last + 1);
  $('slot-range').textContent = `${dayFormat.format(start)} ${clock.format(start)} → ${dayFormat.format(end)} ${clock.format(end)}`;
}

function renderHeader(frame, slot) {
  $('stat-keys').textContent = num(frame.nodes.length);
  $('stat-human').textContent = num(frame.nodes.filter(n => n.credentialed).length);
  $('stat-pairs').textContent = num(frame.edges.length);
  $('stat-pass').textContent = num(frame.nodes.filter(n => n.status === 'passed').length);
  $('mode').textContent = cursor !== null ? `REPLAY ${dayFormat.format(slotStart(feed, slot))} ${clock.format(slotStart(feed, slot))}`
    : live() ? 'LIVE PREVIEW' : `RECORDED · SNAPSHOT ${feed.posted?.snapshotId ?? ''}`.trim();
  $('mode').className = `chip mode ${cursor !== null ? 'replay' : live() ? 'live' : 'recorded'}`;
  const newestEnd = slotStart(feed, feed.slots.last + 1);
  $('lag').textContent = live() ? `newest slot ended ${Math.max(0, Math.round((Date.now() - newestEnd) / 60000))} min ago`
    : `cutoff ${dayFormat.format(feed.cutoff.timestamp * 1000)} ${clock.format(feed.cutoff.timestamp * 1000)}`;
  $('event').textContent = `Demo event ${shortHex(feed.event.id)} · Sepolia · ${feed.rule.slotSeconds / 60}-minute slots · times in ${zone}`;
  $('slot-now').textContent = `${cursor === null ? 'Newest slot' : 'Slot'} ${dayFormat.format(slotStart(feed, slot))} ${slotText(slot)}`;
  $('rule-text').textContent = `meet ${feed.rule.minPartners} human-checked people, each in ${feed.rule.minWindowsPerPartner} different ${feed.rule.slotSeconds / 60}‑minute slots.`;
  $('keys-note').textContent = cursor === null ? '' : 'at this slot';
  $('live').textContent = live() ? 'Live' : 'Latest';
}

function renderHonesty() {
  const footer = $('honest'), posted = feed.posted, lines = [];
  footer.replaceChildren();
  if (live()) lines.push(['Minutes behind.', `An observation appears only after its commitment is anchored on Sepolia and the operator publishes the evidence. Refreshed ${clockSeconds.format(Date.parse(feed.generatedAt))}; evidence through block ${num(feed.cutoff.block)}.`]);
  else lines.push(['Recorded, not live.', `The evaluation archive of snapshot ${posted?.snapshotId}, cutoff block ${num(feed.cutoff.block)}.`]);
  lines.push(['Keys and time slots only.', 'No names, no locations. The public log has event keys and 5-minute slots; each animal tag is derived from a key address.']);
  if (posted) {
    const chain = posted.rootPosted === 'matches' ? ' Its RootPosted event on Sepolia matches the archive.'
      : posted.rootPosted === 'differs' ? ' Warning: its RootPosted event on Sepolia differs from the archive.' : '';
    lines.push([live() ? 'Rule status is a preview.' : 'Posted on chain.',
      `${live() ? `Computed at block ${num(feed.cutoff.block)} and not posted. ` : ''}Only snapshot ${posted.snapshotId} is posted: root ${shortHex(posted.root)}, cutoff block ${num(posted.cutoffBlock)}, ${plural(posted.eligible.length, 'key')}.${chain}`]);
  }
  lines.push(['NON-CANONICAL.', feed.notice]);
  for (const [lead, text] of lines) {
    const p = el('p');
    p.append(el('b', '', lead + ' '), document.createTextNode(text));
    footer.append(p);
  }
}

function renderBanner() {
  const banner = $('banner');
  if (!feed || !live()) { banner.hidden = true; return; }
  const failing = status && status.ok === false, age = Date.now() - Date.parse(feed.generatedAt);
  banner.hidden = !(age > STALE_MS || failing);
  banner.textContent = `Feed is behind: last successful refresh ${clockSeconds.format(Date.parse(feed.generatedAt))}` +
    `${failing ? ', retrying' : ''}. Showing the last good data.`;
}

function toast(text) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  box.classList.remove('show'); void box.offsetWidth; box.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 9000);
}

function render() {
  if (!feed || feed.slots.first === null) return;
  const slot = shownSlot(), frame = frameAt(feed, slot);
  renderHeader(frame, slot);
  renderGraph(frame, slot);
  renderKeys(frame);
  renderAnchors(slot);
  renderTimeline(slot);
  renderHonesty();
  renderBanner();
  $('live').classList.toggle('on', cursor === null);
  $('replay').textContent = player ? 'Pause' : 'Replay';
}

// What a new live feed adds: pairs with more shared slots, and new anchors.
function noteChanges(previous, next) {
  if (!previous || previous.mode !== next.mode || next.mode !== 'live-preview') return;
  const before = new Map(previous.pairs.map(p => [pairId(p.a, p.b), windowsAt(p, previous.slots.last).length]));
  grownPairs = new Set(next.pairs.filter(p => windowsAt(p, next.slots.last).length > (before.get(pairId(p.a, p.b)) ?? 0)).map(p => pairId(p.a, p.b)));
  grownUntil = Date.now() + 12000;
  setTimeout(() => { if (!player) render(); }, 12500); // clear the highlights
  const all = feed => [...feed.anchors, ...(feed.unservedAnchors ?? [])];
  const lastSequence = Math.max(0, ...all(previous).map(a => a.sequence));
  const fresh = all(next).filter(a => a.sequence > lastSequence).sort((a, b) => a.sequence - b.sequence);
  landedFrom = fresh.length ? fresh[0].sequence : Infinity;
  if (fresh.length) {
    const newest = fresh.at(-1);
    toast(`${fresh.length === 1 ? 'New anchor' : `${fresh.length} new anchors`} on Sepolia · #${newest.sequence} at block ${num(newest.block)}` +
      (grownPairs.size ? ` · ${plural(grownPairs.size, 'pair')} met again` : ''));
  } else if (grownPairs.size) toast(`New evidence published · ${plural(grownPairs.size, 'pair')} met again`);
}

function stop() { clearInterval(player); player = undefined; }
function goLive() { stop(); cursor = null; render(); }
function replay() {
  if (player) { stop(); render(); return; }
  const counts = activity(feed);
  const steps = counts.map((c, i) => c ? feed.slots.first + i : null).filter(s => s !== null);
  if (!steps.length) return;
  let i = cursor === null ? 0 : Math.max(0, steps.findIndex(s => s > cursor));
  cursor = steps[i];
  player = setInterval(() => {
    i++;
    if (i >= steps.length) { goLive(); return; }
    cursor = steps[i];
    render();
  }, Math.max(150, Math.min(900, 45000 / steps.length)));
  render();
}

let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 200); });

const touched = () => { lastInteraction = Date.now(); };
$('live').onclick = () => { touched(); goLive(); };
$('replay').onclick = () => { touched(); replay(); };
$('scrub').oninput = () => {
  touched(); stop();
  cursor = feed.slots.first + Number($('scrub').value);
  if (cursor === feed.slots.last) cursor = null;
  render();
};
addEventListener('keydown', event => {
  if (!feed) return;
  touched();
  if (event.key === ' ') { event.preventDefault(); replay(); }
  else if (event.key === 'l' || event.key === 'L') goLive();
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
    stop();
    const next = shownSlot() + (event.key === 'ArrowLeft' ? -1 : 1);
    cursor = Math.min(feed.slots.last, Math.max(feed.slots.first, next));
    if (cursor === feed.slots.last) cursor = null;
    render();
  }
});

// On a wall screen, a long key list scrolls itself one row at a time.
const keysBox = document.querySelector('.keys');
['wheel', 'touchstart', 'pointerdown'].forEach(type => keysBox.addEventListener(type, touched, { passive: true }));
setInterval(() => {
  if (!matchMedia('(min-width: 901px)').matches || Date.now() - lastInteraction < 20000) return;
  const overflow = keysBox.scrollHeight - keysBox.clientHeight;
  if (overflow <= 4) return;
  const row = $('keys').firstElementChild?.offsetHeight ?? 60;
  keysBox.scrollTo({ top: keysBox.scrollTop >= overflow - 4 ? 0 : keysBox.scrollTop + row, behavior: 'smooth' });
}, 4000);

async function poll() {
  try {
    const response = await fetch(FEED_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const next = await response.json();
    if (next.kind !== 'NON-CANONICAL' || next.version !== 1) throw new Error();
    if (!feed || next.generatedAt !== feed.generatedAt) {
      noteChanges(feed, next);
      feed = next;
      render();
    }
  } catch {
    if (!feed) {
      $('mode').textContent = 'NO FEED';
      $('banner').hidden = false;
      $('banner').textContent = `No feed yet: ${FEED_URL} could not be loaded.`;
    }
  }
  if (feed && live()) {
    try { const response = await fetch('status.json', { cache: 'no-store' }); status = response.ok ? await response.json() : undefined; }
    catch { status = undefined; }
  }
  renderBanner();
}
await poll();
if (!recordedView) setInterval(poll, POLL_MS);
setInterval(() => {
  if (!feed || player) return;
  if (AUTOPLAY_MS && cursor === null && Date.now() - lastInteraction > AUTOPLAY_MS) { lastInteraction = Date.now(); replay(); return; }
  if (cursor === null) renderHeader(frameAt(feed, feed.slots.last), feed.slots.last);
}, 30000);
