// Render one RDL sample in every design language and compose a labelled grid.  usage: node scripts/language-sheet.mjs <file.rdl> <out.png> [mode]
import { readFile, writeFile } from 'node:fs/promises';
import { LANGUAGES, applyRdl, createDocument, formatLint, languageTokens, lint } from '@rangoli/engine';
import { browser, closeShots, renderPng } from '../packages/server/dist/shots.js';
const [file, out, mode = 'light'] = process.argv.slice(2);
const src = await readFile(file, 'utf8');
const tiles = [];
for (const id of Object.keys(LANGUAGES)) {
  const doc = createDocument(id);
  doc.apply([{ op: 'setTokens', tokens: languageTokens(id) }]);
  const r = applyRdl(doc, src);
  const issues = lint(doc).filter((i) => i.severity === 'P0' || i.severity === 'P1');
  if (issues.length) console.log(`${id}:\n${formatLint(issues)}`);
  tiles.push({ id, name: LANGUAGES[id].name, png: (await renderPng(doc, { roots: [r.created[0]], mode, maxWidth: 800 })).toString('base64') });
}
const page = await (await browser()).newPage({ viewport: { width: 1400, height: 800 }, deviceScaleFactor: 1 });
await page.setContent(`<body style="margin:0;padding:24px;background:${mode === 'dark' ? '#0d0f12' : '#e9ebee'};font:600 14px system-ui;color:${mode === 'dark' ? '#ddd' : '#333'}"><div style="display:grid;grid-template-columns:repeat(2,1fr);gap:24px">${tiles.map((t) => `<figure style="margin:0"><figcaption style="margin-bottom:8px">${t.name}</figcaption><img style="width:100%;display:block" src="data:image/png;base64,${t.png}"></figure>`).join('')}</div></body>`);
await writeFile(out, await page.screenshot({ fullPage: true }));
await page.close();
await closeShots();
