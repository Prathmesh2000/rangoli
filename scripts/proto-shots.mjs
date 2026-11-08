// Click through the demo prototype in system Edge and report what happened.
// usage: node scripts/proto-shots.mjs <baseUrl> <outDir>
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

await p.goto(base + 'play');
await p.waitForTimeout(300);
const r = {};
const cur = () => p.evaluate(() => window.__rangoliPlayer.current());
r.start = await cur();
await p.screenshot({ path: join(out, 'p1-login.png') });

await p.locator('.rp-screen.is-active button[data-rid="ni"]').click(); // Sign in
await p.waitForTimeout(80);
r.afterSignIn = await cur();
r.rowAnimations = await p.evaluate(() => ['n17', 'n1f', 'n1n'].map((id) => document.querySelector(`.is-active [data-rid="${id}"]`).getAnimations().length));
await p.waitForTimeout(500);
r.rowOpacityEnd = await p.evaluate(() => getComputedStyle(document.querySelector('.is-active [data-rid="n1n"]')).opacity);
await p.screenshot({ path: join(out, 'p2-runs.png') });

await p.locator('.rp-screen.is-active button[data-rid="nw"]').click(); // New run
await p.waitForTimeout(300);
r.overlays = await p.evaluate(() => window.__rangoliPlayer.overlays());
await p.screenshot({ path: join(out, 'p3-overlay.png') });
await p.keyboard.press('Escape');
await p.waitForTimeout(300);
r.overlaysAfterEsc = await p.evaluate(() => window.__rangoliPlayer.overlays());

// click on a non-interactive area flashes hotspots
await p.mouse.click(200, 400);
r.flash = await p.evaluate(() => document.body.classList.contains('rp-flash'));

await p.getByRole('button', { name: '← Back' }).click();
await p.waitForTimeout(300);
r.afterBack = await cur();
r.hudName = await p.locator('.rp-name').textContent();
r.errors = errors;
console.log(JSON.stringify(r, null, 2));
await b.close();
