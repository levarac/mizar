import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANIMALS, COLORS, tagFor } from '../public/tags.js';
import { activity, encountersIn, nodeAt } from '../public/model.js';
import { ringOrder, ringPositions } from '../public/layout.js';

test('tags are stable, case-insensitive and show only four hex digits', () => {
  const address = '0x2F4dCFD5b3a9863c91F9c47B3e55446B6f4B5F48';
  const tag = tagFor(address);
  assert.deepEqual(tagFor(address.toLowerCase()), { ...tag, short: '2F4D', label: tag.label });
  assert.equal(tag.short, '2F4D');
  assert.equal(tag.name, `${tag.colorName} ${tag.animal}`);
  assert.ok(!tag.label.includes(address.slice(6)));
});

test('tags spread over every animal and colour', () => {
  const animals = new Set(), colors = new Set();
  for (let i = 0; i < 2000; i++) {
    const tag = tagFor('0x' + i.toString(16).padStart(40, '0'));
    animals.add(tag.animal); colors.add(tag.colorName);
  }
  assert.equal(animals.size, ANIMALS.length);
  assert.equal(colors.size, COLORS.length);
});

test('node state follows the last change at or before the slot', () => {
  const key = { address: '0xA', credentialed: true, changes: [[null, 'no_qualifying_partner', 0, 0, 'too_few_partners'],
    [5, 'credentialed_not_passed', 1, 1, 'too_few_partners'], [8, 'passed', 2, 2, null]] };
  assert.equal(nodeAt(key, null).status, 'no_qualifying_partner');
  assert.equal(nodeAt(key, 4).status, 'no_qualifying_partner');
  assert.equal(nodeAt(key, 7).qualifyingPartners, 1);
  assert.equal(nodeAt(key, 9).status, 'passed');
});

test('activity counts pairs that gained a window in each slot', () => {
  const feed = { slots: { first: 10, last: 13 }, pairs: [
    { a: '0xA', b: '0xB', counted: true, changes: [[10, [10], []], [12, [12], []]] },
    { a: '0xA', b: '0xC', counted: false, changes: [[12, [12], []], [13, [], [12]]] },
  ] };
  assert.deepEqual(activity(feed), [1, 0, 2, 0]);
  assert.deepEqual(encountersIn(feed, 12).map(p => p.b), ['0xB', '0xC']);
});

test('ring order keeps earlier keys in place and seats new keys by their strongest partner', () => {
  const weights = new Map([['A', new Map([['B', 5], ['D', 1]])], ['B', new Map([['A', 5], ['C', 3]])],
    ['C', new Map([['B', 3]])], ['D', new Map([['A', 1], ['E', 4]])], ['E', new Map([['D', 4]])]]);
  const first = ringOrder(['A', 'B', 'C', 'Z'], weights);
  assert.deepEqual(first, ['B', 'A', 'C', 'Z']);
  const next = ringOrder(['A', 'B', 'C', 'D', 'E', 'Z'], weights, first);
  assert.deepEqual(next.filter(k => first.includes(k)), first);
  assert.equal(next[next.indexOf('A') + 1], 'D');
});

test('ring positions stay inside the box and apart', () => {
  const order = Array.from({ length: 12 }, (_, i) => `K${i}`);
  const positions = [...ringPositions(order, { width: 1300, height: 800, margin: 112 }).values()];
  for (const p of positions) assert.ok(p.x > 0 && p.x < 1300 && p.y > 0 && p.y < 800);
  for (let i = 0; i < positions.length; i++) for (let j = i + 1; j < positions.length; j++)
    assert.ok(Math.hypot(positions[i].x - positions[j].x, positions[i].y - positions[j].y) > 150);
});
