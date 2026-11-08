import { writeFile } from 'node:fs/promises';
import { applyRdl, createDocument } from '@rangoli/engine';
import { renderIcons, closeShots } from '../packages/server/dist/shots.js';
const doc = createDocument();
applyRdl(doc, 'icon drafts/flask-check~1\n  line 9.5 3.5 14.5 3.5\n  path M10.5 3.5 L10.5 9.5 L5.5 18 Q4.5 20 6.5 20 L17.5 20 Q19.5 20 18.5 18 L13.5 9.5 L13.5 3.5\n  polyline 9 15.5 11 17.5 15 13.5');
await writeFile(process.argv[2], await renderIcons(doc, ['clock', 'retry', 'flask', 'drafts/flask-check~1']));
await closeShots();
console.log('ok');
