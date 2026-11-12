/**
 * The seal: a kolam line computed from a content hash (ARCHITECTURE §4, `kolam@1`).
 *
 * A pure function of the first 16 hash bytes, with no Math.random and no DOM. It is decorative:
 * the hash remains the proof. Any change to this output needs a new version, because golden tests
 * pin it and signed seals must keep drawing the same way.
 *
 * Method: a mirror curve on an odd N x N grid of dots.
 *  - Every pair of adjacent dots has a site between them. The line passes each site twice and is
 *    either walled off (the line bounces away), joined (the line wraps both dots) or crossing.
 *  - Sites change in orbits of four under 90 degree rotation. On an odd grid no site sits on the
 *    centre, so every orbit has exactly four sites and the drawing keeps 4-fold symmetry.
 *  - Union-find over the dot orbits picks a spanning tree of joined sites, in hash order. A
 *    symmetric spanning tree is what merges every strand into one closed loop.
 *  - Crossings are then tried orbit by orbit, and kept only when the line stays a single loop.
 */

export const KOLAM_VERSION = 'kolam@1';
export const KOLAM_DEFAULT_GRID = 5;

const MIN_GRID = 3;
const MAX_GRID = 21;
const UNIT = 10;
const PAD = 8;
/** Share of orbits tried as crossings; the rest keep their tree shape. */
const CROSS_ATTEMPT_RATE = 0.8;

const WALL = 0;
const JOIN = 1;
const CROSS = 2;

export interface KolamPoint {
  x: number;
  y: number;
}

export interface Kolam {
  version: typeof KOLAM_VERSION;
  /** dots per side */
  grid: number;
  /** width and height of the square drawing */
  size: number;
  viewBox: string;
  dots: KolamPoint[];
  /** one closed subpath, so a single stroke animation draws the whole line */
  path: string;
  /** number of curve segments: always 4 per dot */
  arcs: number;
}

export interface KolamOptions {
  /** dots per side: an odd number from 3 to 21 (default 5) */
  grid?: number;
}

/** sfc32: 128 bits of state, exactly the 16 hash bytes, and safe when they are all zero. */
function generator(hash: string): () => number {
  let a = parseInt(hash.slice(0, 8), 16) | 0;
  let b = parseInt(hash.slice(8, 16), 16) | 0;
  let c = parseInt(hash.slice(16, 24), 16) | 0;
  let d = parseInt(hash.slice(24, 32), 16) | 0;
  const next = () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) next();
  return next;
}

function shuffled(count: number, next: () => number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  for (let i = count - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}

/**
 * The drawing uses doubled coordinates on 0..2N: dots at (odd, odd), sites at (even, odd) or
 * (odd, even), the boundary at 0 and 2N. The line moves diagonally from site to site.
 */
class Mirrors {
  readonly side: number;
  readonly state: Uint8Array;

  constructor(readonly n: number) {
    this.side = 2 * n + 1;
    this.state = new Uint8Array(this.side * this.side);
  }

  key(x: number, y: number): number {
    return y * this.side + x;
  }

  /** The direction leaving site (x, y) for a line arriving with direction (dx, dy). */
  bounce(x: number, y: number, dx: number, dy: number): [number, number] {
    const state = this.state[this.key(x, y)]!;
    if (state === CROSS) return [dx, dy];
    const flipsX = (x % 2 === 0) === (state === WALL);
    return flipsX ? [-dx, dy] : [dx, -dy];
  }

  /** Walk from the top-left boundary site and return the sites visited, ending at the start. */
  trace(limit: number): KolamPoint[] {
    const points: KolamPoint[] = [];
    let x = 1;
    let y = 0;
    let dx = 1;
    let dy = 1;
    do {
      x += dx;
      y += dy;
      [dx, dy] = this.bounce(x, y, dx, dy);
      points.push({ x, y });
    } while (!(x === 1 && y === 0 && dx === 1 && dy === 1) && points.length <= limit);
    return points;
  }

  isSingleLoop(): boolean {
    const total = 4 * this.n * this.n;
    return this.trace(total).length === total;
  }
}

interface Orbit {
  sites: number[];
  /** the dots either side of the first site */
  a: number;
  b: number;
}

function buildOrbits(mirrors: Mirrors): Orbit[] {
  const n = mirrors.n;
  const seen = new Set<number>();
  const orbits: Orbit[] = [];
  const dotIndex = (x: number, y: number) => ((y - 1) / 2) * n + (x - 1) / 2;
  for (let y = 1; y < 2 * n; y++) {
    for (let x = 1; x < 2 * n; x++) {
      if ((x + y) % 2 === 0) continue;
      if (seen.has(mirrors.key(x, y))) continue;
      const sites: number[] = [];
      let px = x;
      let py = y;
      for (let turn = 0; turn < 4; turn++) {
        const k = mirrors.key(px, py);
        sites.push(k);
        seen.add(k);
        [px, py] = [2 * n - py, px];
      }
      const between = x % 2 === 0 ? [dotIndex(x - 1, y), dotIndex(x + 1, y)] : [dotIndex(x, y - 1), dotIndex(x, y + 1)];
      orbits.push({ sites, a: between[0]!, b: between[1]! });
    }
  }
  return orbits;
}

/** Every dot in a rotation orbit gets the same representative, the centre dot its own. */
function dotOrbitOf(n: number): number[] {
  const out = new Array<number>(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let px = x;
      let py = y;
      let least = y * n + x;
      for (let turn = 0; turn < 3; turn++) {
        [px, py] = [n - 1 - py, px];
        least = Math.min(least, py * n + px);
      }
      out[y * n + x] = least;
    }
  }
  return out;
}

function buildMirrors(n: number, next: () => number): Mirrors {
  const mirrors = new Mirrors(n);
  const orbits = buildOrbits(mirrors);
  const dotOrbit = dotOrbitOf(n);
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let root = v;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root)!;
    parent.set(v, root);
    return root;
  };
  const setOrbit = (orbit: Orbit, state: number) => {
    for (const site of orbit.sites) mirrors.state[site] = state;
  };

  for (const index of shuffled(orbits.length, next)) {
    const orbit = orbits[index]!;
    const a = find(dotOrbit[orbit.a]!);
    const b = find(dotOrbit[orbit.b]!);
    if (a === b) continue;
    parent.set(a, b);
    setOrbit(orbit, JOIN);
  }

  // Each trial costs one walk of the line. N is small and fixed per seal, so this stays under budget.
  for (const index of shuffled(orbits.length, next)) {
    if (next() / 0x100000000 >= CROSS_ATTEMPT_RATE) continue;
    const orbit = orbits[index]!;
    const previous = mirrors.state[orbit.sites[0]!]!;
    setOrbit(orbit, CROSS);
    if (!mirrors.isSingleLoop()) setOrbit(orbit, previous);
  }
  return mirrors;
}

/** Same first 16 bytes of hash and same grid, same drawing. */
export function kolam(hash: string, opts: KolamOptions = {}): Kolam {
  if (!/^[0-9a-fA-F]{32,}$/.test(hash)) {
    throw new RangeError('kolam needs a hex hash of at least 16 bytes');
  }
  const n = opts.grid ?? KOLAM_DEFAULT_GRID;
  if (!Number.isInteger(n) || n % 2 === 0 || n < MIN_GRID || n > MAX_GRID) {
    throw new RangeError(`kolam grid must be an odd number from ${MIN_GRID} to ${MAX_GRID}`);
  }

  const mirrors = buildMirrors(n, generator(hash.toLowerCase()));
  const sites = mirrors.trace(4 * n * n);
  const scale = (v: number) => v * UNIT + PAD;
  const middle = (a: number, b: number) => ((a + b) * UNIT) / 2 + PAD;

  // Curves run from the middle of one segment to the next, with the site as control point, so
  // bounces round off and crossings stay straight.
  const last = sites[sites.length - 1]!;
  const first = sites[0]!;
  let path = `M${middle(last.x, first.x)} ${middle(last.y, first.y)}`;
  sites.forEach((site, i) => {
    const following = sites[(i + 1) % sites.length]!;
    path += `Q${scale(site.x)} ${scale(site.y)} ${middle(site.x, following.x)} ${middle(site.y, following.y)}`;
  });
  path += 'Z';

  const dots: KolamPoint[] = [];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) dots.push({ x: scale(2 * x + 1), y: scale(2 * y + 1) });
  }

  const size = 2 * n * UNIT + 2 * PAD;
  return { version: KOLAM_VERSION, grid: n, size, viewBox: `0 0 ${size} ${size}`, dots, path, arcs: sites.length };
}
