import { describe, expect, it } from 'vitest';
import { besideFrame, boundsOf, FRAME_GAP, gapsAround, guidesFor, placeFrames, snapMove, zoomAt } from './canvas-layout.js';
import { changedVars, varsIn } from './frames.js';

describe('placeFrames', () => {
  it('flows frames without a position in a row, in page order', () => {
    const p = placeFrames([{ id: 'a', w: 100, h: 50 }, { id: 'b', w: 200, h: 80 }, { id: 'c', w: 10, h: 10 }]);
    expect(p.get('a')).toEqual({ x: 0, y: 0 });
    expect(p.get('b')).toEqual({ x: 100 + FRAME_GAP, y: 0 });
    expect(p.get('c')).toEqual({ x: 300 + 2 * FRAME_GAP, y: 0 });
  });

  it('keeps placed frames where they are and flows the rest to their right', () => {
    const p = placeFrames([{ id: 'a', at: { x: -500, y: 40 }, w: 100, h: 50 }, { id: 'b', w: 200, h: 80 }, { id: 'c', at: { x: 300, y: 900 }, w: 400, h: 10 }]);
    expect(p.get('a')).toEqual({ x: -500, y: 40 });
    expect(p.get('c')).toEqual({ x: 300, y: 900 });
    expect(p.get('b')).toEqual({ x: 700 + FRAME_GAP, y: 0 });
  });
});

describe('snapping and guides', () => {
  const others = [{ x: 0, y: 0, w: 100, h: 100 }, { x: 300, y: 0, w: 100, h: 100 }];

  it('snaps an edge within the threshold and reports the guide', () => {
    const r = snapMove({ x: 150, y: 200, w: 50, h: 50 }, 0, -197, others, 6); // top edge lands 3px under y=0
    expect(r.dy).toBe(-200);
    expect(r.guides.some((g) => g.axis === 'y' && g.at === 0)).toBe(true);
  });

  it('leaves movement alone outside the threshold', () => {
    const r = snapMove({ x: 150, y: 200, w: 50, h: 50 }, 0, 20, others, 6);
    expect(r).toMatchObject({ dx: 0, dy: 20 });
  });

  it('snaps centres to centres', () => {
    const r = snapMove({ x: 120, y: 0, w: 20, h: 20 }, -82, 0, [{ x: 0, y: 0, w: 100, h: 100 }], 4); // centre 48 -> 50
    expect(r.dx).toBe(-80);
  });

  it('measures the gap to the nearest neighbour on each side', () => {
    const g = gapsAround({ x: 150, y: 20, w: 50, h: 50 }, others);
    expect(g.find((x) => x.axis === 'x' && x.to === 150)?.size).toBe(50);
    expect(g.find((x) => x.axis === 'x' && x.from === 200)?.size).toBe(100);
    expect(g.filter((x) => x.axis === 'y')).toHaveLength(0);
  });

  it('merges guides on the same line', () => {
    const gs = guidesFor({ x: 150, y: 0, w: 50, h: 100 }, others);
    expect(gs.filter((g) => g.axis === 'y' && g.at === 0)).toHaveLength(1);
  });
});

describe('zoom to cursor', () => {
  it('keeps the design point under the cursor still', () => {
    const scroll = { x: 400, y: 200 }, cursor = { x: 300, y: 150 };
    const next = zoomAt(scroll, cursor, 1, 2);
    expect((next.x + cursor.x) / 2).toBeCloseTo((scroll.x + cursor.x) / 1);
    expect((next.y + cursor.y) / 2).toBeCloseTo((scroll.y + cursor.y) / 1);
  });
});

describe('besideFrame and boundsOf', () => {
  it('steps past frames already beside the source', () => {
    const at = besideFrame({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 180, y: 10, w: 50, h: 50 }], 80);
    expect(at).toEqual({ x: 310, y: 0 });
  });
  it('bounds', () => {
    expect(boundsOf([{ x: -5, y: 2, w: 10, h: 10 }, { x: 20, y: -4, w: 1, h: 1 }])).toEqual({ x: -5, y: -4, w: 26, h: 16 });
    expect(boundsOf([])).toBeUndefined();
  });
});

describe('token variable diff', () => {
  it('names changed variables in any mode and follows variables that read them', () => {
    const a = ':root {\n  --a: #fff;\n  --b: 4px;\n  --c: var(--a);\n}\n\n[data-mode="dark"] {\n  --a: #000;\n}\n';
    const b = ':root {\n  --a: #fff;\n  --b: 8px;\n  --c: var(--a);\n}\n\n[data-mode="dark"] {\n  --a: #111;\n}\n';
    expect(changedVars(a, b)?.sort()).toEqual(['--a', '--b', '--c']);
    expect(changedVars(a, a)).toEqual([]);
  });
  it('gives up (null) when something other than variables changed', () => {
    expect(changedVars(':root {\n  --a: 1;\n}', '.x { color: red }')).toBeNull();
  });
  it('finds var() reads', () => {
    expect([...varsIn('color:var(--x);background:var( --y-2 , red)')]).toEqual(['--x', '--y-2']);
  });
});
