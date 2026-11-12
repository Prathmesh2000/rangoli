import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { compileIcon, iconReact, iconSvg, shapeMarkup } from './icons.js';
import { applyRdl } from './rdl.js';
import { renderDocument, renderFragment } from './render.js';

describe('width profiles', () => {
  it('turn a stroke into a tapered filled outline', () => {
    const [s] = compileIcon('exact\nline 2 12 22 12 vw=0,4').shapes;
    expect(s!.fill).toBe(true);
    expect(s!.d.startsWith('M2 12')).toBe(true);
    expect(s!.d).toContain(' Z');
    expect(s!.d.split('L').length).toBeGreaterThan(20);
  });
  it('reject bad widths', () => {
    const diag: never[] = [];
    compileIcon('line 2 2 9 9 vw=a,b', diag);
    expect(diag).toHaveLength(1);
  });
});

describe('live symmetry', () => {
  it('mirrors left-right, both ways, and radially', () => {
    expect(compileIcon('line 2 4 8 4 sym=h12').shapes[1]!.d).toBe('M22 4 L16 4');
    expect(compileIcon('line 2 4 8 4 sym=hv12').shapes).toHaveLength(4);
    const radial = compileIcon('exact\nline 12 2 12 6 sym=r4c12').shapes;
    expect(radial).toHaveLength(4);
    expect(radial[1]!.d).toBe('M22 12 L18 12');
  });
  it('keeps the paint on every copy', () => {
    const s = compileIcon('rect 2 2 4 4 fill=true c=#ff0000 sym=v12').shapes;
    expect(s.map((x) => x.color)).toEqual(['#ff0000', '#ff0000']);
  });
});

describe('gradients in icons', () => {
  it('paint fills and strokes', () => {
    const [f] = compileIcon('circle 12 12 8 fill=true grad=135,#f59e0b,#ef4444').shapes;
    const m = shapeMarkup(f!);
    expect(m).toMatch(/<linearGradient id="(ig\w+)" gradientUnits="userSpaceOnUse"/);
    expect(m).toContain('stop-color="#f59e0b"');
    expect(m).toMatch(/fill="url\(#ig\w+\)"/);
    const [l] = compileIcon('line 2 12 22 12 grad=0,#000000,#ffffff').shapes;
    expect(shapeMarkup(l!)).toMatch(/stroke="url\(#ig\w+\)"/);
  });
  it('resolve colour tokens when rendered in a page, and refuse junk', () => {
    const doc = createDocument();
    applyRdl(doc, 'icon ui/g\n  circle 12 12 8 fill=true grad=90,primary.400,primary.800\nIcon icon:g w24 h24');
    expect(renderFragment(doc).html).toContain('stop-color="var(--color-primary-400)"');
    const diag: never[] = [];
    compileIcon('circle 12 12 8 grad="><script>', diag);
    expect(diag.length).toBeGreaterThan(0);
  });
  it('export valid React', () => {
    const doc = createDocument();
    applyRdl(doc, 'icon ui/g\n  circle 12 12 8 fill=true grad=90,#000000,#ffffff o=.5');
    const set = doc.data.icons!.ui!;
    const tsx = iconReact(set, set.icons.g!);
    expect(tsx).toContain('stopColor=');
    expect(tsx).not.toContain('stop-color');
    expect(iconSvg(set, set.icons.g!)).toContain('<linearGradient');
  });
});

describe('uploaded 3D models', () => {
  it('resolve to the asset file and keep the reference', () => {
    const doc = createDocument();
    doc.apply([{ op: 'setAsset', id: 'abcdefabcdef', meta: { id: 'abcdefabcdef', name: 'm.glb', file: 'abcdefabcdef.glb', mime: 'model/gltf-binary', w: 0, h: 0, bytes: 10, time: 1, source: 'upload' } as never }]);
    applyRdl(doc, '@Scene3D objects="model asset=abcdefabcdef s=2"');
    expect(renderDocument(doc, { assetBase: '/assets/' })).toContain('/assets/abcdefabcdef.glb');
  });
});
