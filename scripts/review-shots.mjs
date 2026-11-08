// Visual + behavioural check of Phase 3 (review & collaboration) in system Edge.
// usage: node scripts/review-shots.mjs <baseUrl> <outDir> <viewerUrlOnLan?>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:4455/';
const out = process.argv[3] ?? '.shots';
const viewerUrl = process.argv[4];
await mkdir(out, { recursive: true });
const H = { 'content-type': 'application/json' };
const api = (p, b, name) => fetch(base + p, { method: 'POST', headers: { ...H, ...(name ? { 'x-rangoli-name': name } : {}) }, body: JSON.stringify(b) }).then((r) => r.json());

// seed: a suggestion (as if from the agent/reviewer), a review finding with a fix, an @agent comment
await api('api/changesets', { script: 'set #n8 "Run now"\nset #n7 variant=ghost', label: 'Clearer primary action label' }, 'Darshana');
await api('api/threads', { node: 'nd', body: 'Table border + header fill feels heavy; spacing alone separates rows.', kind: 'review', severity: 'P2', fix: 'set #nd stroke:none', title: 'Darshana review' }, 'Darshana');
await api('api/threads', { node: 'n4', body: '@agent can the title be more specific to nightly runs?' }, 'Asha');
await api('api/versions', { name: 'Before review' });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(base + 'editor/');
await page.waitForSelector('.layer');
await page.waitForTimeout(400);
const pins = await page.locator('.pin').count();
await page.screenshot({ path: join(out, '7-pins.png') });

await page.getByRole('tab', { name: /Review/ }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '8-review-panel.png') });

await page.locator('.cs').first().getByRole('button', { name: 'Compare' }).click();
await page.waitForTimeout(400);
const compareSummary = await page.locator('.compare-bar .hint').textContent();
await page.screenshot({ path: join(out, '9-compare.png') });

await page.locator('.cs').first().getByRole('button', { name: 'Accept' }).click();
await page.waitForTimeout(500);
const compareClosed = (await page.locator('.compare').count()) === 0;
const btnText = await page.locator('button[data-rid="n8"]').textContent();

// click the review pin → thread focused; apply its fix
await page.locator('.pin-P2').click();
await page.waitForTimeout(250);
const focused = await page.locator('.thread.is-focus').count();
await page.locator('.thread.is-focus').getByRole('button', { name: 'Apply fix' }).click();
await page.waitForTimeout(500);
const tableStroke = await (await fetch(base + 'api/doc')).json().then((d) => JSON.stringify(d.data.pages.p1.nodes.nd.style?.stroke ?? null));
await page.screenshot({ path: join(out, '10-after-fix.png') });

let viewer = null;
if (viewerUrl) {
  const vctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const vp = await vctx.newPage();
  await vp.goto(viewerUrl);
  await vp.waitForSelector('.layer');
  await vp.waitForTimeout(300);
  viewer = {
    badge: await vp.locator('.role-badge').textContent(),
    insertVisible: await vp.getByRole('button', { name: /Insert/ }).count(),
    presenceSeenByOwner: null,
  };
  await page.waitForTimeout(300);
  viewer.presenceSeenByOwner = await page.locator('.presence .who').allTextContents();
  await vp.getByRole('tab', { name: /Review/ }).click();
  viewer.composer = await vp.locator('.composer').count();
  await vp.screenshot({ path: join(out, '11-viewer.png') });
  await vctx.close();
}

console.log(JSON.stringify({ pins, compareSummary, compareClosed, btnText, focused, tableStroke, viewer, errors }, null, 2));
await browser.close();
