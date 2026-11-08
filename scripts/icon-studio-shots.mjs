// Seed agent drafts, drive Icon Studio in system Edge, keep one variant.
// usage: node scripts/icon-studio-shots.mjs <baseUrl> <outDir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [base, out] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const H = { 'content-type': 'application/json' };
const flask = 'line 9.5 3.5 14.5 3.5\n  path M10.5 3.5 L10.5 9.5 L5.5 18 Q4.5 20 6.5 20 L17.5 20 Q19.5 20 18.5 18 L13.5 9.5 L13.5 3.5';
const script = [
  `icon drafts/flask-check~1\n  ${flask}\n  polyline 9 15.5 11 17.5 15 13.5`,
  `icon drafts/flask-check~2\n  ${flask}\n  line 7.5 15 16.5 15\n  polyline 10 17.5 11.5 18.5 14 16.5`,
  `icon drafts/flask-check~3\n  ${flask}\n  circle 17.5 17.5 3.5`,
].join('\n');
const seeded = await fetch(base + 'api/rdl', { method: 'POST', headers: H, body: JSON.stringify({ script, label: 'agent: flask-check variants' }) });
const r = { seeded: seeded.status };

const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
await p.goto(base + 'editor/');
await p.waitForSelector('.layer');
await p.getByRole('radio', { name: 'Icons' }).click();
await p.waitForSelector('.icon-board');
r.tiles = await p.locator('.icon-tile').count();
r.draftGroups = await p.locator('.draft-group').count();
await p.locator('.icon-tile[title="clock"]').click();
await p.waitForTimeout(200);
await p.screenshot({ path: join(out, 'i1-studio.png') });

// live preview: typing changes the board without applying
const before = await p.locator('.icon-strokes path').count();
await p.locator('.studio-right textarea').fill('circle 12 12 8.5\npolyline 12 7.5 12 12 15 14\ndot 12 4 1');
await p.waitForTimeout(200);
r.livePreviewPaths = [before, await p.locator('.icon-strokes path').count()];
r.applyEnabled = await p.getByRole('button', { name: 'Apply' }).isEnabled();
await p.getByRole('button', { name: 'Reset' }).click();

// look at a draft, then keep it
await p.locator('.draft .icon-tile[title="flask-check~2"]').click();
await p.waitForTimeout(250);
await p.screenshot({ path: join(out, 'i2-draft.png') });
await p.locator('.draft', { has: p.locator('[title="flask-check~2"]') }).getByRole('button', { name: 'Keep' }).click();
await p.waitForTimeout(600);
const doc = await (await fetch(base + 'api/doc')).json();
r.kept = !!doc.data.icons.ui.icons['flask-check'];
r.draftsLeft = Object.keys(doc.data.icons.drafts?.icons ?? {}).length;
r.selected = await p.locator('.inspector-title').textContent();
await p.screenshot({ path: join(out, 'i3-kept.png') });
r.errors = errors;
console.log(JSON.stringify(r, null, 2));
await b.close();
