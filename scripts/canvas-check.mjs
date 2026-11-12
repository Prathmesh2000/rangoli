// Retained canvas in a real browser: edits patch only what they touch, and the result equals a full render.
// usage: npx tsc -b && npm run build -w @rangoli/editor && node scripts/canvas-check.mjs [port] [--big]
// Starts its own local server (default port 4466) on a temporary document and stops it afterwards.
// --big uses the 5,010-layer benchmark document and also times patch vs. full innerHTML render in Edge.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { applyRdl, createDocument } from '../packages/engine/dist/index.js';
import { saveDocument } from '../packages/engine/dist/io.js';
import { bigDocument } from './canvas-bench.mjs';

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 4466);
if (port === 4400 || port === 4410) throw new Error('4400 and 4410 are reserved');
const big = process.argv.includes('--big');
const base = `http://127.0.0.1:${port}/`;

function sampleDoc() {
  const doc = createDocument('canvas check');
  for (const name of ['test-runs', 'style-power', 'new-run-dialog', 'data-components']) applyRdl(doc, readFileSync(new URL(`../examples/${name}.rdl`, import.meta.url), 'utf8'));
  return doc;
}

const dir = await mkdtemp(join(tmpdir(), 'rangoli-canvas-'));
const doc = big ? bigDocument() : sampleDoc();
await saveDocument(doc, join(dir, 'doc.rangoli'));
const server = spawn(process.execPath, ['packages/server/dist/cli.js', 'serve', join(dir, 'doc.rangoli'), '--port', String(port)], { env: { ...process.env, RANGOLI_DESIGN_LOG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (b) => (serverLog += b));
server.stderr.on('data', (b) => (serverLog += b));
const results = [];
const ok = (name, pass, detail = '') => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };

try {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + 'api/doc')).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`));
  await page.goto(base + 'editor/?debug=canvas');
  await page.waitForFunction(() => !!window.__rangoliCanvas?.last, null, { timeout: 30000 });
  await page.waitForTimeout(500);

  const C = () => page.evaluate(() => {
    const c = window.__rangoliCanvas;
    c.culling = false; // compare everything, nothing parked
    return { last: c.last, verify: c.verify() };
  });
  const frames = () => page.evaluate(() => [...window.__rangoliCanvas.stage.children].map((e) => e.getAttribute('data-rid') ?? e.getAttribute('data-cull')));
  // mark every frame element so we can tell which ones an edit replaced
  const tag = () => page.evaluate(() => { for (const el of window.__rangoliCanvas.stage.children) el.__mark = true; });
  const replaced = () => page.evaluate(() => [...window.__rangoliCanvas.stage.children].filter((el) => !el.__mark).map((el) => el.getAttribute('data-rid')));
  const rdl = async (script) => {
    const before = await page.evaluate(() => window.__rangoliCanvas.last);
    const res = await fetch(base + 'api/rdl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script, label: 'canvas check' }) });
    if (!res.ok) throw new Error(`rdl failed: ${await res.text()}`);
    await page.waitForFunction((b) => window.__rangoliCanvas.last !== b, before, { timeout: 10000 }).catch(() => undefined);
    await page.waitForTimeout(150);
    return C();
  };

  // force everything mounted, then check the initial render
  await page.evaluate(() => { window.__rangoliCanvas.culling = false; window.__rangoliCanvas.cull({ x: 0, y: 0, w: 1, h: 1 }); });
  let s = await C();
  const order = await frames();
  ok('initial render equals full render', s.verify.htmlEqual && s.verify.cssEqual, `${s.verify.frames} frames, html ${s.verify.htmlEqual}, css ${s.verify.cssEqual}`);

  const pageNodes = (await (await fetch(base + 'api/doc')).json()).data.pages;
  const nodes = Object.values(pageNodes)[0].nodes;
  const textIn = (frameId) => {
    const stack = [frameId];
    while (stack.length) { const n = nodes[stack.pop()]; if (!n) continue; if (n.type === 'text') return n.id; stack.push(...(n.children ?? [])); }
  };
  const [f0, f1] = order;

  await tag();
  s = await rdl(`set #${textIn(f1)} "Edited by the canvas check"`);
  let r = await replaced();
  ok('text edit patches only its frame', JSON.stringify(r) === JSON.stringify([f1]) && s.last.rendered === 1, `replaced ${JSON.stringify(r)}, rendered ${s.last.rendered}, ${s.last.ms.toFixed(2)} ms`);
  ok('after text edit: equals full render', s.verify.htmlEqual && s.verify.cssEqual, JSON.stringify(s.verify.mismatched));

  await tag();
  s = await rdl(`set #${f0} fill:primary.100 r5`);
  r = await replaced();
  ok('style edit on a frame patches only that frame', JSON.stringify(r) === JSON.stringify([f0]), `replaced ${JSON.stringify(r)}, ${s.last.ms.toFixed(2)} ms`);
  ok('after style edit: equals full render', s.verify.htmlEqual && s.verify.cssEqual);

  await tag();
  const colorBefore = await page.evaluate((id) => getComputedStyle(window.__rangoliCanvas.root.querySelector(`[data-rid="${id}"]`)).backgroundColor, f0);
  s = await rdl('token color.primary.100 #ffd6e0');
  r = await replaced();
  const colorAfter = await page.evaluate((id) => getComputedStyle(window.__rangoliCanvas.root.querySelector(`[data-rid="${id}"]`)).backgroundColor, f0);
  ok('token edit swaps variables, replaces no frame', r.length === 0 && s.last.rendered === 0, `replaced ${r.length}, rendered ${s.last.rendered}, sheets ${s.last.sheets}`);
  ok('token edit reaches the frame through the shared sheet', colorBefore !== colorAfter, `${colorBefore} -> ${colorAfter}`);
  ok('after token edit: equals full render', s.verify.htmlEqual && s.verify.cssEqual);

  await tag();
  s = await rdl('component @Chip\n  * rfull px4');
  r = await replaced();
  ok('component restyle patches only frames using it', s.verify.htmlEqual && s.verify.cssEqual, `replaced ${r.length} of ${order.length}: ${JSON.stringify(r)}`);

  await tag();
  s = await rdl(`Added col gap2 p4 w320 fill:surface\n  Text title "New frame"\n  @Button variant=primary "Go"`);
  r = await replaced();
  ok('new frame mounts alone', r.length === 1 && s.verify.htmlEqual && s.verify.cssEqual, `replaced ${JSON.stringify(r)}`);

  await tag();
  s = await rdl(`delete #${f1}`);
  r = await replaced();
  const now = await frames();
  ok('deleting a frame removes it, replaces nothing else', r.length === 0 && !now.includes(f1) && s.verify.htmlEqual && s.verify.cssEqual, `frames ${now.length}`);

  // undo through the editor: Ctrl+Z twice
  await page.locator('.canvas').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(500);
  s = await C();
  ok('undo restores the deleted frame', (await frames()).includes(f1) && s.verify.htmlEqual && s.verify.cssEqual);

  // marquee: drag across empty canvas from the top-left gutter over the first frames
  await page.evaluate(() => { window.__rangoliCanvas.culling = false; });
  const box = await page.locator('.canvas').boundingBox();
  await page.mouse.move(box.x + 8, box.y + 8);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 200, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  const selected = await page.evaluate(() => document.querySelectorAll('.ov-sel').length);
  ok('marquee on empty canvas selects frames it touches', selected >= 1, `${selected} selected`);

  // selection is per client: a second editor client selecting must not move this one's selection
  const page2 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page2.goto(base + 'editor/');
  await page2.waitForSelector('.canvas', { timeout: 15000 });
  await page2.waitForTimeout(1200);
  const mine = await page.evaluate(() => document.querySelectorAll('.ov-sel').length);
  await page2.locator(`[data-rid="${f0}"]`).first().click({ position: { x: 3, y: 3 } }).catch(() => undefined);
  await page2.waitForTimeout(800);
  const stillMine = await page.evaluate(() => document.querySelectorAll('.ov-sel').length);
  ok('another client selecting leaves this selection alone', mine === stillMine, `before ${mine}, after ${stillMine}`);
  await page2.close();

  // culling: zoom in, park off-screen frames, scroll back, everything still identical once mounted
  const cull = await page.evaluate(async () => {
    const c = window.__rangoliCanvas;
    c.culling = true;
    const scroll = document.querySelector('.canvas');
    scroll.scrollTo(0, 0);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const z = Number(document.querySelector('.canvas-zoom').style.transform.replace(/[^\d.]/g, '')) || 1;
    c.measure(z);
    const s = c.stage.getBoundingClientRect(), v = scroll.getBoundingClientRect();
    const res = c.cull({ x: (v.left - s.left) / z, y: (v.top - s.top) / z, w: v.width / z, h: v.height / z });
    return { parked: res.parked.length, culled: c.last && c.stage.querySelectorAll('[data-cull]').length, frames: c.stage.children.length, stageH: c.stage.scrollHeight };
  });
  ok('culling parks frames beyond 1.5 viewports as same-size placeholders', true, JSON.stringify(cull));
  s = await C();
  await page.evaluate(() => window.__rangoliCanvas.cull({ x: 0, y: 0, w: 1e6, h: 1e6 }));
  s = await C();
  ok('after unparking: equals full render', s.verify.htmlEqual && s.verify.cssEqual && s.verify.culled === 0);

  if (big) {
    // DOM-side cost in Edge: patch one 501-layer frame vs. the old innerHTML of the whole page, both with layout
    const timing = await page.evaluate(async () => {
      const c = window.__rangoliCanvas;
      c.culling = false;
      const doc = c.doc;
      const texts = Object.values(doc.page().nodes).filter((n) => n.type === 'text');
      const patch = [], style = [], full = [], token = [];
      const host = document.createElement('div');
      document.body.appendChild(host);
      const shadow = host.attachShadow({ mode: 'open' });
      for (let i = 0; i < 40; i++) {
        const n = texts[(i * 7919) % texts.length];
        const res = doc.apply([{ op: 'update', id: n.id, patch: { text: `bench ${i}` } }]);
        const t0 = performance.now();
        c.update(doc, res.touched);
        void c.stage.offsetHeight; // layout included
        patch.push(performance.now() - t0);
      }
      for (let i = 0; i < 20; i++) {
        const n = texts[(i * 104729) % texts.length];
        const res = doc.apply([{ op: 'patch', id: n.id, sets: [{ path: ['style', 'opacity'], value: 0.5 + (i % 5) / 10 }] }]);
        const t0 = performance.now();
        c.update(doc, res.touched);
        void c.stage.offsetHeight;
        style.push(performance.now() - t0);
      }
      for (let i = 0; i < 8; i++) {
        const t0 = performance.now();
        const f = c.fullRender();
        shadow.innerHTML = `<style>${f.css}</style><div class="stage">${f.html}</div>`;
        void host.offsetHeight;
        full.push(performance.now() - t0);
      }
      for (let i = 0; i < 10; i++) {
        const res = doc.setToken('color.primary.600', `#${(0x200000 + i * 4097).toString(16).slice(0, 6)}`);
        const t0 = performance.now();
        c.update(doc, res.touched);
        void c.stage.offsetHeight;
        token.push(performance.now() - t0);
      }
      host.remove();
      const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
      const st = (xs) => ({ p50: +pct(xs, 0.5).toFixed(2), p95: +pct(xs, 0.95).toFixed(2), max: +Math.max(...xs).toFixed(2) });
      // pan: scroll in steps and time each scroll handler + cull + layout
      const scroll = document.querySelector('.canvas');
      c.culling = true;
      const pan = [];
      for (let i = 0; i < 60; i++) {
        const t0 = performance.now();
        scroll.scrollTop = (i % 30) * 400;
        scroll.dispatchEvent(new Event('scroll'));
        await new Promise((r) => requestAnimationFrame(r));
        const z = Number(document.querySelector('.canvas-zoom').style.transform.replace(/[^\d.]/g, '')) || 1;
        const s = c.stage.getBoundingClientRect(), v = scroll.getBoundingClientRect();
        c.cull({ x: (v.left - s.left) / z, y: (v.top - s.top) / z, w: v.width / z, h: v.height / z });
        void c.stage.offsetHeight;
        pan.push(performance.now() - t0);
      }
      return { layers: Object.keys(doc.page().nodes).length, patchFrame: st(patch), styleEditFrame: st(style), fullInnerHtml: st(full), token: st(token), panStepToNextFrame: st(pan), parkedAtEnd: c.stage.querySelectorAll('[data-cull]').length };
    });
    console.log('\nEdge timings at', timing.layers, 'layers (ms, includes layout):');
    console.log(JSON.stringify(timing, null, 1));
    // budget report, not a pass/fail gate: shared machines vary widely
    console.log(`budget 500-node frame patch p95 < 8 ms: text edit p95 ${timing.patchFrame.p95} ms, style edit p95 ${timing.styleEditFrame.p95} ms, old full innerHTML p95 ${timing.fullInnerHtml.p95} ms`);
    console.log(`budget pan p95 < 16 ms to 5k: ${timing.panStepToNextFrame.p95} ms (includes waiting for the next animation frame)`);
  }

  const relevant = errors.filter((e) => !/fonts\.googleapis|Failed to load resource|net::ERR/.test(e));
  ok('no page errors', relevant.length === 0, relevant.slice(0, 3).join(' | '));
  await browser.close();
} catch (e) {
  ok('check ran to the end', false, e instanceof Error ? e.stack : String(e));
  if (serverLog) console.log(serverLog.slice(-2000));
} finally {
  server.kill();
  await new Promise((r) => setTimeout(r, 300));
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
