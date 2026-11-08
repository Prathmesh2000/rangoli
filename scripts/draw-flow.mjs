// Browser flow: drawing tools, full inspector, move/resize, create component, language + token editing.
// usage: node scripts/draw-flow.mjs <baseUrl> <outDir>
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const base = process.argv[2];
const out = process.argv[3];
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
await page.goto(base + 'editor/');
await page.waitForSelector('.draw-tools');

const api = (p, b) => page.evaluate(async ([p, b]) => {
  const r = await fetch(p, b ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) } : { cache: 'no-store' });
  return { status: r.status, json: await r.json() };
}, [p, b]);
const rdl = async (script) => { const r = await api('/api/rdl', { script }); if (r.status !== 200) throw new Error(JSON.stringify(r.json)); return r.json; };
const data = async () => { const j = (await api('/api/doc')).json; return j.doc ?? j.data ?? j; };
const nodes = async () => Object.values((await data()).pages)[0].nodes;
const settle = () => page.waitForTimeout(350);
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  ${JSON.stringify(detail)}`}`); };

const seed = await rdl('Screen col p6 gap4 w800 h560 fill:surface\n  Title text title "Draw here"\n  Card col p4 gap2 w320 fill:canvas stroke:border r3\n    Heading text title-sm "Plan"\n    Body text body "Inner"');
const screen = seed.created[0], card = seed.created[2];
await settle();
await page.getByRole('button', { name: /^Fit$/ }).click();
await settle();

const box = async (id) => page.locator(`[data-rid="${id}"]`).first().boundingBox();
const before = async () => new Set(Object.keys(await nodes()));
const created = async (old) => Object.values(await nodes()).filter((x) => !old.has(x.id));
async function drawDrag(key, fromX, fromY, toX, toY) {
  const old = await before();
  await page.keyboard.press(key);
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(toX, toY, { steps: 5 });
  await page.mouse.up();
  await settle();
  return (await created(old))[0];
}
const s = await box(screen);
const rect = await drawDrag('r', s.x + s.width * .55, s.y + s.height * .2, s.x + s.width * .75, s.y + s.height * .4);
check('rectangle is an absolute frame', rect?.type === 'frame' && rect.absolute === true && rect.parent === screen, rect);
const ell = await drawDrag('o', s.x + s.width * .78, s.y + s.height * .2, s.x + s.width * .95, s.y + s.height * .4);
check('ellipse is round', ell?.style?.radius?.token === 'radius.full', ell);
const line = await drawDrag('l', s.x + s.width * .1, s.y + s.height * .9, s.x + s.width * .4, s.y + s.height * .75);
check('line is a vector path', line?.type === 'vector' && /^M\d+ \d+ L\d+ \d+$/.test(line.vector.paths[0].d), line);
const text = await drawDrag('t', s.x + s.width * .55, s.y + s.height * .5, s.x + s.width * .55, s.y + s.height * .5);
check('text placed', text?.type === 'text' && text.absolute, text);

// pen: corner, curve, corner, Enter
{
  const old = await before();
  await page.keyboard.press('p');
  const P = (a, b) => [s.x + s.width * a, s.y + s.height * b];
  await page.mouse.click(...P(.5, .7));
  await page.mouse.move(...P(.65, .62));
  await page.mouse.down();
  await page.mouse.move(...P(.72, .62), { steps: 4 });
  await page.mouse.up();
  await page.mouse.click(...P(.85, .8));
  await settle();
  await page.screenshot({ path: join(out, '1-pen-preview.png') });
  await page.keyboard.press('Enter');
  await settle();
  const pen = (await created(old))[0];
  check('pen path has a curve', pen?.type === 'vector' && /C/.test(pen.vector.paths[0].d) && pen.absolute, pen);
}
// frame on empty canvas = new screen
{
  const old = await before();
  const c = await page.locator('.canvas').boundingBox();
  await page.keyboard.press('f');
  await page.mouse.move(c.x + c.width - 60, c.y + c.height - 60);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width - 20, c.y + c.height - 20, { steps: 3 });
  await page.mouse.up();
  await settle();
  const f = (await created(old))[0];
  check('frame on empty canvas is a new top-level screen', f?.type === 'frame' && !f.parent && !f.absolute, f);
  if (f) await rdl(`delete #${f.id}`);
  await settle();
}
await page.screenshot({ path: join(out, '2-drawn.png') });

// inspector on the rectangle
await page.locator(`[data-rid="${rect.id}"]`).first().click({ force: true });
await settle();
const fill = async (label, v) => { const i = page.getByLabel(label, { exact: true }); await i.fill(v); await i.press('Enter'); await settle(); };
const open = async (t) => { const b = page.locator('.section-toggle', { hasText: t }).first(); if ((await b.getAttribute('aria-expanded')) === 'false') await b.click(); await settle(); };
const cur = async () => (await nodes())[rect.id];
await fill('Fill', 'primary.200~50');
check('fill with alpha', (await cur()).style.fill[0].alpha === 50, (await cur()).style);
await fill('Border colour', 'primary.600');
await fill('Border width', '2');
await page.getByRole('radio', { name: 'Dash' }).click();
await settle();
check('dashed border', (await cur()).style.stroke.style === 'dashed' && (await cur()).style.stroke.width === 2, (await cur()).style.stroke);
await page.locator('.tog', { hasText: /^T$/ }).first().click();
await settle();
check('per-side border', (await cur()).style.stroke.sides === 'rbl', (await cur()).style.stroke);
await page.locator('.section-head', { hasText: 'Corners' }).getByRole('button', { name: 'Each' }).click();
await settle();
await fill('Top left', '24');
check('per-corner radius', JSON.stringify((await cur()).style.radius).startsWith('[24'), (await cur()).style.radius);
await open('Shadow');
const addLayer = page.locator('.section-head', { hasText: 'Shadow' }).getByRole('button', { name: 'Add layer' });
await addLayer.click();
await settle();
await addLayer.click();
await settle();
check('two shadow layers', (await cur()).style.shadow?.length === 2, (await cur()).style.shadow);
await page.getByRole('button', { name: 'Remove shadow layer 2' }).click();
await settle();
check('remove shadow layer', (await cur()).style.shadow?.length === 1, (await cur()).style.shadow);
await open('Effects');
await fill('Opacity from 0 to 1', '0.8');
await fill('Backdrop blur in px', '6');
await page.getByRole('radio', { name: 'Clip' }).click();
await settle();
await open('Position');
await fill('Rotation in degrees', '4');
await fill('Stack order', '2');
await open('Custom CSS');
{
  const a = page.getByLabel('Custom CSS', { exact: true });
  await a.fill('filter:saturate(1.2)');
  await a.blur();
  await settle();
  const st = (await cur()).style;
  check('effects, rotate, z, css', st.opacity === .8 && st.backdropBlur === 6 && st.overflow === 'hidden' && st.rotate === 4 && st.z === 2 && st.css?.includes('saturate'), st);
}
await fill('Opacity from 0 to 1', '');
check('clearing a field unsets it', (await cur()).style.opacity === undefined, (await cur()).style);
await page.getByRole('radio', { name: 'Linear' }).click();
await settle();
await fill('Gradient angle', '45');
check('gradient', (await cur()).style.fill[0].gradient?.angle === 45, (await cur()).style.fill);
await page.screenshot({ path: join(out, '3-inspector.png') });

// move + resize
{
  const b0 = await cur();
  const r = await box(rect.id);
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.mouse.move(r.x + r.width / 2 + 40, r.y + r.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await settle();
  const b1 = await cur();
  check('drag moves', b1.position.x > b0.position.x && b1.position.y > b0.position.y, [b0.position, b1.position]);
  const g = await page.locator('.ov-grip').boundingBox();
  await page.mouse.move(g.x + 5, g.y + 5);
  await page.mouse.down();
  await page.mouse.move(g.x + 45, g.y + 35, { steps: 4 });
  await page.mouse.up();
  await settle();
  const b2 = await cur();
  check('grip resizes', b2.size.w.v > b1.size.w.v, [b1.size, b2.size]);
  check('still selected after drag', (await page.locator('.inspector-sub').textContent()).includes(rect.id));
  await page.locator('.canvas').focus().catch(() => {});
  await page.keyboard.press('ArrowRight');
  await settle();
  check('arrow nudges', (await cur()).position.x === b2.position.x + 1, (await cur()).position);
}

// typography on text
await page.locator(`[data-rid="${text.id}"]`).first().click({ force: true });
await settle();
await fill('Font size', '28');
await fill('Letter spacing', '-0.02em');
await page.getByRole('button', { name: 'I', exact: true }).click();
await settle();
await page.getByRole('radio', { name: 'AA', exact: true }).click();
await settle();
{
  const t = (await nodes())[text.id].style;
  check('typography', t.font.size === 28 && t.font.letterSpacing === '-0.02em' && t.italic && t.textTransform === 'uppercase', t);
}

// create a building block from the card
await page.locator(`[data-rid="${card}"]`).first().click({ force: true, position: { x: 3, y: 3 } });
await settle();
await open('Building block');
await fill('Component name', 'PlanCard');
await page.getByRole('button', { name: 'Create', exact: true }).click();
await settle();
check('create component', (await nodes())[card].component === 'PlanCard', (await nodes())[card]);
await page.screenshot({ path: join(out, '4-component.png') });
await fill('heading', 'Team');
check('slot edit', (await nodes())[card].props?.heading === 'Team', (await nodes())[card].props);

// restyle a library component from the panel
const btn = (await rdl(`insert #${screen} end\n  @Button "Go"`)).created[0];
await settle();
await page.locator(`[data-rid="${btn}"]`).first().click({ force: true });
await settle();
await page.getByRole('button', { name: /Restyle all Buttons/ }).click();
await settle();
await page.getByLabel('Component rules', { exact: true }).fill('component @Button\n  variant=pill rfull px6');
await page.getByRole('button', { name: 'Apply', exact: true }).click();
await settle();
check('restyle component', (await data()).components.Button.axes.variant.includes('pill'));

// tokens: language gallery + editing
await page.getByRole('tab', { name: 'Tokens' }).click();
await settle();
await page.locator('.lang-card', { hasText: 'Editorial' }).click();
await settle();
check('language switch', (await data()).tokens.$extensions?.rangoli?.language?.id === 'editorial', (await data()).tokens.$extensions);
await page.screenshot({ path: join(out, '5-tokens.png') });
await fill('size.control.md', '50');
check('token edit', (await data()).tokens.size.control.md.$value === 50, (await data()).tokens.size.control.md);
await fill('textStyle.body size', '17');
check('type token edit', (await data()).tokens.textStyle.body.$value.fontSize === 17, (await data()).tokens.textStyle.body);
await fill('color.bg.surface value', '#fffaf0');
{
  const t = (await data()).tokens.color.bg.surface;
  check('semantic colour edit keeps dark', t.$value === '#fffaf0' && !!t.$extensions?.rangoli?.modes?.dark, t);
}
await page.getByRole('radio', { name: 'Dark' }).click();
await settle();
await page.screenshot({ path: join(out, '6-dark.png') });
console.log(`${results.filter(Boolean).length}/${results.length} checks; browser errors: ${errors.length}`);
errors.slice(0, 8).forEach((e) => console.log(e));
await browser.close();
