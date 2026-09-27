import { activity, frameAt, slotStart } from './model.js';
import { tagFor } from './tags.js';

const $ = id => document.getElementById(id);
const SVG_NS = 'http://www.w3.org/2000/svg';
const POLL_MS = 15000;
const STALE_MS = 8 * 60 * 1000;
const params = new URLSearchParams(location.search);
if (params.get('theme') === 'light') document.documentElement.dataset.theme = 'light';

let feed, status, cursor = null, player;

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
const slotText = slot => `${clock.format(slotStart(feed, slot))}–${clock.format(slotStart(feed, slot + 1))}`;
const shownSlot = () => cursor ?? feed.slots.last;
// Time of day, with the date when it is not the day of the feed's cutoff.
const moment = ms => dayFormat.format(ms) === dayFormat.format(feed.cutoff.timestamp * 1000)
  ? clock.format(ms) : `${dayFormat.format(ms)} ${clock.format(ms)}`;
const lower = value => value.toLowerCase();

const STATUS = {
  passed: 'Meets the rule',
  credentialed_not_passed: 'Meeting people',
  no_qualifying_partner: 'No encounters yet',
  not_credentialed: 'No human check',
  excluded_duplicate: 'Duplicate human check',
};

function layout(keys) {
  const positions = new Map(), cx = 500, cy = 390;
  const radius = keys.length < 3 ? 220 : Math.min(320, 150 + keys.length * 22);
  keys.forEach((key, i) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * i) / keys.length;
    positions.set(key.address, keys.length === 1 ? { x: cx, y: cy }
      : { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) * 0.92 });
  });
  return positions;
}

function renderGraph(frame, slot) {
  const picture = $('graph');
  picture.replaceChildren();
  const positions = layout(feed.keys);
  const minWindows = feed.rule.minWindowsPerPartner;
  const edges = svg('g', { class: 'edges' }), nodes = svg('g', { class: 'nodes' });
  for (const edge of frame.edges) {
    const a = positions.get(edge.source), b = positions.get(edge.target);
    const kind = !edge.counted ? 'uncounted' : edge.windows.length >= minWindows ? 'complete' : 'progress';
    const fresh = edge.windows.includes(slot);
    const width = edge.counted ? Math.min(3 + edge.windows.length, 12) : 2.5;
    const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge ${kind}${fresh ? ' fresh' : ''}`, 'stroke-width': width });
    line.append(svg('title', {}, `${tagFor(edge.source).label} ↔ ${tagFor(edge.target).label}: ${edge.windows.length} slot${edge.windows.length === 1 ? '' : 's'} together`));
    edges.append(line);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    edges.append(svg('text', { x: mx, y: my + 7, class: `edge-count ${kind}` }, String(edge.windows.length)));
  }
  const active = new Set(frame.edges.flatMap(e => [e.source, e.target]));
  for (const node of frame.nodes) {
    const { x, y } = positions.get(node.address), tag = tagFor(node.address);
    const quiet = !active.has(node.address) && node.status !== 'passed';
    const g = svg('g', { class: `node ${node.status}${quiet ? ' quiet' : ''}`, transform: `translate(${x} ${y})` });
    g.append(svg('title', {}, `${tag.label} · ${node.address} · ${STATUS[node.status]}`));
    if (node.status === 'passed') g.append(svg('circle', { r: 62, class: 'halo' }));
    g.append(svg('circle', { r: 46, class: 'disc', fill: tag.color, stroke: tag.color }));
    g.append(svg('text', { y: 16, class: 'emoji' }, tag.emoji));
    g.append(svg('text', { y: 80, class: 'name' }, tag.name));
    g.append(svg('text', { y: 104, class: 'short' }, tag.short));
    if (!node.credentialed) g.append(svg('text', { y: 128, class: 'flag' }, 'NO HUMAN CHECK'));
    else if (node.status === 'passed') g.append(svg('text', { y: 128, class: 'flag pass' }, '✓ MEETS RULE'));
    nodes.append(g);
  }
  picture.append(edges, nodes);
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
    const tag = tagFor(node.address), key = feed.keys.find(k => k.address === node.address);
    const item = el('li', `key ${node.status}`);
    const avatar = el('span', 'avatar', tag.emoji);
    avatar.style.borderColor = tag.color;
    const who = el('span', 'who');
    who.append(el('b', '', tag.name), el('code', '', tag.short));
    const human = el('span', `human ${node.credentialed ? 'yes' : 'no'}`,
      node.credentialed ? `✓ human check${key.verifiedAt ? ' ' + moment(Date.parse(key.verifiedAt)) : ''}` : '✗ no human check');
    const progress = el('span', 'progress');
    const partners = partnersOf(node.address, frame);
    const pips = el('span', 'pips');
    for (let i = 0; i < feed.rule.minPartners; i++) pips.append(el('i', i < node.qualifyingPartners ? 'on' : ''));
    progress.append(pips, el('span', '', `${node.qualifyingPartners}/${feed.rule.minPartners} partners`));
    const detail = el('span', 'partners');
    for (const p of partners.slice(0, 4)) {
      const pill = el('span', `pill${p.windows >= feed.rule.minWindowsPerPartner ? ' ok' : ''}`, `${tagFor(p.address).emoji} ${p.windows}`);
      pill.title = `${tagFor(p.address).label}: ${p.windows} slot${p.windows === 1 ? '' : 's'} together`;
      detail.append(pill);
    }
    const state = el('span', 'state', STATUS[node.status]);
    if (posted.has(lower(node.address))) state.append(el('small', '', `in posted snapshot ${feed.posted.snapshotId}`));
    item.append(avatar, who, human, progress, detail, state);
    list.append(item);
  }
}

function renderAnchors(slot) {
  const list = $('anchors');
  list.replaceChildren();
  const until = cursor === null ? Infinity : slotStart(feed, slot + 1) / 1000;
  const shown = feed.anchors.filter(a => a.committedAt <= until);
  $('anchors-note').textContent = `${num(shown.length)} commitments`;
  for (const anchor of shown.slice(-6).reverse()) {
    const item = el('li', `anchor${anchor.afterCutoff ? ' after' : ''}`);
    item.append(el('b', '', `#${anchor.sequence}`), el('span', 'block', `block ${num(anchor.block)}`),
      el('span', 'when', clockSeconds.format(anchor.committedAt * 1000)),
      el('span', 'what', `${anchor.observations} obs${anchor.slots ? ` · ${anchor.slots[0] === anchor.slots[1]
        ? clock.format(slotStart(feed, anchor.slots[0])) : `${clock.format(slotStart(feed, anchor.slots[0]))}–${clock.format(slotStart(feed, anchor.slots[1] + 1))}`}` : ''}`));
    if (anchor.afterCutoff) item.title = 'Anchored after this preview\'s cutoff; counted on the next refresh.';
    list.append(item);
  }
}

function renderTimeline(slot) {
  const counts = activity(feed), bars = $('bars');
  bars.replaceChildren();
  if (!counts.length) return;
  const max = Math.max(1, ...counts);
  const chart = svg('svg', { viewBox: `0 0 ${counts.length} 40`, preserveAspectRatio: 'none' });
  counts.forEach((count, i) => {
    if (count) chart.append(svg('rect', { x: i, y: 40 - (4 + 36 * count / max), width: 1, height: 4 + 36 * count / max, class: 'bar' }));
  });
  chart.append(svg('rect', { x: slot - feed.slots.first, y: 0, width: 1, height: 40, class: 'cursor' }));
  bars.append(chart);
  const scrub = $('scrub');
  scrub.max = String(counts.length - 1);
  scrub.value = String(slot - feed.slots.first);
  const first = slotStart(feed, feed.slots.first), last = slotStart(feed, feed.slots.last + 1);
  $('slot-range').textContent = `${dayFormat.format(first)} ${clock.format(first)} → ${dayFormat.format(last)} ${clock.format(last)}`;
}

function renderHeader(frame, slot) {
  const passed = frame.nodes.filter(n => n.status === 'passed').length;
  $('stat-keys').textContent = num(frame.nodes.length);
  $('stat-human').textContent = num(frame.nodes.filter(n => n.credentialed).length);
  $('stat-pairs').textContent = num(frame.edges.length);
  $('stat-pass').textContent = num(passed);
  const live = feed.mode === 'live-preview';
  $('mode').textContent = cursor !== null ? `REPLAY ${clock.format(slotStart(feed, slot))}`
    : live ? 'LIVE PREVIEW' : `RECORDED · SNAPSHOT ${feed.posted?.snapshotId ?? ''}`.trim();
  $('mode').className = `chip mode ${cursor !== null ? 'replay' : live ? 'live' : 'recorded'}`;
  const newestEnd = slotStart(feed, feed.slots.last + 1);
  $('lag').textContent = live ? `newest slot ended ${Math.max(0, Math.round((Date.now() - newestEnd) / 60000))} min ago`
    : `cutoff ${dayFormat.format(feed.cutoff.timestamp * 1000)} ${clock.format(feed.cutoff.timestamp * 1000)}`;
  $('event').textContent = `Demo event ${shortHex(feed.event.id)} · Sepolia · slots are ${feed.rule.slotSeconds / 60} min · times in ${zone}`;
  $('slot-now').textContent = `${cursor === null ? 'Newest slot' : 'Slot'} ${dayFormat.format(slotStart(feed, slot))} ${slotText(slot)}`;
  $('rule-text').textContent = `Meet ${feed.rule.minPartners} human-checked people, each in ${feed.rule.minWindowsPerPartner} different ${feed.rule.slotSeconds / 60}‑minute slots.`;
  $('keys-note').textContent = cursor === null ? '' : 'at this slot';
}

function renderHonesty() {
  const footer = $('honest');
  footer.replaceChildren();
  const live = feed.mode === 'live-preview', posted = feed.posted;
  const lines = [];
  if (live) lines.push(['Minutes behind.', `An observation appears only after the operator anchors it on Sepolia, every few minutes. Feed refreshed ${clockSeconds.format(Date.parse(feed.generatedAt))} at block ${num(feed.cutoff.block)}.`]);
  else lines.push(['Recorded, not live.', `Evaluation archive of snapshot ${posted?.snapshotId}, cutoff block ${num(feed.cutoff.block)}.`]);
  lines.push(['Keys and time slots only.', 'The public log has event keys and 5-minute slots. No names, no locations. Animal tags are derived from the key address.']);
  if (posted) {
    const chain = posted.rootPosted === 'matches' ? ' Its RootPosted event on Sepolia matches the archive.'
      : posted.rootPosted === 'differs' ? ' Warning: its RootPosted event on Sepolia differs from the archive.' : '';
    lines.push([live ? 'Rule status is a preview.' : 'Posted snapshot.',
      `${live ? `Computed at block ${num(feed.cutoff.block)}; it is not posted. ` : ''}Only snapshot ${posted.snapshotId} is posted on chain: root ${shortHex(posted.root)}, cutoff block ${num(posted.cutoffBlock)}, ${posted.eligible.length} keys.${chain}`]);
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
  const live = feed?.mode === 'live-preview';
  const age = feed ? Date.now() - Date.parse(feed.generatedAt) : 0;
  const failing = status && status.ok === false;
  if (live && (age > STALE_MS || failing)) {
    banner.hidden = false;
    banner.textContent = `Feed is behind: last successful refresh ${clockSeconds.format(Date.parse(feed.generatedAt))}` +
      `${failing ? ' (retrying)' : ''}. Showing the last good data.`;
  } else banner.hidden = true;
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
    cursor = steps[i]; render();
  }, Math.max(150, Math.min(900, 40000 / steps.length)));
  render();
}

$('live').onclick = goLive;
$('replay').onclick = replay;
$('scrub').oninput = () => { stop(); cursor = feed.slots.first + Number($('scrub').value); if (cursor === feed.slots.last) cursor = null; render(); };
addEventListener('keydown', event => {
  if (!feed) return;
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

async function poll() {
  try {
    const response = await fetch('live.json', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const next = await response.json();
    if (next.kind !== 'NON-CANONICAL' || next.version !== 1) throw new Error();
    if (!feed || next.generatedAt !== feed.generatedAt) { feed = next; render(); }
  } catch {
    if (!feed) { $('mode').textContent = 'NO FEED'; $('banner').hidden = false; $('banner').textContent = 'No feed yet: live.json could not be loaded.'; }
  }
  try { const response = await fetch('status.json', { cache: 'no-store' }); status = response.ok ? await response.json() : undefined; }
  catch { status = undefined; }
  renderBanner();
}
await poll();
setInterval(poll, POLL_MS);
setInterval(() => { if (feed && cursor === null && !player) renderHeader(frameAt(feed, feed.slots.last), feed.slots.last); }, 30000);
