// Render candidate icon sources side by side at 24 and 64 px.  usage: node scripts/icon-try.mjs <out.png> <src1> <src2> ...
import { writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { defaultIcons, iconSvg } from '@rangoli/engine';
const [out, ...srcs] = process.argv.slice(2);
const set = defaultIcons().ui;
// shape lines are separated by "|" on the command line
const cells = srcs.map((src, i) => {
  const ic = { name: 't', src: src.split('|').join('\n') };
  return `<div class="c"><b>${i + 1}</b>${iconSvg(set, ic, { size: 24 })}${iconSvg(set, ic, { size: 64 })}</div>`;
}).join('');
const b = await chromium.launch({ channel: 'msedge', headless: true });
const p = await b.newPage({ viewport: { width: 900, height: 300 } });
await p.setContent(`<style>body{margin:0;font:14px system-ui}#g{display:flex;gap:32px;padding:20px}.c{display:flex;gap:16px;align-items:center}</style><div id="g">${cells}</div>`);
await writeFile(out, await p.locator('#g').screenshot());
await b.close();
