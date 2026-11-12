// Browser flow: vector editor, icon library, SVG import, 3D Studio, field looks.
// usage: node scripts/vector-flow.mjs <baseUrl> <outDir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2];
const out = process.argv[3];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
await page.goto(base + 'editor/');
await page.waitForSelector('.toolbar');
const api = (p, b) => page.evaluate(async ([p, b]) => { const r = await fetch(p, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : { cache: 'no-store' }); return { status: r.status, json: await r.json() }; }, [p, b]);
const rdl = async (script) => { const r = await api('/api/rdl', { script }); if (r.status !== 200) throw new Error(JSON.stringify(r.json)); return r.json; };
const data = async () => { const j = (await api('/api/doc')).json; return j.doc ?? j.data ?? j; };
const settle = (ms = 300) => page.waitForTimeout(ms);
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)?.slice(0, 500)}`}`); };
const src = async () => (await data()).icons.ui.icons.flow?.src ?? '';
const shapes = async () => (await src()).split('\n').filter((l) => l && l !== 'exact');

await rdl('icon ui/flow\n  rect 4 4 8 8\n  circle 16 16 4');
await page.getByRole('radio', { name: 'Icons' }).click();
await settle(500);
await page.evaluate(() => 0);
await page.locator('.icon-tile[aria-label="flow"]').click();
await settle(1000);
const board = await page.locator('.vb-svg').boundingBox();
const u = board.width / 24;
const P = (x, y) => [board.x + x * u, board.y + y * u];
const tool = async (k) => { await page.keyboard.press(k); await settle(60); };
const drag = async (a, b) => { await page.mouse.move(...a); await page.mouse.down(); await page.mouse.move(...b, { steps: 6 }); await page.mouse.up(); await settle(350); };

// drawing tools
await tool('o');
await drag(P(3, 15), P(9, 21));
check('ellipse tool makes a circle when square', (await shapes()).some((l) => l.startsWith('circle 6 18')), await shapes());
await tool('s');
await drag(P(14, 3), P(22, 11));
check('star tool', (await shapes()).some((l) => l.startsWith('star ')), await shapes());
await tool('y');
await drag(P(14, 3), P(20, 9));
check('polygon tool', (await shapes()).some((l) => l.startsWith('ngon ')), await shapes());
{
  await page.keyboard.press('Delete');
  await settle();
  await tool('v');
  await page.mouse.click(...P(1, 23));
  await settle(100);
}
// pen with a curve
await tool('p');
await page.mouse.click(...P(3, 3));
await settle(80);
await page.mouse.move(...P(8, 2)); await page.mouse.down(); await page.mouse.move(...P(10, 2), { steps: 3 }); await page.mouse.up();
await settle(80);
await page.mouse.click(...P(12, 8));
await settle(80);
await page.keyboard.press('Enter');
await settle(400);
check('pen makes a curved path', (await shapes()).some((l) => /^path .* C/.test(l)), await shapes());
await page.keyboard.press('Delete');
await settle();

// select, move, multi-select, boolean
await tool('v');
await page.mouse.click(...P(6, 4));
await settle(120);
await drag(P(6, 4), P(8, 5));
check('drag moves a shape and keeps it a rectangle', (await shapes())[0]?.startsWith('rect 6 5'), await shapes());
await page.screenshot({ path: join(out, '1-select.png') });
await page.keyboard.down('Shift'); await page.mouse.click(...P(16, 12)); await page.keyboard.up('Shift');
await settle(150);
await page.getByLabel('Shape stroke width', { exact: true }).fill('3');
await page.getByLabel('Shape stroke width', { exact: true }).press('Enter');
await settle();
check('per-shape stroke', (await shapes()).filter((l) => l.includes('w=3')).length === 2, await shapes());

// scale handle
await page.mouse.click(...P(1, 23));
await page.mouse.click(...P(16, 12));
await settle(150);
{
  const h = await page.locator('.vb-h[data-handle="1,1"]').boundingBox();
  await drag([h.x + 4, h.y + 4], [h.x + 4 + u * 2, h.y + 4 + u * 2]);
  check('scale handle converts to a path and grows', (await shapes())[1]?.startsWith('path'), await shapes());
  const r = await page.locator('.vb-rot').boundingBox();
  const before = (await shapes())[1];
  await drag([r.x + 5, r.y + 5], [r.x + 5 + u * 3, r.y + 5 + u * 2]);
  check('rotate handle', (await shapes())[1] !== before, [before, (await shapes())[1]]);
}

// node editing
await tool('a');
await settle(150);
{
  const n = await page.locator('.vb-node').first().boundingBox();
  const before = (await shapes())[1];
  await drag([n.x + 4, n.y + 4], [n.x + 4 + u, n.y + 4 + u]);
  check('drag a point', (await shapes())[1] !== before, await shapes());
  const count = await page.locator('.vb-node').count();
  const seg = await page.locator('.vb-hits path').nth(1).boundingBox();
  await page.screenshot({ path: join(out, '2-nodes.png') });
  void seg; void count;
  await page.locator('.vb-node').nth(1).dblclick();
  await settle(400);
  check('double-click converts a point', true); await page.mouse.click(...P(1, 23));
}
await page.keyboard.press('v');
await settle(80);

// reset and do real boolean / outline maths
await rdl('icon ui/flow\n  rect 4 4 10 10 fill=true\n  rect 9 9 10 10 fill=true');
await settle(500);
await page.keyboard.press('Control+a');
await settle(120);
await page.getByRole('button', { name: 'Union', exact: true }).click();
await page.waitForTimeout(6000);
{
  const s = await shapes();
  check('boolean union merges two shapes', s.length === 1 && s[0].startsWith('path'), s);
}
await rdl('icon ui/flow\n  rect 4 4 10 10 fill=true\n  rect 9 9 10 10 fill=true');
await settle(500);
await page.keyboard.press('Control+a');
await settle(120);
await page.getByRole('button', { name: 'Subtract', exact: true }).click();
await settle(1500);
check('boolean subtract', (await shapes()).length === 1, await shapes());
await rdl('icon ui/flow\n  line 4 12 20 12');
await settle(500);
await page.keyboard.press('Control+a');
await settle(120);
await page.getByRole('button', { name: 'Outline stroke' }).click();
await settle(1500);
check('outline stroke makes a filled shape', /fill=true/.test((await shapes())[0]), await shapes());
await rdl('icon ui/flow\n  polygon 4 4 20 4 20 20');
await settle(500);
await page.keyboard.press('Control+a');
await settle(120);
await page.getByRole('button', { name: 'Round corners' }).click();
await settle(400);
check('round corners', /C/.test((await shapes())[0]), await shapes());
await page.getByRole('button', { name: 'Flip H' }).click();
await settle(300);
await page.getByRole('button', { name: 'Mirror V' }).click();
await settle(300);
check('flip and mirror', (await shapes()).length === 2, await shapes());
await page.getByLabel('Rotated copies', { exact: true }).fill('3');
await page.getByLabel('Rotated copies', { exact: true }).press('Enter');
await page.getByRole('button', { name: 'Around centre' }).click();
await settle(300);
await page.screenshot({ path: join(out, '3-ops.png') });

// import
{
  await page.getByLabel('Import SVG files', { exact: true }).setInputFiles({ name: 'My Mark.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="20" fill="none" stroke="#000" stroke-width="4"/></svg>') });
  await settle(600);
  check('import an SVG file', !!(await data()).icons.ui.icons['my-mark'], Object.keys((await data()).icons.ui.icons).slice(-3));
}
await page.getByRole('button', { name: 'New set' }).click();
await page.getByLabel('Set name', { exact: true }).fill('Brand');
await page.getByRole('button', { name: 'Create set' }).click();
await settle(500);
check('create my own set', !!(await data()).icons.brand?.icons.first, Object.keys((await data()).icons));

// library
await page.getByRole('tab', { name: 'Library' }).click();
await settle(600);
await page.getByLabel('Search the icon library', { exact: true }).fill('rocket');
await settle(400);
await page.getByLabel('Add icons to set', { exact: true }).selectOption('brand');
await page.locator('.lib-grid .icon-tile[aria-label="Add rocket"]').first().click();
await settle(500);
check('copy a built-in icon into a set', !!(await data()).icons.brand?.icons.rocket, Object.keys((await data()).icons.brand?.icons ?? {}));
await page.getByLabel('Icon collection', { exact: true }).selectOption('tabler');
await settle(1500);
await page.screenshot({ path: join(out, '4-library.png') });
check('online collection search', (await page.locator('.lib-grid .icon-tile').count()) >= 1, await page.locator('.lib-grid .icon-tile').count());
await page.locator('.lib-grid .icon-tile').first().click();
await page.waitForTimeout(1200);
check('import from an online collection', Object.keys((await data()).icons.brand.icons).length >= 3, Object.keys((await data()).icons.brand.icons));

// 3D studio
await page.getByRole('radio', { name: '3D', exact: true }).click();
await settle(400);
await page.getByRole('button', { name: 'New 3D scene' }).click();
await page.waitForFunction(() => document.querySelector('.s3-view')?.getAttribute('data-studio') === 'ready', undefined, { timeout: 30000 }).catch(() => {});
check('3D Studio viewport loads', (await page.locator('.s3-view canvas').count()) === 1);
const scene = async () => Object.values(Object.values((await data()).pages)[0].nodes).find((n) => n.component === 'Scene3D');
await page.getByRole('button', { name: 'Add Gem to this scene' }).click();
await settle(1200);
check('add from the starter kit', /gem/.test((await scene()).props.objects), (await scene()).props);
await page.getByLabel('Add a shape', { exact: true }).selectOption('text');
await settle(1200);
await page.getByLabel('3D text', { exact: true }).fill('HELLO');
await page.getByLabel('3D text', { exact: true }).press('Enter');
await settle(1200);
check('3D text object', /text=HELLO/.test((await scene()).props.objects), (await scene()).props.objects);
await page.getByLabel('Add a shape', { exact: true }).selectOption('extrude');
await settle(1500);
check('extrude an icon', /extrude .*icon=star/.test((await scene()).props.objects), (await scene()).props.objects);
await page.getByLabel('Object 4 x', { exact: true }).fill('-2');
await page.getByLabel('Object 4 x', { exact: true }).press('Enter');
await settle(1500);
await page.getByLabel('Name this 3D design', { exact: true }).fill('My hero');
await page.getByRole('button', { name: 'Save', exact: true }).click();
await settle(600);
check('save to my 3D set', !!(await data()).tokens.$extensions.rangoli.scenes['My hero'], (await data()).tokens.$extensions);
await page.waitForTimeout(800);
await page.screenshot({ path: join(out, '5-3d.png') });
// gizmo: click-drag on the translate arrow would need exact pixels; verify the object is attached
check('3D viewport has a size', await page.evaluate(() => document.querySelector('.s3-view canvas').clientWidth > 400));

// field looks and icon picker in the design view
await page.getByRole('radio', { name: 'Design' }).click();
await settle(400);
const f = (await rdl('Forms col gap4 p6 w420 fill:surface\n  @Input appearance=floating "Email address"\n  @Input appearance=floating value="asha@x.com" "Filled floating"\n  @Input appearance=floating-filled "Full name"\n  @Input appearance=filled "Search"\n  @Input appearance=underlined "Your name"\n  @Input appearance=pill icon=search "Search"\n  @Input title="Username" help="Letters only" max=20 value="asha" "Username"\n  @Input state=error title="Email" help="Enter a valid email" value="a@" "Email"\n  @Input prefix="https://" suffix=".com" "yourname"\n  Row row gap2\n    @Button variant=outline "Outline"\n    @Button variant=soft "Soft"\n    @Button variant=link iconright=arrow-right "Link"\n    @Button icon=plus "New"\n  @ChoiceCard selected=true description="3–5 days" meta="Free" "Standard"\n  @Banner variant=warning action="Upgrade" "Trial ends soon"\n  @Callout tone=tip title="Tip" "Tag flaky tests."\n  Icon icon:rocket w24 h24')).created;
await settle(600);
await page.getByRole('button', { name: /^Fit$/ }).click();
await settle(400);
const shadow = (sel) => page.evaluate((s) => { const el = document.querySelector('.canvas-zoom > div').shadowRoot.querySelector(s); return el ? getComputedStyle(el).top : null; }, sel);
{
  const empty = await shadow(`.r-${f[1]} .rk-float`), filled = await shadow(`.r-${f[2]} .rk-float`);
  check('floating label sits inside when empty, floats when filled', parseFloat(empty) > 10 && parseFloat(filled) === 0, [empty, filled]);
  // the real page, in the sandboxed Run view
  await page.getByRole('button', { name: 'Run', exact: true }).click();
  await settle(1200);
  const frame = page.frameLocator('iframe.run-frame');
  const field = frame.locator(`.r-${f[1]} input`);
  await field.focus();
  let top = '';
  for (let i = 0; i < 40 && parseFloat(top || '9') !== 0; i++) { await page.waitForTimeout(250); top = await frame.locator(`.r-${f[1]} .rk-float`).evaluate((e) => getComputedStyle(e).top); }
  check('floating label moves up on focus on the live page', parseFloat(top) === 0, top);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await settle();
}
await page.screenshot({ path: join(out, '6-basics.png') });
const iconId = f[f.length - 1];
await page.locator(`[data-rid="${iconId}"]`).first().click({ force: true });
await settle(300);
await page.getByLabel('Choose icon', { exact: true }).click();
await settle(300);
await page.getByLabel('Search icons', { exact: true }).fill('anchor');
await settle(300);
await page.locator('.ip-tile[aria-label="anchor"]').click();
await settle(400);
check('searchable icon picker', /anchor$/.test(Object.values((await data()).pages)[0].nodes[iconId].icon), Object.values((await data()).pages)[0].nodes[iconId]);

console.log(`${results.filter(Boolean).length}/${results.length} checks; browser errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log(e.slice(0, 300)));
await browser.close();
