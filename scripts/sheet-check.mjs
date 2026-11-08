// Render an RDL file in a fresh document to PNG (light + dark) and print lint.  usage: node scripts/sheet-check.mjs <file.rdl> <outPrefix>
import { readFile, writeFile } from 'node:fs/promises';
import { applyRdl, createDocument, formatLint, lint } from '@rangoli/engine';
import { renderPng, closeShots } from '../packages/server/dist/shots.js';
const [file, out] = process.argv.slice(2);
const doc = createDocument('Sheet');
const r = applyRdl(doc, await readFile(file, 'utf8'));
for (const mode of ['light', 'dark']) await writeFile(`${out}-${mode}.png`, await renderPng(doc, { roots: [r.created[0]], mode, maxWidth: 1600 }));
console.log(formatLint(lint(doc).filter((i) => i.severity !== 'P3')));
await closeShots();
