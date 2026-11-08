import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { compileIcon } from './icons.js';
import { IMAGE_TEMPLATES, validateOps, type AssetMeta } from './images.js';
import { lint } from './lint.js';
import { applyRdl, serializeRdl } from './rdl.js';
import { renderFragment } from './render.js';

const photo = (over: Partial<AssetMeta> = {}): AssetMeta => ({ id: 'a1b2c3d4e5f6', name: 'hero.jpg', file: 'a1b2c3d4e5f6.jpeg', mime: 'image/jpeg', w: 1600, h: 900, bytes: 180_000, source: 'upload', time: 0, ...over });

describe('image nodes', () => {
  it('references assets by id or name, renders <img> with size + lazy loading, round-trips', () => {
    const doc = createDocument();
    doc.apply([{ op: 'setAsset', id: 'a1b2c3d4e5f6', meta: photo() }]);
    applyRdl(doc, 'Image asset:hero.jpg w640 h360 fit:cover alt:"Test run dashboard on a laptop"');
    expect(doc.node('n1')).toMatchObject({ type: 'image', image: { asset: 'a1b2c3d4e5f6', fit: 'cover', alt: 'Test run dashboard on a laptop' } });
    const { html, css } = renderFragment(doc, { assetBase: '/assets/' });
    expect(html).toContain('<img class="r-n1" src="/assets/a1b2c3d4e5f6.jpeg" alt="Test run dashboard on a laptop" width="1600" height="900" loading="lazy" decoding="async">');
    expect(css).toContain('object-fit:cover');
    const out = serializeRdl(doc);
    expect(out).toBe('Image#n1 w640 h360 asset:a1b2c3d4e5f6 fit:cover alt:"Test run dashboard on a laptop"');
    const doc2 = createDocument();
    doc2.apply([{ op: 'setAsset', id: 'a1b2c3d4e5f6', meta: photo() }]);
    applyRdl(doc2, out);
    expect(serializeRdl(doc2)).toBe(out);
  });

  it('placeholder slot when no asset, error for unknown asset', () => {
    const doc = createDocument();
    applyRdl(doc, 'Image w320 h180 alt:"Product screenshot"');
    expect(renderFragment(doc).html).toContain('role="img" aria-label="Product screenshot"');
    expect(() => applyRdl(doc, 'Image asset:nope.png')).toThrow(/Unknown asset "nope.png"/);
  });

  it('lints alt text, weight, upscaling, distortion and missing files', () => {
    const doc = createDocument();
    doc.apply([{ op: 'setAsset', id: 'a1b2c3d4e5f6', meta: photo({ w: 400, h: 400, bytes: 900_000 }) }]);
    applyRdl(doc, 'Image asset:a1b2c3d4e5f6 w640 h360 fit:fill');
    const codes = lint(doc).filter((i) => i.node === 'n1').map((i) => i.code).sort();
    expect(codes).toEqual(['A01', 'A02', 'A03', 'A04']);
    applyRdl(doc, 'set #n1 decorative fit:cover');
    expect(lint(doc).filter((i) => i.node === 'n1').map((i) => i.code)).not.toContain('A01');
    doc.apply([{ op: 'setAsset', id: 'a1b2c3d4e5f6', meta: null }]);
    expect(lint(doc).some((i) => i.code === 'A05')).toBe(true);
  });
});

describe('edit recipes', () => {
  it('validates and computes output size', () => {
    expect(validateOps([{ op: 'crop', x: 100, y: 0, w: 1200, h: 900 }, { op: 'resize', w: 600 }, { op: 'rotate', deg: 90 }], 1600, 900)).toEqual({ w: 450, h: 600 });
    expect(() => validateOps([{ op: 'crop', x: 0, y: 0, w: 2000, h: 10 }], 1600, 900)).toThrow(/outside the 1600×900/);
    expect(() => validateOps([{ op: 'adjust', brightness: 5 }], 10, 10)).toThrow(/0–3/);
  });
});

describe('compositions', () => {
  it('templates are valid RDL, lint clean (P0–P2), and keep role:image', () => {
    for (const [k, t] of Object.entries(IMAGE_TEMPLATES)) {
      const doc = createDocument();
      const r = applyRdl(doc, t.rdl('Rangoli'));
      expect(doc.node(r.created[0]!).role, k).toBe('image');
      expect(lint(doc).filter((i) => i.severity !== 'P3' && !i.node.startsWith('icon:')), k).toEqual([]);
    }
  });

  it('illustration shapes accept colour tokens and fills', () => {
    const c = compileIcon('circle 48 48 30 fill=true c=primary.100\npath M30 60 L48 40 L66 60 c=primary.600');
    expect(c.shapes[0]).toMatchObject({ fill: true, color: 'primary.100' });
    expect(c.shapes[1]).toMatchObject({ fill: false, color: 'primary.600' });
    const doc = createDocument();
    applyRdl(doc, 'iconset art grid96 stroke3\nicon art/hill\n  circle 48 48 30 fill=true c=primary.100\n  path M30 60 L48 40 L66 60 c=primary.600\nIcon icon:art/hill w96 h96');
    const { html } = renderFragment(doc);
    expect(html).toContain('fill="var(--color-primary-100)"');
    expect(html).toContain('stroke="var(--color-primary-600)"');
  });
});
