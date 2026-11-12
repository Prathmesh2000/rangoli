// Browser flow: Add panel + drag and drop, colour and font pickers, themes, image fills, 3D, JavaScript.
// usage: node scripts/studio-flow.mjs <baseUrl> <outDir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2];
const out = process.argv[3];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(base + 'editor/');
await page.waitForSelector('.draw-tools');

const api = (p, b) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : { cache: 'no-store' });
  return { status: r.status, json: await r.json() };
}, [p, b]);
const rdl = async (script) => { const r = await api('/api/rdl', { script }); if (r.status !== 200) throw new Error(JSON.stringify(r.json)); return r.json; };
const data = async () => { const j = (await api('/api/doc')).json; return j.doc ?? j.data ?? j; };
const nodes = async () => Object.values((await data()).pages)[0].nodes;
const settle = (ms = 350) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)?.slice(0, 400)}`}`); };
const box = (id) => page.locator(`[data-rid="${id}"]`).first().boundingBox();
const drag = async (from, to, opts = {}) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  if (opts.shot) await page.screenshot({ path: join(out, opts.shot) });
  if (opts.ctrl) await page.keyboard.down('Control');
  await page.mouse.move(to.x + 1, to.y + 1);
  await page.mouse.up();
  if (opts.ctrl) await page.keyboard.up('Control');
  await settle();
};
const mid = (b) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
const clickNode = async (id) => { await page.locator(`[data-rid="${id}"]`).first().click({ force: true, position: { x: 2, y: 2 } }); await settle(); };
const open = async (t) => { const b = page.locator('.section-toggle', { hasText: t }).first(); if ((await b.getAttribute('aria-expanded')) === 'false') await b.click(); await settle(150); };

for (const n of Object.values(await nodes())) if (!n.parent) await rdl('delete #' + n.id);
for (const t of ['ocean', 'brand-night']) await api('/api/rdl', { script: `theme ${t} none` });
await page.evaluate(() => localStorage.clear());
const seed = await rdl('Screen col p6 gap4 w900 fill:surface\n  Title text title "Studio"\n  Stack col gap2 p3 w300 stroke:border\n    One text body "One"\n    Two text body "Two"\n  Free none w400 h200 fill:canvas\n  Target col gap2 p3 w300 h100 stroke:border');
const [screen, , stack, one, two, free, target] = seed.created;
await settle();
await page.getByRole('button', { name: /^Fit$/ }).click();
await settle();

// ---- Add panel
await page.keyboard.press('a');
await settle(600);
check('add panel opens with live thumbnails', (await page.locator('.add-tile').count()) > 20 && await page.locator('.add-thumb-host').first().evaluate((e) => !!e.shadowRoot?.querySelector('.t')));
await page.screenshot({ path: join(out, '1-add.png') });
const tile = async (name) => {
  await page.getByLabel('Search components and patterns', { exact: true }).fill(name);
  await settle(300);
  const t = page.locator(`.add-tile:has(.add-label:text-is("${name}"))`).first();
  return mid(await t.boundingBox());
};
{
  const before = (await nodes())[stack].children.slice();
  const b = await box(two);
  const f = await tile('Button');
  await drag(f, { x: b.x + 40, y: b.y + 2 }, { shot: '2-drop-line.png' });
  const after = (await nodes())[stack].children;
  check('drag from panel inserts between siblings', after.length === before.length + 1 && after.indexOf(two) === 2 && after.indexOf(one) === 0, after);
}
{
  const b = await box(free);
  const f = await tile('Chip');
  await drag(f, { x: b.x + 120, y: b.y + 60 });
  const kid = (await nodes())[(await nodes())[free].children[0]];
  check('drop into a free frame places it at the pointer', kid?.position && Math.abs(kid.position.x - 120 / (await page.evaluate(() => 1) * 1)) < 400 && kid.position.x > 0, kid);
}
{
  const b = await box(target);
  const f = await tile('Pricing');
  await drag(f, mid(b));
  check('patterns can be dropped too', (await nodes())[target].children?.length === 1, (await nodes())[target]);
  await rdl(`delete #${(await nodes())[target].children[0]}`);
  await settle();
}
await page.getByLabel('Search components and patterns', { exact: true }).fill('');
await page.getByRole('tab', { name: 'Layers' }).click();
await settle();

// ---- moving existing layers
{
  const a = await box(one), t = await box(target);
  await drag(mid(a), { x: t.x + 30, y: t.y + 30 });
  check('drag a layer into another frame', (await nodes())[one].parent === target, (await nodes())[one]);
  const a2 = await box(two), t2 = await box(target);
  await drag(mid(a2), { x: t2.x + 30, y: t2.y + 30 }, { ctrl: true });
  check('Ctrl+drop places freely', (await nodes())[two].absolute === true && (await nodes())[two].parent === target, (await nodes())[two]);
}
{
  const row = (id) => page.locator(`[data-layer="${id}"]`).boundingBox();
  const rt = await row(target), rs = await row(stack);
  await drag(mid(rt), { x: rs.x + 40, y: rs.y + 1 });
  const kids = (await nodes())[screen].children;
  check('drag a row in Layers reorders', kids.indexOf(target) < kids.indexOf(stack), kids);
}

// ---- suggestion dropdown (previously untestable native list)
await clickNode(stack);
await page.getByLabel('Gap', { exact: true }).click();
await settle(150);
await page.locator('.combo-opt', { hasText: /^5 ·/ }).click();
await settle();
check('dropdown picks a token', (await nodes())[stack].layout.gap?.token === 'space.5', (await nodes())[stack].layout);

// ---- colour picker
const picker = async (label) => { await page.getByLabel(`${label} picker`, { exact: true }).click(); await settle(200); };
await picker('Fill');
await page.screenshot({ path: join(out, '3-color.png') });
{
  const sv = await page.locator('.cp-sv').boundingBox();
  await page.mouse.click(sv.x + sv.width * .8, sv.y + sv.height * .2);
  await settle();
  const f1 = (await nodes())[stack].style.fill[0];
  check('saturation area sets a colour', /^#[0-9a-f]{6}$/.test(f1.hex ?? ''), f1);
  const hex = page.getByLabel('Hex colour', { exact: true });
  await hex.fill('#ff5a1f');
  await hex.press('Enter');
  await settle();
  check('hex entry', (await nodes())[stack].style.fill[0].hex === '#ff5a1f', (await nodes())[stack].style.fill);
  const pct = page.getByLabel('Opacity percent', { exact: true });
  await pct.fill('50');
  await pct.press('Enter');
  await settle();
  check('opacity', JSON.stringify((await nodes())[stack].style.fill[0]).includes('~50') || (await page.locator('.cp-big').count()) === 1);
  await page.getByLabel('Name for my colour', { exact: true }).fill('Sunset');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await settle();
  check('save to my colours', (await data()).tokens.color.custom?.sunset?.$value === '#ff5a1f', (await data()).tokens.color.custom);
  await page.getByRole('tab', { name: 'Library' }).click();
  await settle(150);
  check('colour library', (await page.locator('.cp-ramp').count()) === 24 && (await page.locator('.cp-named .cp-sw').count()) > 130, await page.locator('.cp-named .cp-sw').count());
  await page.screenshot({ path: join(out, '4-library.png') });
  await page.getByRole('tab', { name: 'Saved' }).click();
  await settle(150);
  await page.getByLabel('Paste hex colours', { exact: true }).fill('#112233, #abcdef');
  await page.getByRole('button', { name: 'Add colours' }).click();
  await settle();
  check('paste a palette', !!(await data()).tokens.color.custom?.['112233'], (await data()).tokens.color.custom);
  await page.getByRole('button', { name: 'Remove 112233' }).click();
  await settle();
  check('remove my colour', !(await data()).tokens.color.custom?.['112233']);
  await page.locator('.cp-tab', { hasText: 'Tokens' }).click();
  await settle(150);
  await page.locator('.cp .cp-tok', { hasText: 'sunset' }).first().click();
  await settle();
  check('use a saved colour as a token', (await nodes())[stack].style.fill[0].token === 'color.custom.sunset', (await nodes())[stack].style.fill);
}

// ---- font picker
await clickNode(two);
await page.getByLabel('Font family', { exact: true }).click();
await settle(400);
await page.screenshot({ path: join(out, '5-font.png') });
check('font list is huge but windowed', (await page.locator('.fp-row').count()) < 30, await page.locator('.fp-row').count());
await page.getByLabel('Search fonts', { exact: true }).fill('Playfair Display');
await settle(300);
await page.locator('.fp-row').filter({ hasText: /^Playfair Display/ }).first().click();
await settle(900);
check('pick a font', (await nodes())[two].style.font.family === 'Playfair Display', (await nodes())[two].style);
check('real font is loaded', await page.evaluate(async () => (await document.fonts.load('16px "Playfair Display"')).length > 0 && !!document.querySelector('link[data-font*="Playfair"]')));
await page.getByLabel('Font family', { exact: true }).click();
await settle(200);
await page.getByRole('button', { name: /Add your own font/ }).click();
await page.getByLabel('Font name', { exact: true }).fill('Brand Sans');
await page.getByLabel('Font URL', { exact: true }).fill('https://cdn.example.com/brand.woff2');
await page.getByRole('button', { name: 'Add from URL' }).click();
await settle();
check('add a custom font', (await nodes())[two].style.font.family === 'Brand Sans' && !!(await data()).tokens.$extensions.rangoli.fonts['Brand Sans']);

// ---- themes
await page.getByRole('tab', { name: 'Tokens' }).click();
await settle();
await page.locator('.theme-chip', { hasText: 'Ocean' }).click();
await settle();
check('theme preset applied', await page.getByLabel('Theme', { exact: true }).inputValue() === 'ocean');
await page.getByRole('button', { name: 'New theme' }).click();
await page.getByLabel('Theme name', { exact: true }).fill('Brand Night');
await page.getByRole('button', { name: 'Create', exact: true }).click();
await settle();
check('custom theme', (await data()).tokens.$extensions.rangoli.themes['brand-night']?.name === 'Brand Night', (await data()).tokens.$extensions.rangoli.themes);
await page.screenshot({ path: join(out, '6-theme.png') });
await page.getByLabel('Theme', { exact: true }).selectOption('light');
await settle();
await page.getByRole('button', { name: 'Golden' }).click();
await settle();
check('type scale', (await data()).tokens.textStyle.display.$value.fontSize > 90, (await data()).tokens.textStyle.display.$value);
await page.getByRole('tab', { name: 'Inspect' }).click();
await settle();

// ---- image background (upload and URL)
await clickNode(target);
await page.getByRole('radio', { name: 'Image', exact: true }).click();
await settle();
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
await page.getByLabel('Upload a background image', { exact: true }).setInputFiles({ name: 'bg.png', mimeType: 'image/png', buffer: png });
await settle(1200);
{
  const f = (await nodes())[target].style.fill[0];
  check('image background from upload', !!f.image?.asset, f);
}
await page.getByLabel('Image URL', { exact: true }).fill('https://example.com/hero.jpg');
await page.getByLabel('Image URL', { exact: true }).press('Enter');
await settle();
await page.getByLabel('Image tint', { exact: true }).fill('neutral.900~40');
await page.getByLabel('Image tint', { exact: true }).press('Enter');
await settle();
{
  const f = (await nodes())[target].style.fill[0];
  check('image URL + tint', f.image?.url === 'https://example.com/hero.jpg' && f.image?.tint?.alpha === 40, f);
}

// ---- 3D
const scene = (await rdl(`insert #${screen} end\n  @Scene3D h300 light=neon objects="gem color=primary.400 metal=.6 rough=.1 spin=.5" "Gem"`)).created[0];
await settle(500);
await page.waitForFunction((id) => !!document.querySelector('.canvas-zoom > div').shadowRoot.querySelector(`[data-rid="${id}"] .rk-3d canvas`), scene, { timeout: 30000 }).catch(() => {});
check('3D draws on the canvas', await page.evaluate((id) => !!document.querySelector('.canvas-zoom > div').shadowRoot.querySelector(`[data-rid="${id}"] .rk-3d[data-ready] canvas`), scene));
await clickNode(scene);
await page.getByRole('button', { name: 'Token', exact: true }).click();
await settle();
check('add a 3D object from the panel', /coin/.test((await nodes())[scene].props.objects), (await nodes())[scene].props);
await page.getByLabel('Object 1 x', { exact: true }).fill('-1.5');
await page.getByLabel('Object 1 x', { exact: true }).press('Enter');
await settle();
check('edit a 3D object', /x=-1\.5/.test((await nodes())[scene].props.objects), (await nodes())[scene].props);
await page.waitForTimeout(1200);
await page.screenshot({ path: join(out, '7-3d.png') });

// ---- JavaScript: never in the editor, runs sandboxed in Run
await clickNode(two);
await page.getByRole('tab', { name: 'Code' }).click();
await settle();
await page.getByRole('radio', { name: 'JavaScript' }).click();
await settle();
{
  const a = page.getByLabel('JavaScript for this layer', { exact: true });
  await a.fill("el.textContent = 'ran:' + (typeof parent.document === 'undefined' ? 'x' : 'x');");
  await a.blur();
  await settle();
  check('script stored on the layer', /ran:/.test((await nodes())[two].script ?? ''), (await nodes())[two]);
  check('script does not run in the editor', !(await page.evaluate((id) => document.querySelector('.canvas-zoom > div').shadowRoot.querySelector(`[data-rid="${id}"]`).textContent.startsWith('ran:'), two)));
  await a.fill("el.textContent = 'ran-ok';");
  await a.blur();
  await settle();
}
await page.getByRole('button', { name: 'Run', exact: true }).first().click();
await settle(1500);
{
  const frame = page.frameLocator('iframe.run-frame');
  await frame.locator('.rk-3d[data-ready]').first().waitFor({ timeout: 25000 }).catch(() => {});
  check('3D runs in the sandboxed Run view', (await frame.locator('.rk-3d[data-ready] canvas').count()) === 1);
  check('script runs in Run', (await frame.locator('text=ran-ok').count()) === 1);
  check('Run is sandboxed from the editor', (await page.locator('iframe.run-frame').getAttribute('sandbox')) === 'allow-scripts');
}
await page.screenshot({ path: join(out, '8-run.png') });
await page.getByRole('button', { name: 'Close', exact: true }).click();
await settle();
{
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export', exact: true }).click()]);
  check('export downloads an html file', dl.suggestedFilename().endsWith('.html'), dl.suggestedFilename());
}

// ---- multi-select
await page.getByRole('tab', { name: 'Design' }).click().catch(() => {});
{
  const fx = (await rdl(`insert #${free} end\n  A w40 h40 abs at:10,10 fill:subtle\n  B w40 h40 abs at:100,60 fill:primary.300 r3`)).created;
  await settle();
  await page.locator(`[data-layer="${fx[0]}"]`).click().catch(() => {});
  await clickNode(fx[0]);
  await page.locator(`[data-rid="${fx[1]}"]`).first().click({ force: true, modifiers: ['Shift'] });
  await settle();
  check('selection toolbar', (await page.locator('.sel-tools').count()) === 1);
  await page.getByRole('button', { name: 'Align top' }).click();
  await settle();
  check('align', (await nodes())[fx[1]].position.y === 10, (await nodes())[fx[1]].position);
  await page.keyboard.press('Control+g');
  await settle();
  const g = Object.values(await nodes()).find((n) => n.name === 'Group');
  check('Ctrl+G groups', g?.children?.length === 2, g);
}
console.log(`${results.filter(Boolean).length}/${results.length} checks; browser errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log(e.slice(0, 300)));
await browser.close();
