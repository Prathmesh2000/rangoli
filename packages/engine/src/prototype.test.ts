import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { loadDocument, saveDocument } from './io.js';
import { motionCss } from './motion.js';
import { prototypeHtml } from './player.js';
import { serializePrototype, timelineDuration } from './prototype.js';
import { applyRdl } from './rdl.js';

const SCREENS = `
Login col w400 h300 p6 fill:canvas
  Title text headline "Sign in"
  @Button variant=primary "Sign in"
Home col w400 h300 p6 fill:canvas
  Title text headline "Welcome"
  @Button variant=secondary "Open dialog"
Dialog col w240 p4 fill:surface r4
  Text body "Hello"
  @Button variant=ghost "Close"
`;
// ids: Login n1 (n2 title, n3 btn) · Home n4 (n5, n6) · Dialog n7 (n8, n9)

describe('prototype RDL', () => {
  it('defines interactions, start screen and timelines; round-trips', () => {
    const doc = createDocument();
    applyRdl(doc, SCREENS);
    applyRdl(doc, `timeline welcome
  #n5 0 opacity:0, y:sm base out
  #n6 120 opacity:0 base out
proto start #n1
proto #n3
  click navigate #n4 smart base out
proto #n6
  click overlay #n7 dissolve fast
  hover swap variant=primary
proto #n9
  click close
  key:Escape close
proto #n5
  click play timeline:welcome`);
    expect(doc.data.prototype!.start).toBe('n1');
    expect(doc.data.prototype!.interactions.n3![0]).toMatchObject({ trigger: 'click', action: 'navigate', target: 'n4', transition: { type: 'smart' } });
    expect(doc.data.prototype!.interactions.n9![1]).toMatchObject({ trigger: 'key', key: 'Escape', action: 'close' });
    expect(timelineDuration(doc.data.timelines!.welcome!, doc.data.tokens)).toBe(320);
    const text = serializePrototype(doc.data.prototype, doc.data.timelines);
    expect(text).toContain('proto start #n1');
    expect(text).toContain('proto #n6\n  click overlay #n7 dissolve fast out\n  hover swap variant=primary smart fast out');
    expect(text).toContain('timeline welcome\n  #n5 0 opacity:0, y:sm base out\n  #n6 120 opacity:0 base out');
    // re-applying the serialized text is accepted
    const doc2 = createDocument();
    applyRdl(doc2, SCREENS);
    applyRdl(doc2, text);
    expect(serializePrototype(doc2.data.prototype, doc2.data.timelines)).toBe(text);
  });

  it('validates targets and actions', () => {
    const doc = createDocument();
    applyRdl(doc, SCREENS);
    expect(() => applyRdl(doc, 'proto #n3\n  click navigate #n8')).toThrow(/must be a top-level frame/);
    expect(() => applyRdl(doc, 'proto #n3\n  click navigate')).toThrow(/needs a target frame/);
    expect(() => applyRdl(doc, 'proto #n2\n  hover swap variant=primary')).toThrow(/must be a component instance/);
    expect(() => applyRdl(doc, 'proto #n3\n  hover swap variant=loud')).toThrow(/no variant=loud/);
    expect(() => applyRdl(doc, 'proto #n3\n  click play timeline:nope')).toThrow(/not defined/);
    expect(() => applyRdl(doc, 'proto #n3\n  dblclick navigate #n4')).toThrow(/Unknown trigger/);
    expect(() => applyRdl(doc, 'proto start #n2')).toThrow(/top-level frame/);
  });

  it('deleting a node drops its interactions and start; undo restores', () => {
    const doc = createDocument();
    applyRdl(doc, SCREENS);
    applyRdl(doc, 'proto start #n1\nproto #n1\n  delay:1000 navigate #n4 dissolve');
    applyRdl(doc, 'delete #n1');
    expect(doc.data.prototype!.start).toBeUndefined();
    expect(doc.data.prototype!.interactions.n1).toBeUndefined();
    doc.undo();
    expect(doc.data.prototype!.start).toBe('n1');
  });

  it('persists prototype + timelines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rangoli-proto-'));
    try {
      const doc = createDocument();
      applyRdl(doc, SCREENS);
      applyRdl(doc, 'timeline t1\n  #n2 0 opacity:0 base out\nproto start #n4\nproto #n3\n  click navigate #n4 push left');
      await saveDocument(doc, dir);
      const back = await loadDocument(dir);
      expect(serializePrototype(back.data.prototype, back.data.timelines)).toBe(serializePrototype(doc.data.prototype, doc.data.timelines));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('timeline CSS + player', () => {
  it('timelines export as class-triggered keyframes with reduced variants', () => {
    const doc = createDocument();
    applyRdl(doc, SCREENS);
    applyRdl(doc, 'timeline welcome\n  #n5 0 opacity:0, y:sm base out\n  #n6 120 opacity:0 base out');
    const css = motionCss(doc.data.motion, doc.data.tokens, doc.data.timelines);
    expect(css).toContain('.tl-welcome .r-n6,.r-n6.tl-welcome{animation:rg-tl-welcome-1 var(--motion-duration-base) var(--motion-easing-out) 120ms both}');
    expect(css).toMatch(/prefers-reduced-motion[^]*rg-tl-welcome-0-r\{from\{opacity:0\}to\{opacity:1\}\}/);
  });

  it('builds a standalone prototype with literal easings, swap templates and smart keys', () => {
    const doc = createDocument();
    applyRdl(doc, SCREENS);
    applyRdl(doc, 'proto start #n1\nproto #n3\n  click navigate #n4 smart base out\nproto #n6\n  hover swap variant=primary');
    const html = prototypeHtml(doc);
    const data = JSON.parse(/window.__RP__=(.*?);<\/script>/.exec(html)![1]!);
    expect(data.start).toBe('n1');
    expect(Object.keys(data.screens)).toEqual(['n1', 'n4', 'n7']);
    expect(data.interactions.n3[0]).toMatchObject({ ms: 200, ease: 'cubic-bezier(0.2,0,0,1)' });
    // same layer name path on both screens → smart-animate match
    expect(data.keys.n2).toBe('/Title');
    expect(data.keys.n5).toBe('/Title');
    expect(data.swaps['n6:0']).toContain('data-variant="primary"');
    expect(data.swaps['n6:0']).toContain('r-n6__s0');
    expect(html).toContain('.r-n6__s0{');
    expect(html).toContain('<section class="rp-screen" data-screen="n4" aria-label="Home">');
    expect(html).not.toContain('undefined');
  });
});
