// Render every icon of a set at 16/24/48 px into one PNG for visual review.
// usage: node scripts/icon-sheet.mjs <out.png> [docDir]
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { defaultIcons, iconSvg } from '@rangoli/engine';
import { loadDocument } from '@rangoli/engine/io';
const [out, docDir] = process.argv.slice(2);
const sets = docDir ? (await loadDocument(docDir)).data.icons : defaultIcons();
const rows = Object.values(sets).flatMap((set) => Object.values(set.icons).map((ic) =>
  `<div class="row"><span class="n">${set.name}/${ic.name}</span>${[16, 24, 48].map((s) => `<span class="c">${iconSvg(set, ic, { size: s })}</span>`).join('')}<span class="c dark">${iconSvg(set, ic, { size: 24 })}</span></div>`)).join('');
const html = `<!doctype html><style>body{margin:0;font:12px system-ui;color:#1c2026;background:#fff}
#g{display:grid;grid-template-columns:repeat(3,1fr);gap:4px 24px;padding:16px;width:1100px}
.row{display:flex;align-items:center;gap:14px;height:56px;border-bottom:1px solid #eee}.n{width:120px;font-family:monospace;color:#5b6470}
.c{display:inline-grid;place-items:center;width:52px;height:52px;background:repeating-linear-gradient(0deg,#f4f6f8 0 1px,transparent 1px 4px)}.dark{background:#16191d;color:#e6e8eb}</style><div id="g">${rows}</div>`;
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 1200, height: 900 } });
await p.setContent(html);
await writeFile(out, await p.locator('#g').screenshot());
await b.close();
console.log('ok');
