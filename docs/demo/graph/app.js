const $ = id => document.getElementById(id);
const allowed = new Set(['passed', 'credentialed_not_passed', 'excluded_duplicate', 'not_credentialed', 'no_qualifying_partner']);
let graph, index = 0, timer;
const controls = ['play', 'pause', 'step', 'reset', 'timeline'];
const el = (tag, className, text) => { const e = document.createElement(tag); if (className) e.className = className; if (text !== undefined) e.textContent = text; return e; };
const svg = (tag, attrs = {}, text) => { const e = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); if (text !== undefined) e.textContent = text; return e; };
function validate(data) {
  if (data?.kind !== 'NON-CANONICAL' || data.version !== 1 || !Array.isArray(data.frames) || !data.frames.length || data.frames.length > 4097 || !Array.isArray(data.nodes) || !data.nodes.length || data.nodes.length > 500) throw Error();
  for (const k of ['minPartners', 'minWindowsPerPartner', 'slotSeconds']) if (!Number.isSafeInteger(data.rule?.[k]) || data.rule[k] < 1) throw Error();
  const keys = new Set(data.nodes.map(n => n.address));
  if (keys.size !== data.nodes.length || [...keys].some(k => !/^0x[0-9a-fA-F]{40}$/.test(k))) throw Error();
  for (const [i, frame] of data.frames.entries()) {
    if (i === 0 ? frame.slot !== null : !Number.isSafeInteger(frame.slot) || (i > 1 && frame.slot !== data.frames[i - 1].slot + 1)) throw Error();
    if (!Array.isArray(frame.nodes) || frame.nodes.length !== keys.size || new Set(frame.nodes.map(n => n.address)).size !== keys.size || !Array.isArray(frame.edges)) throw Error();
    for (const n of frame.nodes) if (!keys.has(n.address) || !allowed.has(n.status) || typeof n.credentialed !== 'boolean' || !Number.isSafeInteger(n.qualifyingPartners) || !Number.isSafeInteger(n.partnerCount) || n.qualifyingPartners < 0 || n.partnerCount < 0 || (n.group !== undefined && typeof n.group !== 'string')) throw Error();
    for (const e of frame.edges) if (!keys.has(e.source) || !keys.has(e.target) || e.source === e.target || typeof e.counted !== 'boolean' || !Array.isArray(e.windows) || e.windows.some(w => !Number.isSafeInteger(w) || w > frame.slot)) throw Error();
  }
  return data;
}
function pause() { clearInterval(timer); timer = undefined; if (graph) { $('play').disabled = graph.frames.length < 2; $('pause').disabled = true; } }
function fail() {
  pause(); graph = undefined; $('scene').replaceChildren(); $('error').hidden = false;
  $('error').textContent = 'Could not load this graph. Choose a graph.json exported from recorded inputs.';
  $('result').textContent = 'No graph loaded'; $('slot-counter').textContent = 'UNAVAILABLE';
  controls.forEach(id => $(id).disabled = true);
}
function load(data) {
  pause(); graph = undefined;
  graph = validate(data); index = 0; $('error').hidden = true;
  $('timeline').max = graph.frames.length - 1; controls.forEach(id => $(id).disabled = false);
  $('partners').textContent = `N = ${graph.rule.minPartners}`; $('windows').textContent = `B = ${graph.rule.minWindowsPerPartner}`;
  $('length').textContent = `${graph.rule.slotSeconds / 60} MIN`;
  $('provenance').textContent = graph.provenance === 'recorded-synthetic' ? 'RECORDED SYNTHETIC DATA' : 'RECORDED LOCAL DATA';
  $('selection').textContent = 'Select a key to see its full address.';
  render();
}
function groupsFor(nodes) {
  const groups = new Map();
  for (const n of nodes) { const name = n.group || 'Event keys'; if (!groups.has(name)) groups.set(name, []); groups.get(name).push(n); }
  const membership = new Map(nodes.map(n => [n.address, n.group]));
  const crossGroup = graph.frames.some(f => f.edges.some(e => membership.get(e.source) !== membership.get(e.target)));
  if (groups.size > 3 || crossGroup || [...groups.values()].some(g => g.length > 3)) return new Map([['Event keys', nodes]]);
  const order = name => name === 'Honest attendees' ? 0 : name.startsWith('Mallory:') ? 1 : name.startsWith('Walk-in:') ? 2 : 3;
  return new Map([...groups].sort(([a], [b]) => order(a) - order(b)));
}
function render() {
  if (!graph) return;
  const frame = graph.frames[index], end = index === graph.frames.length - 1;
  $('timeline').value = index; $('slot-counter').textContent = `SLOT ${index} / ${graph.frames.length - 1}`;
  $('phase').textContent = index === 0 ? 'Before observations arrive' : end ? 'All recorded windows replayed' : `Window index ${frame.slot} · accumulating`;
  $('result').textContent = `${frame.nodes.filter(n => n.status === 'passed').length} of ${frame.nodes.length} keys pass`;
  $('play').disabled = Boolean(timer) || graph.frames.length < 2; $('pause').disabled = !timer; $('step').disabled = end;
  const groups = groupsFor(frame.nodes), generic = groups.size === 1;
  $('scene').classList.toggle('generic', generic); $('scene').replaceChildren();
  for (const [name, unordered] of groups) {
    const nodes = [...unordered].sort((a, b) => (a.member || 0) - (b.member || 0));
    const honest = name === 'Honest attendees', mallory = name.startsWith('Mallory:'), walk = name.startsWith('Walk-in:');
    const card = el('article', 'group');
    card.append(el('p', 'label', honest ? 'REPEATED ENCOUNTERS' : mallory ? 'ONE HUMAN · THREE PHONES' : walk ? 'NO QUALIFYING ENCOUNTERS' : 'RECORDED EVENT KEYS'));
    card.append(el('h2', '', honest ? 'Three participants' : mallory ? 'Mallory' : walk ? 'Walk-in' : name));
    card.append(el('p', 'sub', honest ? 'Three credentials. Two partners each.' : mallory ? 'Three keys. Only one credential.' : walk ? 'Credentialed. No mutual observations.' : `${nodes.length} keys · credentials fixed at snapshot cutoff`));
    $('scene').append(card);
    const compact = matchMedia('(min-width:1600px)').matches;
    const width = Math.max(280, card.clientWidth - 46), height = generic && width < 500 ? Math.ceil(nodes.length / 2) * 150 : compact ? 295 : 322;
    const picture = svg('svg', { class: 'graph', viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': `${name}: mutual encounters and key outcomes` });
    card.append(picture);
    const positions = new Map(nodes.map((n, i) => {
      let x, y;
      if (nodes.length === 1) { x = width / 2; y = 128; }
      else if (nodes.length === 3) { x = [width / 2, width * .21, width * .79][i]; y = compact ? [50, 185, 185][i] : [55, 210, 210][i]; }
      else { const columns = width < 500 ? 2 : Math.ceil(nodes.length / 2); x = (i % columns + .5) * width / columns; y = 55 + Math.floor(i / columns) * 150; }
      return [n.address, { x, y }];
    }));
    for (const edge of frame.edges) {
      const a = positions.get(edge.source), b = positions.get(edge.target); if (!a || !b) continue;
      const line = svg('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: `edge${edge.counted ? edge.windows.length >= graph.rule.minWindowsPerPartner ? ' complete' : '' : ' uncounted'}` });
      line.append(svg('title', {}, `${edge.windows.length} mutual windows${edge.counted ? '' : '; not counted: credential missing'}`)); picture.append(line);
    }
    for (const [i, n] of nodes.entries()) {
      const { x, y } = positions.get(n.address), pass = n.status === 'passed', failed = !pass && end;
      const group = svg('g', { class: `node${pass ? ' passed' : failed ? ' failed' : ''}`, transform: `translate(${x} ${y})`, 'data-status': n.status, tabindex: 0, role: 'button', 'aria-label': `${n.address}: ${n.status}, ${n.qualifyingPartners} qualifying partners` });
      const select = () => $('selection').textContent = `${n.address} · ${n.status.replaceAll('_', ' ')} · ${n.qualifyingPartners} qualifying partners`;
      group.addEventListener('click', select); group.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(); } });
      group.append(svg('title', {}, n.address), svg('circle', { r: 25 }), svg('text', { class: 'initial', y: 6 }, honest ? String.fromCharCode(65 + i) : mallory ? `M${i + 1}` : walk ? 'W' : String(i + 1)));
      const chip = pass ? 'PASS' : n.status === 'not_credentialed' ? 'NO CRED' : n.status === 'excluded_duplicate' ? 'DUPLICATE' : end ? 'FAIL' : 'PENDING';
      group.append(svg('rect', { class: 'chip', x: -51, y: 32, width: 102, height: 25 }), svg('text', { class: 'chiptext', y: 50 }, chip));
      group.append(svg('text', { class: 'key', y: 77 }, `${n.address.slice(0, 6)}…${n.address.slice(-4)}`));
      group.append(svg('text', { class: 'detail', y: 99 }, n.credentialed ? `${n.qualifyingPartners}/${graph.rule.minPartners} partners` : n.status === 'excluded_duplicate' ? 'excluded' : 'not counted'));
      picture.append(group);
    }
    const passed = nodes.filter(n => n.status === 'passed').length;
    const result = el('div', 'group-result'); result.append(el('strong', '', `${passed} / ${nodes.length}`), el('span', '', 'keys qualify')); card.append(result);
    const observedEdges = frame.edges.filter(e => positions.has(e.source) && positions.has(e.target));
    const maxWindows = Math.max(0, ...observedEdges.map(e => e.windows.length));
    card.append(el('p', 'group-note', honest ? `${maxWindows} / ${graph.rule.minWindowsPerPartner} windows per pair. ${passed ? 'All three meet the rule.' : 'Repeated encounters still needed.'}` : mallory ? 'Phone-to-phone edges exist. Without credentialed partners, none qualify.' : walk ? 'A credential alone does not meet the encounter rule.' : 'Solid lines count; dashed lines lack a credential.'));
  }
}
$('step').onclick = () => { pause(); if (graph && index < graph.frames.length - 1) { index++; render(); } };
$('reset').onclick = () => { pause(); index = 0; render(); };
$('pause').onclick = pause;
$('play').onclick = () => { if (!graph || graph.frames.length < 2) return; if (index === graph.frames.length - 1) index = 0; timer = setInterval(() => { index++; if (index >= graph.frames.length - 1) pause(); render(); }, 6500); render(); };
$('timeline').oninput = () => { pause(); index = Number($('timeline').value); render(); };
$('file').onchange = async event => { try { const file = event.target.files[0]; if (file) load(JSON.parse(await file.text())); } catch { fail(); } };
window.addEventListener('resize', () => render());
try { const response = await fetch('./graph.json'); if (!response.ok) throw Error(); load(await response.json()); } catch { fail(); }
