// Apply an RDL script to a fresh document and screenshot the first root.  usage: node scripts/rdl-shot.mjs <file.rdl> <out.png> [mode]
import { readFile, writeFile } from 'node:fs/promises';
import { applyRdl, createDocument, formatLint, lint } from '@rangoli/engine';
import { renderPng, closeShots } from '../packages/server/dist/shots.js';
const [file, out, mode = 'light'] = process.argv.slice(2);
const doc = createDocument('Shot');
applyRdl(doc, await readFile(file, 'utf8'));
await writeFile(out, await renderPng(doc, { roots: [doc.page().children[0]], mode, maxWidth: 1400 }));
console.log(formatLint(lint(doc).filter((i) => i.severity !== 'P3')) || 'lint: clean');
await closeShots();
