// Minimal static server for dist/ (page, fonts and the feed files).
// Bind to 0.0.0.0 with --host to reach it from a phone on the same network.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
  '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8' };
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; font-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

export function startServer({ root, host = '127.0.0.1', port = 4180 }) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      const path = resolve(base, '.' + pathname.replace(/\/$/, '/index.html'));
      if (!path.startsWith(base + sep)) { res.writeHead(403).end(); return; }
      const body = await readFile(path);
      res.writeHead(200, { ...headers, 'Content-Type': types[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch { res.writeHead(404, headers).end('Not found'); }
  });
  server.listen(port, host, () => console.log(`Display listening on http://${host}:${port}/`));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
  startServer({ root: arg('root', resolve(dirname(fileURLToPath(import.meta.url)), 'dist')),
    host: arg('host', '127.0.0.1'), port: Number(arg('port', 4180)) });
}
