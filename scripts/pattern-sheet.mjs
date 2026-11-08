// Expand patterns one by one, lint each and compose a labelled contact sheet.
// usage: node scripts/pattern-sheet.mjs <out.png> <name,name,...> [mode] [cols]
import { writeFile } from 'node:fs/promises';
import { applyRdl, createDocument, formatLint, lint } from '@rangoli/engine';
import { browser, closeShots, renderPng } from '../packages/server/dist/shots.js';
const [out, names, mode = 'light', cols = '2'] = process.argv.slice(2);
const tiles = [];
for (const name of names.split(',')) {
  const doc = createDocument(name);
  try {
    const r = applyRdl(doc, `Frame col p6 fill:canvas\n  +${name}`);
    const issues = lint(doc).filter((i) => i.severity !== 'P3');
    if (issues.length) console.log(`${name}:\n${formatLint(issues)}`);
    tiles.push({ name, png: (await renderPng(doc, { roots: [r.created[0]], mode, maxWidth: 1400 })).toString('base64') });
  } catch (e) { console.log(`${name}: ERROR ${e.message}`); }
}
const page = await (await browser()).newPage({ viewport: { width: 1600, height: 800 } });
await page.setContent(`<body style="margin:0;padding:20px;background:${mode === 'dark' ? '#0d0f12' : '#e4e7eb'};font:600 13px system-ui;color:${mode === 'dark' ? '#ddd' : '#333'}"><div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:20px;align-items:start">${tiles.map((t) => `<figure style="margin:0"><figcaption style="margin-bottom:6px">+${t.name}</figcaption><img style="max-width:100%;display:block" src="data:image/png;base64,${t.png}"></figure>`).join('')}</div></body>`);
await writeFile(out, await page.screenshot({ fullPage: true }));
await closeShots();
