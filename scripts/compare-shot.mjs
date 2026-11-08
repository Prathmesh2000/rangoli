// Screenshot the stacked compare view for a fresh suggestion.
// usage: node scripts/compare-shot.mjs <baseUrl> <out.png>
import { chromium } from 'playwright-core';

const [base, out] = process.argv.slice(2);
const H = { 'content-type': 'application/json' };
await fetch(base + 'api/changesets', { method: 'POST', headers: H, body: JSON.stringify({ script: 'set #n8 "Start run"', label: 'Verb-first label' }) });
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(base + 'editor/');
await p.waitForSelector('.layer');
await p.getByRole('tab', { name: /Review/ }).click();
await p.locator('.cs').first().getByRole('button', { name: 'Compare' }).click();
await p.waitForTimeout(300);
await p.getByRole('radio', { name: 'Stacked' }).click();
await p.waitForTimeout(300);
await p.screenshot({ path: out });
console.log(await p.locator('.compare-scale').first().evaluate((el) => el.style.transform));
await b.close();
