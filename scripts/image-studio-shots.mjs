// Drive Image Studio in system Edge: upload, edit to a new asset, compose + export.
// usage: node scripts/image-studio-shots.mjs <baseUrl> <outDir> <imageFile>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [base, out, file] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const r = {};
await p.goto(base + 'editor/');
await p.waitForSelector('.layer');
await p.getByRole('radio', { name: 'Images' }).click();
await p.waitForSelector('.studio-left');

await p.locator('input[type=file]').setInputFiles(file);
await p.waitForSelector('.asset-tile.is-sel', { timeout: 15000 });
r.assets = await p.locator('.asset-tile').count();
r.title = await p.locator('.inspector-title').textContent();

await p.getByRole('button', { name: '16:9' }).click();
await p.locator('.row', { hasText: 'Width' }).locator('input').fill('640');
await p.locator('.row', { hasText: 'saturation' }).locator('input[type=range]').fill('0.6');
await p.waitForTimeout(250);
r.crop = await p.locator('.crop-box').count();
r.resultHint = await p.locator('.props .hint', { hasText: 'Result:' }).textContent();
await p.screenshot({ path: join(out, 'm1-edit.png') });

await p.getByRole('button', { name: 'Save as new asset' }).click();
await p.waitForFunction(() => document.querySelectorAll('.asset-tile').length === 2, null, { timeout: 15000 });
await p.waitForTimeout(300);
r.newTitle = await p.locator('.inspector-title').textContent();
r.newMeta = await p.locator('.asset-tile.is-sel .asset-meta').textContent();

// composition from template + export endpoint
await p.getByRole('button', { name: 'New', exact: true }).click();
await p.waitForSelector('.comp-row.is-sel');
await p.waitForTimeout(400);
await p.screenshot({ path: join(out, 'm2-comp.png') });
const href = await p.getByRole('link', { name: 'Open image' }).getAttribute('href');
const img = await fetch(new URL(href, base));
r.export = { status: img.status, type: img.headers.get('content-type'), bytes: (await img.arrayBuffer()).byteLength };
r.errors = errors;
console.log(JSON.stringify(r, null, 2));
await b.close();
