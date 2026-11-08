// Use the Insert palette to build a screen from patterns, then inspect a component's props.
// usage: node scripts/palette-shots.mjs <baseUrl> <outDir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [base, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
const r = {};
await p.goto(base + 'editor/');
await p.waitForSelector('.canvas');
await p.getByRole('button', { name: /Insert/ }).click();
await p.waitForSelector('.palette');
r.entries = await p.locator('.palette-item').count();
await p.screenshot({ path: join(out, 'q1-palette.png') });
await p.locator('.palette input').fill('page header');
await p.keyboard.press('Enter');
await p.waitForSelector('.layer');
await p.waitForTimeout(300);
// select the created header frame, then add a table inside the same parent via search
await p.getByRole('button', { name: /Insert/ }).click();
await p.locator('.palette input').fill('table');
r.tableMatches = await p.locator('.palette-item').count();
await p.locator('.palette-item', { hasText: 'Data table' }).first().click();
await p.waitForTimeout(600);
r.layers = await p.locator('.layer').count();
// inspect a component's props
await p.locator('[data-rid]').filter({ has: p.locator('nav') }).first().click({ force: true }).catch(() => undefined);
await p.locator('.rc-Pagination').first().click();
await p.waitForTimeout(300);
r.inspector = await p.locator('.inspector-title').textContent();
r.propsShown = await p.locator('.row-label').allTextContents();
await p.getByRole('button', { name: 'Fit' }).click();
await p.waitForTimeout(300);
await p.screenshot({ path: join(out, 'q2-built.png') });
r.errors = errors;
console.log(JSON.stringify(r, null, 2));
await b.close();
