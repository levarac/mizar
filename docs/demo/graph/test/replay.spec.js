import { test, expect } from '@playwright/test';

test('replays mutual windows and human eligibility without external requests', async ({ page }) => {
  const external = [], errors = [];
  page.on('request', request => { if (!request.url().startsWith('http://127.0.0.1:4178/')) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 0 / 2');
  await expect(page.locator('.edge')).toHaveCount(0);
  await expect(page.locator('[data-status="passed"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 1 / 2');
  await expect(page.locator('.edge')).toHaveCount(6);
  await expect(page.locator('[data-status="passed"]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(page.locator('[data-status="passed"]')).toHaveCount(3);
  await expect(page.locator('[data-status="not_credentialed"]')).toHaveCount(2);
  await expect(page.locator('[data-status="no_qualifying_partner"]')).toHaveCount(1);
  await expect(page.locator('#result')).toHaveText('3 of 7 keys pass');
  await page.getByRole('button', { name: 'Reset', exact: true }).click();
  await page.clock.install();
  await page.getByRole('button', { name: 'Play', exact: true }).click();
  await page.clock.runFor(6500);
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 1 / 2');
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.clock.runFor(7000);
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 1 / 2');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('accepts another local graph and shows errors instead of stale success', async ({ page }) => {
  await page.goto('/');
  await page.locator('#file').setInputFiles('dist/default-graph.json');
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 0 / 99');
  await page.locator('#timeline').fill('99');
  await page.locator('#timeline').dispatchEvent('input');
  await expect(page.locator('[data-status="passed"]')).toHaveCount(4);
  await expect(page.locator('[data-status="excluded_duplicate"]')).toHaveCount(2);
  await page.locator('#file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
  await expect(page.getByRole('alert')).toContainText('Could not load');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(page.locator('#scene')).toBeEmpty();
});

test('fits a phone and respects reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 1 / 2');
});

test('a graph with no observation windows remains a usable static result', async ({ page }) => {
  await page.goto('/');
  const data = await page.evaluate(async () => (await fetch('./graph.json')).json());
  data.frames = [data.frames[0]];
  data.nodes = data.frames[0].nodes;
  data.edges = [];
  await page.locator('#file').setInputFiles({ name: 'empty-windows.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  await expect(page.locator('#slot-counter')).toHaveText('SLOT 0 / 0');
  await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Step', exact: true })).toBeDisabled();
  await expect(page.locator('.node')).toHaveCount(7);
});

test('focus outlines and dashed edges have at least 3:1 rendered contrast', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Step', exact: true }).click();
  await page.keyboard.press('Tab');
  await expect(page.locator('#reset')).toBeFocused();
  const contrast = await page.evaluate(() => {
    const rgb = color => color.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = color => color.map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, channel, i) => sum + channel * [0.2126, 0.7152, 0.0722][i], 0);
    const background = rgb(getComputedStyle(document.documentElement).backgroundColor);
    const ratio = (foreground, opacity = 1) => {
      const blended = rgb(foreground).map((channel, i) => channel * opacity + background[i] * (1 - opacity));
      return (luminance(background) + 0.05) / (luminance(blended) + 0.05);
    };
    const focus = getComputedStyle(document.activeElement);
    const edge = getComputedStyle(document.querySelector('.edge.uncounted'));
    return { focus: ratio(focus.outlineColor), edge: ratio(edge.stroke, Number(edge.opacity)), focusWidth: focus.outlineWidth };
  });
  expect(contrast.focusWidth).toBe('3px');
  expect(contrast.focus).toBeGreaterThanOrEqual(3);
  expect(contrast.edge).toBeGreaterThanOrEqual(3);
});
