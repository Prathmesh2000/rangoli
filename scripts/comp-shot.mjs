import { chromium } from 'playwright-core';
const [base, out] = process.argv.slice(2);
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
await p.goto(base + 'editor/'); await p.waitForSelector('.layer'); await p.getByRole('radio', { name: 'Images' }).click(); await p.waitForSelector('.studio-left');
await p.locator('.comp-row').first().click(); await p.waitForTimeout(400);
await p.screenshot({ path: out });
console.log(await p.locator('.comp-host').evaluate((el) => [el.clientWidth, el.clientHeight]));
await b.close();
