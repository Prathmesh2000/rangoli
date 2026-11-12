/**
 * Canvas geometry (ARCHITECTURE.md work packages 12 and 13): where top-level frames sit on a page, and the
 * snapping, smart guides and distance measuring used while moving or resizing them.
 *
 * Pure functions over rectangles in design pixels (y down), so the editor, headless checks and tests share
 * one answer. A top-level frame's `position` is its place on the page. Frames without one flow in a row in
 * page order, to the right of everything placed, like the stage always showed them.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameSlot {
  id: string;
  /** the frame's own position on the page, when it has one */
  at?: { x: number; y: number } | undefined;
  w: number;
  h: number;
}

/** Gap between frames that flow in a row, and between a flowing row and placed frames. */
export const FRAME_GAP = 64;

/**
 * Positions for every frame: its own when it has one; otherwise the next place in a row that starts right of
 * the placed frames (or at 0,0 when none is placed). O(n).
 */
export function placeFrames(frames: readonly FrameSlot[], gap = FRAME_GAP): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  let right = -Infinity, top = Infinity;
  for (const f of frames) {
    if (!f.at) continue;
    out.set(f.id, { x: f.at.x, y: f.at.y });
    right = Math.max(right, f.at.x + Math.max(0, f.w));
    top = Math.min(top, f.at.y);
  }
  let x = Number.isFinite(right) ? right + gap : 0;
  const y = Number.isFinite(top) ? Math.min(0, top) : 0;
  for (const f of frames) {
    if (f.at) continue;
    out.set(f.id, { x, y });
    x += Math.max(0, f.w) + gap;
  }
  return out;
}

/** A free spot to the right of a frame for a copy of `w` wide (duplicate to device). */
export function besideFrame(source: Rect, others: readonly Rect[], gap = 80): { x: number; y: number } {
  let x = source.x + source.w + gap;
  // step right past anything already there on that row
  for (let guard = 0; guard < 1000; guard++) {
    const hit = others.find((o) => o.x < x + 1 && o.x + o.w > x - 1 && o.y < source.y + source.h && o.y + o.h > source.y);
    if (!hit) break;
    x = hit.x + hit.w + gap;
  }
  return { x: Math.round(x), y: Math.round(source.y) };
}

export interface Guide {
  axis: 'x' | 'y';
  /** the guide line's position on its axis */
  at: number;
  /** extent along the other axis, covering both rectangles */
  from: number;
  to: number;
}

export interface Gap {
  axis: 'x' | 'y';
  /** gap start and end on its axis */
  from: number;
  to: number;
  /** where the measurement line sits on the other axis */
  at: number;
  /** the distance in design pixels */
  size: number;
}

export interface SnapResult {
  dx: number;
  dy: number;
  guides: Guide[];
  gaps: Gap[];
}

const edges = (r: Rect, axis: 'x' | 'y') => (axis === 'x' ? [r.x, r.x + r.w / 2, r.x + r.w] : [r.y, r.y + r.h / 2, r.y + r.h]);

/**
 * Snap a rectangle being moved by (dx, dy) to the edges and centres of `others`, within `threshold` design
 * pixels on each axis independently. Returns the snapped offsets, the guides that line up after snapping and
 * the gaps to the nearest neighbour on each side. O(others).
 */
export function snapMove(moving: Rect, dx: number, dy: number, others: readonly Rect[], threshold: number): SnapResult {
  const axisSnap = (axis: 'x' | 'y', d: number): number => {
    const mine = edges(moving, axis).map((v) => v + d);
    let best: number | undefined;
    for (const o of others) {
      for (const t of edges(o, axis)) {
        for (const m of mine) {
          const delta = t - m;
          if (Math.abs(delta) <= threshold && (best === undefined || Math.abs(delta) < Math.abs(best))) best = delta;
        }
      }
    }
    return d + (best ?? 0);
  };
  const sdx = axisSnap('x', dx), sdy = axisSnap('y', dy);
  const r = { x: moving.x + sdx, y: moving.y + sdy, w: moving.w, h: moving.h };
  return { dx: sdx, dy: sdy, guides: guidesFor(r, others), gaps: gapsAround(r, others) };
}

/** Lines where an edge or centre of `r` equals one of `others` (within half a pixel). */
export function guidesFor(r: Rect, others: readonly Rect[]): Guide[] {
  const out: Guide[] = [];
  const seen = new Set<string>();
  for (const axis of ['x', 'y'] as const) {
    const mine = edges(r, axis);
    for (const o of others) {
      for (const t of edges(o, axis)) {
        if (!mine.some((m) => Math.abs(m - t) < 0.5)) continue;
        const key = `${axis}${Math.round(t)}`;
        const span = axis === 'x' ? [Math.min(r.y, o.y), Math.max(r.y + r.h, o.y + o.h)] : [Math.min(r.x, o.x), Math.max(r.x + r.w, o.x + o.w)];
        const prev = out.find((g) => `${g.axis}${Math.round(g.at)}` === key);
        if (prev) { prev.from = Math.min(prev.from, span[0]!); prev.to = Math.max(prev.to, span[1]!); continue; }
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ axis, at: t, from: span[0]!, to: span[1]! });
      }
    }
  }
  return out;
}

/**
 * Distances from `r` to the nearest rectangle on its left, right, top and bottom that overlaps it on the other
 * axis. These are the numbers shown while moving (distance measuring).
 */
export function gapsAround(r: Rect, others: readonly Rect[]): Gap[] {
  let left: Rect | undefined, right: Rect | undefined, up: Rect | undefined, down: Rect | undefined;
  for (const o of others) {
    const overlapY = o.y < r.y + r.h && o.y + o.h > r.y;
    const overlapX = o.x < r.x + r.w && o.x + o.w > r.x;
    if (overlapY && o.x + o.w <= r.x && (!left || o.x + o.w > left.x + left.w)) left = o;
    if (overlapY && o.x >= r.x + r.w && (!right || o.x < right.x)) right = o;
    if (overlapX && o.y + o.h <= r.y && (!up || o.y + o.h > up.y + up.h)) up = o;
    if (overlapX && o.y >= r.y + r.h && (!down || o.y < down.y)) down = o;
  }
  const midY = (o: Rect) => (Math.max(r.y, o.y) + Math.min(r.y + r.h, o.y + o.h)) / 2;
  const midX = (o: Rect) => (Math.max(r.x, o.x) + Math.min(r.x + r.w, o.x + o.w)) / 2;
  const out: Gap[] = [];
  if (left) out.push({ axis: 'x', from: left.x + left.w, to: r.x, at: midY(left), size: r.x - (left.x + left.w) });
  if (right) out.push({ axis: 'x', from: r.x + r.w, to: right.x, at: midY(right), size: right.x - (r.x + r.w) });
  if (up) out.push({ axis: 'y', from: up.y + up.h, to: r.y, at: midX(up), size: r.y - (up.y + up.h) });
  if (down) out.push({ axis: 'y', from: r.y + r.h, to: down.y, at: midX(down), size: down.y - (r.y + r.h) });
  return out;
}

/**
 * The zoom and scroll that keep the design point under the cursor fixed while zooming (zoom to cursor).
 * `cursor` is relative to the viewport's top-left; scroll is the viewport's scroll offset in screen pixels.
 */
export function zoomAt(scroll: { x: number; y: number }, cursor: { x: number; y: number }, from: number, to: number): { x: number; y: number } {
  const dx = (scroll.x + cursor.x) / from, dy = (scroll.y + cursor.y) / from;
  return { x: dx * to - cursor.x, y: dy * to - cursor.y };
}

/** Bounding box of rectangles, or undefined for none. */
export function boundsOf(rects: Iterable<Rect>): Rect | undefined {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const r of rects) {
    x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h);
  }
  return Number.isFinite(x0) ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : undefined;
}
