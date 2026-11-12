// Browser flow: shape builder, branching, live symmetry, width profiles, gradients, icon font,
// pencil, scissors, image trace, 3D gizmo, textures, .glb by URL and upload, Run console, scrubbing.
// usage: node scripts/vector2-flow.mjs <baseUrl> <outDir>
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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
await page.waitForSelector('.toolbar');
const api = (p, b) => page.evaluate(async ([p, b]) => { const r = await fetch(p, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : { cache: 'no-store' }); return { status: r.status, json: await r.json().catch(() => null) }; }, [p, b]);
const rdl = async (script) => { const r = await api('/api/rdl', { script }); if (r.status !== 200) throw new Error(JSON.stringify(r.json)); return r.json; };
const data = async () => { const j = (await api('/api/doc')).json; return j.doc ?? j.data ?? j; };
const settle = (ms = 300) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)?.slice(0, 500)}`}`); };
const src = async () => (await data()).icons.ui.icons.flow?.src ?? '';
const shapes = async () => (await src()).split('\n').filter((l) => l && l !== 'exact');
const setSrc = async (...lines) => { await rdl(`icon ui/flow\n${lines.map((l) => `  ${l}`).join('\n')}`); await settle(500); };

await rdl('icon ui/flow\n  rect 4 4 10 10 fill=true\n  rect 9 9 10 10 fill=true');
await page.getByRole('radio', { name: 'Icons' }).click();
await settle(500);
await page.locator('.icon-tile[aria-label="flow"]').click();
await settle(1000);
const board = await page.locator('.vb-svg').boundingBox();
const u = board.width / 24;
const P = (x, y) => [board.x + x * u, board.y + y * u];
const tool = async (k) => { await page.keyboard.press(k); await settle(80); };
const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, { steps: 8 }); await page.mouse.up(); await settle(450); };
const clear = async () => { await tool('v'); await page.mouse.click(...P(23, 23)); await settle(100); };
const selectTwo = async (a, b) => { await clear(); await page.mouse.click(...a); await settle(100); await page.keyboard.down('Shift'); await page.mouse.click(...b); await page.keyboard.up('Shift'); await settle(150); };

// shape builder
await selectTwo(P(5, 5), P(18, 18));
await tool('b');
await page.waitForSelector('.vb-atoms path', { timeout: 30000 }).catch(() => {});
await settle(300);
check('shape builder finds three regions', (await page.locator('.vb-atoms path').count()) === 3, await page.locator('.vb-atoms path').count());
await page.screenshot({ path: join(out, '1-builder.png') });
await page.keyboard.down('Alt');
await page.mouse.click(...P(11, 11));
await page.keyboard.up('Alt');
await settle(700);
check('alt-click removes the overlap', (await shapes()).length === 2 && (await shapes()).every((l) => l.startsWith('path')), await shapes());

await setSrc('rect 4 4 10 10 fill=true', 'rect 9 9 10 10 fill=true');
await selectTwo(P(5, 5), P(18, 18));
await tool('b');
await page.waitForSelector('.vb-atoms path', { timeout: 30000 }).catch(() => {});
await settle(300);
await drag(P(6, 6), P(11, 11));
await settle(500);
check('dragging across regions merges them', (await shapes()).length === 2, await shapes());
await tool('Escape');
await settle(200);

// live symmetry
await setSrc('circle 3 3 1');
await clear();
await page.getByLabel('Live symmetry for new shapes', { exact: true }).selectOption({ label: 'Left-right' });
await settle(100);
await page.locator('.vb-svg').hover();
await tool('l');
await drag(P(3, 8), P(9, 14));
check('new shapes get live symmetry', (await shapes()).some((l) => /^line .* sym=h12/.test(l)), await shapes());
check('the mirrored copy is drawn on the board', (await page.locator('.vb-svg path[d="M21 8 L15 14"]').count()) === 1, await page.locator('.vb-svg').innerHTML());
await page.screenshot({ path: join(out, '2-symmetry.png') });
await page.getByLabel('Live symmetry for new shapes', { exact: true }).selectOption({ label: 'Off' });
await settle(100);

// width profile, gradient, bake
await setSrc('line 3 12 21 12');
await clear();
await page.mouse.click(...P(12, 12));
await settle(200);
await page.getByLabel('Width profile', { exact: true }).selectOption({ label: 'Taper both' });
await settle(500);
check('width profile is stored', (await shapes())[0].includes('vw='), await shapes());
await page.getByTitle('Paint this shape with a gradient').click();
await settle(500);
check('gradient is stored', /grad=135,#f59e0b,#ef4444/.test((await shapes())[0]), await shapes());
check('gradient is painted on the board', (await page.locator('.vb-svg linearGradient').count()) === 1);
await page.screenshot({ path: join(out, '3-width-gradient.png') });
await page.getByLabel('Shape symmetry', { exact: true }).selectOption({ label: 'Top-bottom' });
await settle(500);
await page.getByRole('button', { name: 'Bake', exact: true }).click();
await settle(600);
{
  const s = await shapes();
  check('bake makes ordinary paths and keeps the paint', s.length === 2 && s.every((l) => l.startsWith('path') && l.includes('fill=true') && !/ (vw|sym)=/.test(l) && l.includes('grad=')), s);
}

// branching and welded points
await setSrc('path M6 6 L18 6');
await clear();
await tool('p');
await page.mouse.click(...P(12.05, 6.05)); // not on an anchor: starts a new shape, then drop it
await page.keyboard.press('Escape');
await settle(100);
await tool('p');
await page.mouse.click(...P(18.1, 6.1));
await settle(100);
await page.mouse.click(...P(18, 18));
await settle(100);
await page.keyboard.press('Enter');
await settle(500);
{
  const s = await shapes();
  check('pen from an existing point adds a branch to that shape', s.length === 1 && (s[0].match(/M/g) ?? []).length === 2 && s[0].includes('M18 6'), s);
}
await tool('v');
await page.mouse.click(...P(12, 6));
await settle(150);
await tool('a');
await settle(200);
await drag(P(18, 6), P(20, 8));
{
  const s = await shapes();
  check('dragging a shared point moves every stroke joined there', s.length === 1 && !/18 6/.test(s[0]) && (s[0].match(/20 8/g) ?? []).length === 2, s);
}

// pencil and scissors
await setSrc('circle 3 3 1');
await clear();
await tool('n');
await page.mouse.move(...P(4, 12)); await page.mouse.down();
for (let i = 1; i <= 16; i++) await page.mouse.move(...P(4 + i, 12 + Math.sin(i / 2) * 3));
await page.mouse.up();
await settle(1500);
check('pencil draws a smoothed path', (await shapes()).some((l) => /^path .*C/.test(l)), await shapes());
await setSrc('path M4 12 L20 12');
await clear();
await tool('c');
await page.mouse.click(...P(12, 12));
await settle(500);
{
  const s = await shapes();
  check('scissors cut a path in two', s.length === 2 || (s[0]?.match(/M/g) ?? []).length === 2, s);
}

// trace an image
await setSrc('circle 3 3 1');
await clear();
await tool('v');
const png = await page.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 96; const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, 96, 96); x.fillStyle = '#000'; x.beginPath(); x.arc(48, 48, 30, 0, 7); x.fill(); return c.toDataURL('image/png').split(',')[1]; });
await writeFile(join(out, 'trace.png'), Buffer.from(png, 'base64'));
await page.getByLabel('Trace an image', { exact: true }).setInputFiles(join(out, 'trace.png'));
for (let i = 0; i < 40 && (await shapes()).length < 2; i++) await settle(300);
check('image trace adds vector shapes', (await shapes()).length >= 2, await shapes());

// icon font
await setSrc('circle 12 12 8', 'line 4 12 20 12');
await page.locator('.vs-side, .icon-sets, body').first().evaluate(() => 0);
const downloads = [];
page.on('download', (d) => downloads.push(d));
await page.getByRole('button', { name: 'Manage', exact: true }).click({ timeout: 2000 }).catch(() => {});
await settle(300);
await page.getByRole('button', { name: 'Icon font', exact: true }).first().click();
for (let i = 0; i < 80 && downloads.length < 3; i++) await settle(250);
check('icon font downloads ttf, woff and css', downloads.length === 3, downloads.map((d) => d.suggestedFilename()));
for (const d of downloads) {
  const name = d.suggestedFilename(), bytes = await readFile(await d.path());
  if (name.endsWith('.ttf')) check('ttf is a real font', bytes.readUInt32BE(0) === 0x00010000 && bytes.length > 500, bytes.subarray(0, 8).toString('hex'));
  if (name.endsWith('.woff')) check('woff is a real font', bytes.subarray(0, 4).toString() === 'wOFF', bytes.subarray(0, 8).toString());
  if (name.endsWith('.css')) check('css maps icons to codepoints', /::before\{content:"\\e0/.test(bytes.toString()), bytes.toString().slice(0, 300));
}

// 3D
const scene = async () => Object.values(Object.values((await data()).pages)[0].nodes).find((n) => n.component === 'Scene3D');
const ready = () => page.waitForFunction(() => document.querySelector('.s3-view')?.getAttribute('data-studio') === 'ready', undefined, { timeout: 30000 }).catch(() => {});
await page.getByRole('radio', { name: '3D', exact: true }).click();
await settle(400);
await page.getByRole('button', { name: 'New 3D scene' }).click();
await ready();
await settle(800);
{
  const n = await scene();
  await rdl(`set #${n.id} objects="box s=1"`);
  await settle(2000);
  await ready();
  const v = await page.locator('.s3-view').boundingBox();
  const cx = v.x + v.width / 2, cy = v.y + v.height / 2;
  let moved = false;
  for (const dx of [30, 50, 70, 90, 110, 130]) {
    await page.mouse.move(cx + dx - 3, cy); await page.mouse.move(cx + dx, cy); await settle(250);
    await page.mouse.down(); await page.mouse.move(cx + dx + 40, cy, { steps: 6 }); await settle(100); await page.mouse.move(cx + dx + 80, cy, { steps: 6 }); await page.mouse.up();
    await settle(1500);
    if (/\bx=/.test((await scene()).props.objects)) { moved = true; break; }
  }
  check('dragging the gizmo arrow moves the object', moved, (await scene()).props.objects);
  await ready();
  await settle(400);
  await page.getByLabel('Object 1 texture', { exact: true }).fill('https://threejs.org/examples/textures/uv_grid_opengl.jpg');
  await page.getByLabel('Object 1 texture', { exact: true }).press('Enter');
  await settle(3500);
  check('texture is stored', /map=https/.test((await scene()).props.objects), (await scene()).props.objects);
  await page.screenshot({ path: join(out, '4-texture.png') });
  const shot = await page.locator('.s3-view canvas').screenshot();
  await writeFile(join(out, '4-canvas.png'), shot);

  // a model by URL
  await page.getByLabel('Add a shape', { exact: true }).selectOption('model');
  await settle(800);
  check('model shape can be added', /model .*url=https/.test((await scene()).props.objects), (await scene()).props.objects);
  await settle(6000);
  await page.screenshot({ path: join(out, '5-model-url.png') });

  // upload a model
  const glb = Buffer.from(await (await fetch('https://modelviewer.dev/shared-assets/models/Astronaut.glb')).arrayBuffer());
  await writeFile(join(out, 'model.glb'), glb);
  await page.getByLabel('Upload a GLB model', { exact: true }).setInputFiles(join(out, 'model.glb'));
  for (let i = 0; i < 40 && !/asset=/.test((await scene()).props.objects); i++) await settle(300);
  const objects = (await scene()).props.objects;
  check('uploaded model is referenced by asset id', /model .*asset=[a-f0-9]{12}/.test(objects), objects);
  const id = /asset=([a-f0-9]{12})/.exec(objects)?.[1];
  const res = await page.evaluate(async (id) => { const r = await fetch(`/assets/${id}.glb`); return [r.status, r.headers.get('content-type'), (await r.arrayBuffer()).byteLength]; }, id);
  check('uploaded model is served', res[0] === 200 && res[1] === 'model/gltf-binary' && res[2] === glb.length, res);
  await settle(5000);
  await page.screenshot({ path: join(out, '6-model-upload.png') });
  // on its own, so the model cannot be hidden by anything else in the scene
  await rdl(`set #${(await scene()).id} objects="model asset=${id}"`);
  await settle(9000);
  const alone = await page.locator('.s3-view canvas').screenshot({ path: join(out, '6-model-alone.png') });
  const drawn = await page.evaluate(async (b64) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
    const c = new OffscreenCanvas(img.width, img.height), x = c.getContext('2d');
    x.drawImage(img, 0, 0);
    const d = x.getImageData(0, 0, img.width, img.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - d[0]) + Math.abs(d[i + 1] - d[1]) + Math.abs(d[i + 2] - d[2]) > 30) n++;
    return n;
  }, alone.toString('base64'));
  check('uploaded model is actually drawn', drawn > 2000, drawn);
  const assets = (await data()).assets ?? {};
  check('stored as a model, not an image', Object.values(assets).some((a) => a.mime === 'model/gltf-binary'), assets);
}

// scrub a number by dragging its label
{
  await page.locator(".s3-list button, .s3-objects button").first().click().catch(() => {}); await settle(300);
  const before = (await scene()).props.objects;
  const label = page.locator('[data-scrub="Object 1 s"]').first();
  if (await label.count()) {
    const b = await label.boundingBox();
    await page.mouse.move(b.x + 4, b.y + 4); await page.mouse.down(); await page.mouse.move(b.x + 44, b.y + 4, { steps: 6 }); await page.mouse.up();
    await settle(1200);
    const after = (await scene()).props.objects;
    check('dragging a label changes the number', after !== before, [before, after]);
  } else check('scrub label exists', false, await page.locator('[data-scrub]').evaluateAll((e) => e.map((x) => x.dataset.scrub)));
}

// the Run console
await page.getByRole('radio', { name: 'Design' }).click();
await settle(400);
await rdl(`Box#logger w40 h40 fill:surface script:${JSON.stringify("console.log('hello'); console.error('bad thing');")}`).catch(async () => rdl(`Frame w40 h40 fill:surface script:${JSON.stringify("console.log('hello'); console.error('bad thing');")}`));
await settle(500);
await page.getByRole('button', { name: 'Run', exact: true }).click();
await settle(2500);
const con = page.getByRole('button', { name: /^Console/ });
check('console counts messages and errors', /\(\d+, \d+ errors?\)/.test(await con.textContent()), await con.textContent());
await con.click();
await settle(200);
check('console shows the output', /bad thing/.test(await page.locator('.run-log').textContent()), await page.locator('.run-log').textContent());
await page.screenshot({ path: join(out, '7-console.png') });
await page.getByRole('button', { name: 'Close', exact: true }).click();
await settle(200);

check('no errors besides the logged test message', errors.every((e) => /bad thing/.test(e)), errors);
console.log(`${results.filter(Boolean).length}/${results.length} checks; browser errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log(e.slice(0, 300)));
await browser.close();
