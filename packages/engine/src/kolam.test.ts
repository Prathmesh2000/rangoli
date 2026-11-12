import { describe, expect, it, vi } from 'vitest';
import { kolam, KOLAM_VERSION } from './kolam.js';
import { sha256Hex } from './snapshot-hash.js';

const GOLDEN_HASH = 'a3f1c09e5b7d2846e1907fbc3d5a6c12deadbeef00112233445566778899aabb';
const GOLDEN_GRID_3 =
  'M23 13Q28 18 33 13Q38 8 43 13Q48 18 53 23Q58 28 53 33Q48 38 43 43Q38 48 33 53Q28 58 23 63Q18 68 13 63Q8 58 13 53Q18 48 13 43Q8 38 13 33Q18 28 23 23Q28 18 33 23Q38 28 43 33Q48 38 53 43Q58 48 63 53Q68 58 63 63Q58 68 53 63Q48 58 43 63Q38 68 33 63Q28 58 23 53Q18 48 23 43Q28 38 33 33Q38 28 43 23Q48 18 53 13Q58 8 63 13Q68 18 63 23Q58 28 63 33Q68 38 63 43Q58 48 53 53Q48 58 43 53Q38 48 33 43Q28 38 23 33Q18 28 13 23Q8 18 13 13Q18 8 23 13Z';
const GOLDEN_SHA_GRID_5 = '9fd3d4cdcd067fbc57901be365ec321a7b01a199880db6acdc13361d5e02fa0c';
const GOLDEN_SHA_GRID_7 = '8ccfea48ff5e590fcb20f852a4309c710452de31fde4bfaf72743ceb4110576c';

function randomHashes(count: number, seed: number): string[] {
  let state = seed >>> 0;
  const byte = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state >>> 24).toString(16).padStart(2, '0');
  };
  return Array.from({ length: count }, () => Array.from({ length: 32 }, byte).join(''));
}

type Point = [number, number];

function controlPoints(path: string): Point[] {
  return [...path.matchAll(/Q(-?\d+) (-?\d+) /g)].map((m) => [Number(m[1]), Number(m[2])]);
}

const segmentKey = (a: Point, b: Point) => [a.join(','), b.join(',')].sort().join('|');

function segments(points: Point[]): Set<string> {
  return new Set(points.map((p, i) => segmentKey(p, points[(i + 1) % points.length]!)));
}

describe('kolam@1 golden output', () => {
  it('pins the drawing, so a signed seal never changes', () => {
    expect(kolam(GOLDEN_HASH, { grid: 3 }).path).toBe(GOLDEN_GRID_3);
    expect(sha256Hex(kolam(GOLDEN_HASH).path)).toBe(GOLDEN_SHA_GRID_5);
    expect(sha256Hex(kolam(GOLDEN_HASH, { grid: 7 }).path)).toBe(GOLDEN_SHA_GRID_7);
  });

  it('describes the drawing', () => {
    const k = kolam(GOLDEN_HASH);
    expect(k.version).toBe(KOLAM_VERSION);
    expect(k.version).toBe('kolam@1');
    expect(k.grid).toBe(5);
    expect(k.viewBox).toBe(`0 0 ${k.size} ${k.size}`);
    expect(k.dots).toHaveLength(25);
    expect(k.arcs).toBe(100);
  });
});

describe('determinism', () => {
  it('gives the same drawing for the same hash', () => {
    for (const hash of randomHashes(50, 1)) expect(kolam(hash)).toEqual(kolam(hash));
  });

  it('never uses Math.random', () => {
    const spy = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random was called');
    });
    try {
      expect(() => kolam(GOLDEN_HASH)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });

  it('reads only the first 16 bytes, in either case', () => {
    const first = GOLDEN_HASH.slice(0, 32);
    expect(kolam(`${first}${'0'.repeat(32)}`)).toEqual(kolam(`${first}${'f'.repeat(32)}`));
    expect(kolam(first.toUpperCase())).toEqual(kolam(first));
  });

  it('copes with extreme hashes', () => {
    for (const hash of ['0'.repeat(64), 'f'.repeat(64)]) expect(kolam(hash).arcs).toBe(100);
  });
});

describe.each([3, 5, 7, 9])('line properties on a %i x %i grid', (grid) => {
  const samples = randomHashes(150, grid * 7919).map((hash) => kolam(hash, { grid }));

  it('is one closed line', () => {
    for (const k of samples) {
      expect(k.path.match(/M/g)).toHaveLength(1);
      expect(k.path.endsWith('Z')).toBe(true);
      expect(controlPoints(k.path)).toHaveLength(4 * grid * grid);
    }
  });

  it('passes every inner site twice and every edge site once', () => {
    const max = grid * 20 + 8;
    for (const k of samples) {
      const visits = new Map<string, number>();
      for (const point of controlPoints(k.path)) visits.set(point.join(','), (visits.get(point.join(',')) ?? 0) + 1);
      expect(visits.size).toBe(2 * grid * (grid + 1));
      for (const [key, count] of visits) {
        const [x, y] = key.split(',').map(Number) as [number, number];
        const onEdge = x === 8 || y === 8 || x === max || y === max;
        expect(count).toBe(onEdge ? 1 : 2);
      }
    }
  });

  it('never traces the same segment twice', () => {
    for (const k of samples) expect(segments(controlPoints(k.path)).size).toBe(4 * grid * grid);
  });

  it('has 4-fold symmetry', () => {
    const centre = grid * 10 + 8;
    for (const k of samples) {
      const points = controlPoints(k.path);
      const original = segments(points);
      const rotate = ([x, y]: Point): Point => [centre - (y - centre), centre + (x - centre)];
      const turned = [...original].map((s) => {
        const [a, b] = s.split('|').map((p) => p.split(',').map(Number) as Point) as [Point, Point];
        return segmentKey(rotate(a), rotate(b));
      });
      expect(new Set(turned)).toEqual(original);
    }
  });

  it('uses whole-number coordinates', () => {
    for (const k of samples) expect(k.path).toMatch(/^M\d+ \d+(Q\d+ \d+ \d+ \d+)+Z$/);
  });

  it('keeps dots and line inside the viewBox', () => {
    for (const k of samples) {
      for (const dot of k.dots) {
        expect(dot.x).toBeGreaterThan(0);
        expect(dot.x).toBeLessThan(k.size);
        expect(dot.y).toBeGreaterThan(0);
        expect(dot.y).toBeLessThan(k.size);
      }
      for (const [x, y] of controlPoints(k.path)) {
        expect(Math.min(x, y)).toBeGreaterThanOrEqual(0);
        expect(Math.max(x, y)).toBeLessThanOrEqual(k.size);
      }
    }
  });
});

describe('variety', () => {
  it('draws different lines for different hashes', () => {
    const paths = new Set(randomHashes(400, 99).map((hash) => kolam(hash).path));
    expect(paths.size).toBeGreaterThan(200);
  });

  it('usually weaves crossings, not only a tree outline', () => {
    const withCrossings = randomHashes(200, 7).filter((hash) => {
      const points = controlPoints(kolam(hash).path);
      return points.some((p, i) => {
        const before = points[(i + points.length - 1) % points.length]!;
        const after = points[(i + 1) % points.length]!;
        return before[0] + after[0] === 2 * p[0] && before[1] + after[1] === 2 * p[1];
      });
    });
    expect(withCrossings.length).toBeGreaterThan(190);
  });
});

describe('rejected input', () => {
  it.each(['', 'abc', 'z'.repeat(64), 'a'.repeat(31)])('rejects the hash "%s"', (hash) => {
    expect(() => kolam(hash)).toThrow(RangeError);
  });

  it.each([0, 1, 2, 4, 23, 5.5, Number.NaN])('rejects a grid of %s', (grid) => {
    expect(() => kolam(GOLDEN_HASH, { grid })).toThrow(RangeError);
  });
});
