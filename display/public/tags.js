// Friendly, stable tags for event keys: an animal and a colour picked by hashing
// the event-key address, plus the first four hex digits of the address. The tag
// is only a rendering of the public key address; it carries no other identity.

export const ANIMALS = [
  ['🦊', 'Fox'], ['🐻', 'Bear'], ['🦉', 'Owl'], ['🐯', 'Tiger'], ['🦅', 'Eagle'], ['🐺', 'Wolf'],
  ['🦁', 'Lion'], ['🐼', 'Panda'], ['🦝', 'Raccoon'], ['🦌', 'Deer'], ['🐸', 'Frog'], ['🐙', 'Octopus'],
  ['🐧', 'Penguin'], ['🦒', 'Giraffe'], ['🐘', 'Elephant'], ['🦓', 'Zebra'], ['🐢', 'Turtle'], ['🐬', 'Dolphin'],
  ['🦈', 'Shark'], ['🦜', 'Parrot'], ['🐝', 'Bee'], ['🦋', 'Butterfly'], ['🐨', 'Koala'], ['🦔', 'Hedgehog'],
];
// Hues spread far apart so two keys stay distinguishable on a projector.
export const COLORS = [
  ['Blue', '#4d86ff'], ['Red', '#ff5a5a'], ['Green', '#34d399'], ['Gold', '#ffd23f'], ['Purple', '#b07cff'],
  ['Cyan', '#22d3ee'], ['Pink', '#ff7ad9'], ['Lime', '#a3e635'], ['Orange', '#ff9f43'], ['Silver', '#cbd5e1'],
];

// 32-bit FNV-1a over the lower-case address text.
export function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function tagFor(address) {
  const hash = fnv1a(address.toLowerCase());
  const [emoji, animal] = ANIMALS[hash % ANIMALS.length];
  const [colorName, color] = COLORS[Math.floor(hash / ANIMALS.length) % COLORS.length];
  const short = address.slice(2, 6).toUpperCase();
  return { emoji, animal, colorName, color, short, name: `${colorName} ${animal}`, label: `${colorName} ${animal} ${short}` };
}
