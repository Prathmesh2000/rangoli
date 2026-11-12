/**
 * Spatial index for the canvas (ARCHITECTURE.md section 4, "Spatial index" and "Culling").
 *
 * A static, packed R-tree built by Sort-Tile-Recursive (STR) bulk loading, stored in flat typed arrays.
 *
 * Why this structure:
 * - Canvas rectangles are very uneven (a 40px icon frame next to a 1440x6000 landing page), so a uniform
 *   grid either wastes cells or puts big frames in hundreds of cells; an R-tree adapts to any size mix.
 * - Bounds come from browser layout and change in batches (after a patch or a resize), never one at a time
 *   during a query burst, so a bulk-loaded tree rebuilt per batch beats a dynamic R-tree (rbush style):
 *   STR packs nodes ~100% full with little overlap, building is one sort per level, O(n log n), and the
 *   tree is a few typed arrays with no per-node objects for the GC to trace.
 * - Queries (viewport culling, marquee, point hit-testing) are O(log n + k).
 * - No dependency: the architecture names rbush, but the editor must not add npm packages here, and the
 *   static case needs about a hundred lines.
 *
 * Coordinates are design pixels (unscaled canvas space), y down.
 */

export interface IndexedRect<T = string> {
  id: T;
  x: number;
  y: number;
  w: number;
  h: number;
}

const DEFAULT_NODE_SIZE = 16;

export class RectIndex<T = string> {
  /** boxes as minX, minY, maxX, maxY; leaves first (in packed order), then each level up, root last */
  private readonly boxes: Float64Array;
  /** for an internal node: index of its first child node; for a leaf: index into `items` */
  private readonly first: Uint32Array;
  private readonly count: Uint32Array;
  private readonly items: IndexedRect<T>[];
  private readonly root: number;
  private readonly leafCount: number;
  private byId: Map<T, IndexedRect<T>> | undefined;

  private constructor(items: IndexedRect<T>[], boxes: Float64Array, first: Uint32Array, count: Uint32Array, root: number) {
    this.items = items;
    this.boxes = boxes;
    this.first = first;
    this.count = count;
    this.root = root;
    this.leafCount = items.length;
  }

  /** Build from rectangles. Zero or negative sizes are kept as points or lines. O(n log n). */
  static build<T = string>(input: readonly IndexedRect<T>[], nodeSize = DEFAULT_NODE_SIZE): RectIndex<T> {
    const M = Math.max(2, Math.floor(nodeSize));
    const items = input.filter((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.w) && Number.isFinite(r.h)).map((r) => ({ ...r, w: Math.max(0, r.w), h: Math.max(0, r.h) }));
    const n = items.length;
    // total nodes: leaves + every level above (upper bound is n + n/(M-1) + 1)
    let total = n;
    for (let level = n; level > 1; ) { level = Math.ceil(level / M); total += level; }
    if (n === 0) total = 1;
    const boxes = new Float64Array(total * 4);
    const first = new Uint32Array(total);
    const count = new Uint32Array(total);

    // leaves in STR order
    const order = strOrder(n, (i) => items[i]!.x + items[i]!.w / 2, (i) => items[i]!.y + items[i]!.h / 2, M);
    for (let k = 0; k < n; k++) {
      const r = items[order[k]!]!;
      boxes[k * 4] = r.x; boxes[k * 4 + 1] = r.y; boxes[k * 4 + 2] = r.x + r.w; boxes[k * 4 + 3] = r.y + r.h;
      first[k] = order[k]!;
      count[k] = 0; // 0 marks a leaf
    }
    if (n === 0) {
      boxes.set([Infinity, Infinity, -Infinity, -Infinity]);
      return new RectIndex(items, boxes, first, count, 0);
    }

    // build levels upward. Each level is re-sorted by STR so siblings stay spatially close; nodes of the level
    // below are permuted in place, which keeps every parent's children contiguous.
    let levelStart = 0;
    let levelSize = n;
    let next = n;
    while (levelSize > 1) {
      const ord = strOrder(levelSize, (i) => (boxes[(levelStart + i) * 4]! + boxes[(levelStart + i) * 4 + 2]!) / 2, (i) => (boxes[(levelStart + i) * 4 + 1]! + boxes[(levelStart + i) * 4 + 3]!) / 2, M);
      if (levelStart > 0) permute(boxes, first, count, levelStart, ord); // leaves are already in STR order
      const parents = Math.ceil(levelSize / M);
      for (let p = 0; p < parents; p++) {
        const a = levelStart + p * M;
        const b = Math.min(levelStart + levelSize, a + M);
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let c = a; c < b; c++) {
          x0 = Math.min(x0, boxes[c * 4]!); y0 = Math.min(y0, boxes[c * 4 + 1]!);
          x1 = Math.max(x1, boxes[c * 4 + 2]!); y1 = Math.max(y1, boxes[c * 4 + 3]!);
        }
        const node = next + p;
        boxes[node * 4] = x0; boxes[node * 4 + 1] = y0; boxes[node * 4 + 2] = x1; boxes[node * 4 + 3] = y1;
        first[node] = a;
        count[node] = b - a;
      }
      levelStart = next;
      levelSize = parents;
      next += parents;
    }
    return new RectIndex(items, boxes, first, count, levelStart);
  }

  get size(): number {
    return this.leafCount;
  }

  /** Bounds of everything indexed, or undefined when empty. */
  extent(): { x: number; y: number; w: number; h: number } | undefined {
    if (!this.leafCount) return undefined;
    const b = this.boxes, r = this.root * 4;
    return { x: b[r]!, y: b[r + 1]!, w: b[r + 2]! - b[r]!, h: b[r + 3]! - b[r + 1]! };
  }

  /** The rectangle stored for an id (first one, when ids repeat). */
  get(id: T): IndexedRect<T> | undefined {
    this.byId ??= new Map(this.items.map((r) => [r.id, r]));
    return this.byId.get(id);
  }

  /** Ids of rectangles intersecting [x0,y0]-[x1,y1] (edges touching count). O(log n + k). */
  search(x0: number, y0: number, x1: number, y1: number): T[] {
    const out: T[] = [];
    this.visit(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1), (i) => { out.push(this.items[i]!.id); });
    return out;
  }

  /** Ids of rectangles entirely inside [x0,y0]-[x1,y1]. */
  within(x0: number, y0: number, x1: number, y1: number): T[] {
    const ax = Math.min(x0, x1), ay = Math.min(y0, y1), bx = Math.max(x0, x1), by = Math.max(y0, y1);
    const out: T[] = [];
    this.visit(ax, ay, bx, by, (i) => {
      const r = this.items[i]!;
      if (r.x >= ax && r.y >= ay && r.x + r.w <= bx && r.y + r.h <= by) out.push(r.id);
    });
    return out;
  }

  /** Ids of rectangles containing the point, smallest first: the innermost thing under the pointer leads. */
  hitTest(x: number, y: number): T[] {
    const hits: IndexedRect<T>[] = [];
    this.visit(x, y, x, y, (i) => { hits.push(this.items[i]!); });
    return hits.sort((a, b) => a.w * a.h - b.w * b.h).map((r) => r.id);
  }

  private visit(x0: number, y0: number, x1: number, y1: number, hit: (item: number) => void): void {
    if (!this.leafCount) return;
    const b = this.boxes;
    const stack: number[] = [this.root];
    while (stack.length) {
      const node = stack.pop()!;
      const o = node * 4;
      if (b[o + 2]! < x0 || b[o + 3]! < y0 || b[o]! > x1 || b[o + 1]! > y1) continue;
      const c = this.count[node]!;
      if (c === 0) hit(this.first[node]!);
      else for (let k = this.first[node]!, end = k + c; k < end; k++) stack.push(k);
    }
  }
}

/** Sort-Tile-Recursive order of n entries with centres cx(i), cy(i): vertical slices by x, each sorted by y. */
function strOrder(n: number, cx: (i: number) => number, cy: (i: number) => number, M: number): Uint32Array {
  const xs = new Float64Array(n), ys = new Float64Array(n);
  for (let i = 0; i < n; i++) { xs[i] = cx(i); ys[i] = cy(i); }
  const idx = Array.from({ length: n }, (_, i) => i);
  idx.sort((a, b) => xs[a]! - xs[b]!);
  const leaves = Math.ceil(n / M);
  const slices = Math.max(1, Math.ceil(Math.sqrt(leaves)));
  const perSlice = slices * M;
  const out = new Uint32Array(n);
  for (let s = 0; s < n; s += perSlice) {
    const part = idx.slice(s, s + perSlice).sort((a, b) => ys[a]! - ys[b]!);
    out.set(part, s);
  }
  return out;
}

/** Reorder nodes [start, start + ord.length) of one level so that position k holds the node at start + ord[k]. */
function permute(boxes: Float64Array, first: Uint32Array, count: Uint32Array, start: number, ord: Uint32Array): void {
  const n = ord.length;
  const b = boxes.slice(start * 4, (start + n) * 4);
  const f = first.slice(start, start + n);
  const c = count.slice(start, start + n);
  for (let k = 0; k < n; k++) {
    const src = ord[k]!;
    boxes.set(b.subarray(src * 4, src * 4 + 4), (start + k) * 4);
    first[start + k] = f[src]!;
    count[start + k] = c[src]!;
  }
}
