// usage: node scripts/film-check.mjs <doc.rangoli> <out.png> <rdl motion script> <target>
import { writeFile } from 'node:fs/promises';
import { applyRdl } from '@rangoli/engine';
import { loadDocument } from '@rangoli/engine/io';
import { filmstrip, closeShots } from '../packages/server/dist/shots.js';
const [docDir, out, script, target] = process.argv.slice(2);
const doc = await loadDocument(docDir);   // in-memory only; never saved
applyRdl(doc, script);
const r = await filmstrip(doc, { target, frames: 5 });
await writeFile(out, r.png);
console.log(r.ms, r.times.join(','));
await closeShots();
