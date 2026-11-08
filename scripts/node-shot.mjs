// Screenshot specific top-level frames from the live preview (reference renderer).
// usage: node scripts/node-shot.mjs <baseUrl> <outDir> <id[,id...]> [light|dark]
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [base, out, ids, mode = 'light'] = process.argv.slice(2);
await mkdir(out, { recursive: true });
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1400, height: 900 } });
await p.goto(`${base}?mode=${mode}`);
await p.waitForTimeout(500);
await p.addStyleTag({ content: '.rangoli-bar{display:none!important}' });
for (const id of ids.split(',')) {
  await p.locator(`[data-rid="${id}"]`).first().screenshot({ path: join(out, `${id}-${mode}.png`) });
  console.log(join(out, `${id}-${mode}.png`));
}
await b.close();
