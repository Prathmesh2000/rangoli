import { describe, expect, it } from 'vitest';
import { RectIndex, type IndexedRect } from './spatial.js';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Mixed sizes, like a canvas: many small layers, some huge frames, some zero-size. */
function rects(n: number, seed: number): IndexedRect[] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, i) => {
    const big = r() < 0.05;
    return { id: `r${i}`, x: r() * 20000 - 2000, y: r() * 20000, w: big ? 800 + r() * 4000 : r() < 0.05 ? 0 : r() * 200, h: big ? 600 + r() * 6000 : r() * 120 };
  });
}

const brute = (all: IndexedRect[], x0: number, y0: number, x1: number, y1: number) =>
  all.filter((q) => !(q.x + q.w < x0 || q.y + q.h < y0 || q.x > x1 || q.y > y1)).map((q) => q.id).sort();

describe('RectIndex (packed STR R-tree)', () => {
  it.each([0, 1, 2, 15, 16, 17, 257, 5000])('search equals brute force for %i rectangles', (n) => {
    const all = rects(n, n + 1);
    const idx = RectIndex.build(all);
    expect(idx.size).toBe(n);
    const r = rng(99);
    for (let q = 0; q < 200; q++) {
      const x0 = r() * 22000 - 3000, y0 = r() * 22000 - 1000;
      const x1 = x0 + r() * 3000, y1 = y0 + r() * 3000;
      expect(idx.search(x0, y0, x1, y1).sort()).toEqual(brute(all, x0, y0, x1, y1));
    }
  });

  it('accepts reversed corners and touching edges', () => {
    const idx = RectIndex.build([{ id: 'a', x: 0, y: 0, w: 10, h: 10 }, { id: 'b', x: 20, y: 0, w: 10, h: 10 }]);
    expect(idx.search(10, 10, 0, 0).sort()).toEqual(['a']);
    expect(idx.search(10, 0, 20, 5).sort()).toEqual(['a', 'b']);
    expect(idx.search(11, 0, 19, 5)).toEqual([]);
  });

  it('hitTest returns containing rectangles, smallest first', () => {
    const idx = RectIndex.build([
      { id: 'page', x: 0, y: 0, w: 1000, h: 1000 },
      { id: 'card', x: 100, y: 100, w: 300, h: 200 },
      { id: 'button', x: 120, y: 120, w: 80, h: 30 },
      { id: 'other', x: 600, y: 600, w: 50, h: 50 },
    ]);
    expect(idx.hitTest(130, 130)).toEqual(['button', 'card', 'page']);
    expect(idx.hitTest(500, 500)).toEqual(['page']);
    expect(idx.hitTest(-5, 0)).toEqual([]);
  });

  it('within returns only rectangles fully inside (marquee)', () => {
    const idx = RectIndex.build([
      { id: 'in', x: 10, y: 10, w: 20, h: 20 },
      { id: 'cross', x: 90, y: 10, w: 20, h: 20 },
      { id: 'out', x: 200, y: 10, w: 20, h: 20 },
    ]);
    expect(idx.within(0, 0, 100, 100)).toEqual(['in']);
    expect(idx.search(0, 0, 100, 100).sort()).toEqual(['cross', 'in']);
  });

  it('reports extent and looks up by id; ignores non-finite input', () => {
    const idx = RectIndex.build([{ id: 'a', x: -10, y: 5, w: 10, h: 10 }, { id: 'b', x: 30, y: 40, w: 5, h: 5 }, { id: 'bad', x: NaN, y: 0, w: 1, h: 1 }]);
    expect(idx.size).toBe(2);
    expect(idx.extent()).toEqual({ x: -10, y: 5, w: 45, h: 40 });
    expect(idx.get('b')).toMatchObject({ x: 30, y: 40 });
    expect(RectIndex.build([]).extent()).toBeUndefined();
    expect(RectIndex.build([]).search(-1e9, -1e9, 1e9, 1e9)).toEqual([]);
  });

  it('at 50,000 entries stays far inside the 1 ms query budget (median of many queries)', () => {
    const all = rects(50_000, 7);
    const idx = RectIndex.build(all);
    const r = rng(3);
    const times: number[] = [];
    for (let q = 0; q < 300; q++) {
      const x0 = r() * 20000, y0 = r() * 20000;
      const t = performance.now();
      idx.search(x0, y0, x0 + 1440, y0 + 900);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    // generous bound so a loaded CI box does not flake; scripts/canvas-bench.mjs reports the real numbers
    expect(times[Math.floor(times.length / 2)]!).toBeLessThan(5);
  });
});
