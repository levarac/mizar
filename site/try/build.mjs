// Assembles dist/: the hand-written page, the shared Inter font files and the
// evaluation graph replay (built from docs/demo/graph when its dist is missing).
// QR placeholders in index.html are rendered to inline SVG here, so the page
// makes no request for them.
import { cp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import QRCode from 'qrcode';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const out = resolve(here, 'dist');
const graphDist = resolve(root, 'docs/demo/graph/dist');

const exists = (p) => stat(p).then(() => true, () => false);

if (!(await exists(resolve(graphDist, 'index.html')))) {
  execFileSync(process.execPath, [resolve(root, 'docs/demo/graph/build.mjs')], { stdio: 'inherit' });
}

await rm(out, { recursive: true, force: true });
await cp(resolve(here, 'public'), out, { recursive: true });
await cp(resolve(root, 'web/public/fonts'), resolve(out, 'fonts'), { recursive: true });
await cp(graphDist, resolve(out, 'graph'), { recursive: true });
const page = resolve(out, 'index.html');
const placeholder = /<div class="qr" data-qr="([^"]+)" aria-hidden="true"><\/div>/g;
const html = await readFile(page, 'utf8');
const urls = [...html.matchAll(placeholder)].map((m) => m[1]);
const svgs = new Map();
for (const url of urls) {
  const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#014EFE', light: '#FEFFFB' } });
  svgs.set(url, svg.trim());
}
await writeFile(page, html.replace(placeholder, (_, url) => `<div class="qr" aria-hidden="true">${svgs.get(url)}</div>`));
console.log(`Static build: ${out}; ${urls.length} QR codes`);
