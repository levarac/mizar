import { chromium, expect } from '@playwright/test';
import { mkdir, writeFile, copyFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || '/private/tmp/graph-viz-out');
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ['serve.mjs'], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw Error('Preview server could not start'); })]);
  browser = await chromium.launch({ channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4178/')) external.push(request.url()); });
  await page.goto('http://127.0.0.1:4178/');
  await page.evaluate(() => document.fonts.ready);
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 0 / 2');
  const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, contentWidth: document.documentElement.scrollWidth, contentHeight: document.documentElement.scrollHeight }));
  console.log(JSON.stringify(dimensions));
  const stills = ['p5-still-01-before.png', 'p5-still-02-first-window.png', 'p5-still-03-result.png'];
  await page.screenshot({ path: join(out, stills[0]) });
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.mouse.move(1919, 1079);
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 1 / 2', { timeout: 10000 });
  await page.screenshot({ path: join(out, stills[1]) });
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 2 / 2', { timeout: 10000 });
  await expect(page.locator('[data-status="passed"]')).toHaveCount(3);
  await page.screenshot({ path: join(out, stills[2]) });
  await copyFile(join(out, stills[2]), join(out, 'p5-graph-replay-closing.png'));
  if (errors.length || external.length || dimensions.contentHeight > 1080 || dimensions.contentWidth > 1920) throw Error(JSON.stringify({ errors, external, dimensions }));
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: join(out, 'graph-mobile.png'), fullPage: true });
  await browser.close(); browser = undefined;
  const inputs = stills.flatMap((file, i) => ['-loop', '1', '-framerate', '30', '-t', String(i === 2 ? 8 : 6.5), '-i', join(out, file)]);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...inputs,
    '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0,format=yuv420p[v]', '-map', '[v]',
    '-t', '21', '-c:v', 'libx264', '-preset', 'medium', '-crf', '16', '-movflags', '+faststart', '-an', join(out, 'p5-graph-replay.mp4')], { stdio: 'inherit' });
  const metadata = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height,codec_type:format=duration', '-of', 'json', join(out, 'p5-graph-replay.mp4')], { encoding: 'utf8' });
  await writeFile(join(out, 'capture-evidence.json'), JSON.stringify({ dimensions, errors, external, video: JSON.parse(metadata) }, null, 2) + '\n');
  if (Math.abs(Number(JSON.parse(metadata).format.duration) - 21) > 0.05) throw Error('Unexpected video duration');
  console.log(metadata);
} finally { await browser?.close(); server.kill(); }
