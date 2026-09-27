// Friendly, stable tags for event keys: an animal and a colour picked by hashing
// the event-key address, plus the first four hex digits of the address. The tag
// is only a rendering of the public key address; it carries no other identity.

export const ANIMALS = [
  ['🦊', 'Fox'], ['🐻', 'Bear'], ['🦉', 'Owl'], ['🐯', 'Tiger'], ['🦅', 'Eagle'], ['🐺', 'Wolf'],
  ['🦁', 'Lion'], ['🐼', 'Panda'], ['🦝', 'Raccoon'], ['🦌', 'Deer'], ['🐸', 'Frog'], ['🐙', 'Octopus'],
  ['🐧', 'Penguin'], ['🦒', 'Giraffe'], ['🐘', 'Elephant'], ['🦓', 'Zebra'], ['🐢', 'Turtle'], ['🐬', 'Dolphin'],
  ['🦈', 'Shark'], ['🦜', 'Parrot'], ['🐝', 'Bee'], ['🦋', 'Butterfly'], ['🐨', 'Koala'], ['🦔', 'Hedgehog'],
];
export const COLORS = [
  ['Blue', '#4d86ff'], ['Coral', '#ff6b5e'], ['Mint', '#34d399'], ['Amber', '#f5b83d'], ['Violet', '#a78bfa'],
  ['Teal', '#22c3c9'], ['Rose', '#f472b6'], ['Lime', '#a3e635'], ['Orange', '#fb923c'], ['Sky', '#7dd3fc'],
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
