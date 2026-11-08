// Visual smoke test of the editor using the system Edge (no browser download).
// usage: node scripts/editor-shots.mjs <baseUrl> <outDir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://127.0.0.1:4455/';
const out = process.argv[3] ?? '.shots';
await mkdir(out, { recursive: true });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));

await page.goto(base + 'editor/');
await page.waitForSelector('.layer', { timeout: 10000 });
await page.waitForTimeout(300);
await page.screenshot({ path: join(out, '1-editor.png') });

// select a table row in the canvas (shadow DOM)
const row = page.locator('[data-rid="n12"]').first();
await row.click();
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '2-selected.png') });

// edit via inspector: switch the row's chip? just change gap through Design tab of selected row
const selectedLabel = await page.locator('.inspector-title').textContent();

// dark mode
await page.getByRole('radio', { name: 'Dark' }).click();
await page.waitForTimeout(200);
await page.screenshot({ path: join(out, '3-dark.png') });

// tokens + lint tabs
await page.getByRole('tab', { name: 'Tokens' }).click();
await page.waitForTimeout(150);
await page.screenshot({ path: join(out, '4-tokens.png') });

// --- editing: select the "3 failed" chip via layers search in canvas and switch variant in the inspector
await page.getByRole('radio', { name: 'Light' }).click();
await page.getByRole('tab', { name: 'Inspect' }).click();
const chip = page.locator('[data-rid]', { hasText: '3 failed' }).last();
await chip.click();
await page.waitForTimeout(150);
await page.getByRole('radio', { name: 'warning' }).click();
await page.waitForTimeout(400);
const chipVariant = await chip.getAttribute('data-variant');

// --- external change (like an agent) shows up live without reload
await fetch(base + 'api/rdl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script: 'set #n4 "Test runs · live"', label: 'external edit' }) });
await page.waitForTimeout(500);
const liveTitle = await page.locator('[data-rid="n4"]').textContent();
await page.screenshot({ path: join(out, '5-edited.png') });

// --- undo twice via keyboard restores original
await page.locator('.canvas').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Control+z');
await page.waitForTimeout(300);
await page.keyboard.press('Control+z');
await page.waitForTimeout(400);
const afterUndo = await page.locator('[data-rid="n4"]').textContent();
const chipAfterUndo = await page.locator('[data-rid]', { hasText: '3 failed' }).last().getAttribute('data-variant');
const zoom = await page.locator('.zoom-val').textContent();

// --- motion tab: apply "modal" preset to the table, play enter mid-animation, check hover transition on a button
await page.locator('.layer', { hasText: 'Table' }).first().click();
await page.getByRole('tab', { name: 'Motion' }).click();
await page.locator('.chip-btn', { hasText: 'modal' }).click();
await page.waitForTimeout(400);
await page.screenshot({ path: join(out, '6-motion-tab.png') });
await page.getByRole('button', { name: '▶ Enter' }).click();
await page.waitForTimeout(60);
const midOpacity = await page.locator('[data-rid="nd"]').first().evaluate((el) => getComputedStyle(el).opacity).catch(() => 'n/a');
await page.waitForTimeout(400);
const endOpacity = await page.locator('[data-rid="nd"]').first().evaluate((el) => getComputedStyle(el).opacity).catch(() => 'n/a');
const btn = page.locator('button[data-rid]', { hasText: 'New run' });
const bgBefore = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
await btn.hover();
await page.waitForTimeout(250);
const bgHover = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
const motionLint = await (await fetch(base + 'api/lint')).json();

console.log(JSON.stringify({ selectedLabel, chipVariant, liveTitle, afterUndo, chipAfterUndo, zoom, midOpacity, endOpacity, bgBefore, bgHover, motionIssues: motionLint.filter((i) => i.code.startsWith('M')).length, errors }, null, 2));
await browser.close();
