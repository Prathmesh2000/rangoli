// Export each composition template to PNG for visual review.  usage: node scripts/template-check.mjs <outDir>
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyRdl, createDocument, IMAGE_TEMPLATES } from '@rangoli/engine';
import { composeImage } from '../packages/server/dist/imaging.js';
import { closeShots } from '../packages/server/dist/shots.js';
const out = process.argv[2];
for (const [k, t] of Object.entries(IMAGE_TEMPLATES)) {
  const doc = createDocument('AI Test Management');
  const r = applyRdl(doc, t.rdl('AI Test Management'));
  const img = await composeImage(doc, r.created[0], 'png', 1, () => '');
  await writeFile(join(out, `tpl-${k}.png`), img.buf);
  console.log(k, img.w, img.h, img.buf.length);
}
await closeShots();
