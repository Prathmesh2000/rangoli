import type { RangoliDocument, RNode } from '@rangoli/engine';
import { getState, rdl, select, setHover } from './store';
import { indent } from './helpers';

/**
 * Drag and drop onto the canvas: new items from the Add panel, and existing layers. Flow layouts show
 * an insertion line; free frames, or holding Ctrl, place the item exactly where it is dropped.
 */

let shadow: ShadowRoot | null = null;
export const setDropRoot = (s: ShadowRoot | null) => { shadow = s; };

export interface Drop {
  parent: string | null;
  /** insert before this sibling (null = at the end) */
  before: string | null;
  index: number;
  free: boolean;
  x: number;
  y: number;
}

const isContainer = (n: RNode | undefined) => n?.type === 'frame' || n?.type === 'group';
const isInside = (doc: RangoliDocument, id: string, ancestor: string) => {
  for (let cur: string | undefined = id; cur; cur = doc.findNode(cur)?.node.parent) if (cur === ancestor) return true;
  return false;
};

export function dropAt(cx: number, cy: number, forceFree: boolean, exclude?: string): (Drop & { line?: DOMRect; outline?: DOMRect; vertical?: boolean }) | null {
  const doc = getState().doc;
  if (!shadow || !doc) return null;
  const zoom = getState().zoom;
  const els = [...shadow.querySelectorAll<HTMLElement>('[data-rid]')].reverse();
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!r.width || cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;
    const node = doc.findNode(el.getAttribute('data-rid')!)?.node;
    if (!isContainer(node) || (exclude && isInside(doc, node!.id, exclude))) continue;
    const x = Math.round((cx - r.left) / zoom), y = Math.round((cy - r.top) / zoom);
    const mode = node!.layout?.mode ?? 'col';
    if (forceFree || mode === 'none') return { parent: node!.id, before: null, index: 0, free: true, x, y, outline: r };
    const kids = (node!.children ?? []).filter((c) => c !== exclude).map((c) => ({ id: c, n: doc.findNode(c)?.node, el: shadow!.querySelector<HTMLElement>(`[data-rid="${c}"]`) })).filter((k) => k.el && !k.n?.absolute && !k.n?.hidden);
    const horizontal = mode === 'row';
    let before: string | null = null, index = kids.length;
    if (mode === 'grid') {
      let best = Infinity;
      kids.forEach((k, i) => {
        const b = k.el!.getBoundingClientRect();
        const d = Math.hypot(cx - (b.left + b.width / 2), cy - (b.top + b.height / 2));
        if (d < best) { best = d; const after = cx > b.left + b.width / 2; index = after ? i + 1 : i; before = (after ? kids[i + 1]?.id : k.id) ?? null; }
      });
    } else {
      for (const [i, k] of kids.entries()) {
        const b = k.el!.getBoundingClientRect();
        if ((horizontal ? cx < b.left + b.width / 2 : cy < b.top + b.height / 2)) { before = k.id; index = i; break; }
      }
    }
    // the insertion line sits between the neighbours (or at the content edge of an empty frame)
    const ref = before ? kids.find((k) => k.id === before) : kids[kids.length - 1];
    let line: DOMRect;
    if (ref) {
      const b = ref.el!.getBoundingClientRect();
      line = horizontal || (mode === 'grid')
        ? new DOMRect(before ? b.left - 2 : b.right + 2, b.top, 2, b.height)
        : new DOMRect(b.left, before ? b.top - 2 : b.bottom + 2, b.width, 2);
    } else line = new DOMRect(r.left + 8, r.top + 8, horizontal ? 2 : r.width - 16, horizontal ? r.height - 16 : 2);
    return { parent: node!.id, before, index, free: false, x, y, line, outline: r, vertical: horizontal || mode === 'grid' };
  }
  return { parent: null, before: null, index: 0, free: false, x: 0, y: 0 };
}

function indicators() {
  const line = document.createElement('div'), box = document.createElement('div'), ghost = document.createElement('div');
  line.className = 'dnd-line'; box.className = 'dnd-box'; ghost.className = 'dnd-ghost';
  document.body.append(line, box, ghost);
  return { line, box, ghost, remove: () => { line.remove(); box.remove(); ghost.remove(); } };
}
const place = (el: HTMLElement, r?: DOMRect) => {
  el.style.display = r ? 'block' : 'none';
  if (r) Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
};

const nameOf = (id: string | null) => (id ? getState().doc?.findNode(id)?.node.name ?? '' : '');
function describe(label: string, d: ReturnType<typeof dropAt>): string {
  if (!d) return `${label}: drop on the canvas`;
  if (!d.parent) return `${label}: new screen`;
  if (d.free) return `${label} at ${d.x}, ${d.y} in ${nameOf(d.parent)}`;
  return d.before ? `${label} before ${nameOf(d.before)}` : `${label} into ${nameOf(d.parent)}`;
}

function session(e: { clientX: number; clientY: number }, label: string, exclude: string | undefined, onDrop: (d: Drop) => void, onStart?: () => void) {
  const sx = e.clientX, sy = e.clientY;
  let ui: ReturnType<typeof indicators> | null = null;
  let last: ReturnType<typeof dropAt> = null;
  const update = (ev: PointerEvent) => {
    if (!ui) {
      if (Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      ui = indicators();
      ui.ghost.textContent = label;
      document.body.classList.add('is-dragging');
      setHover(null);
      onStart?.();
    }
    ui.ghost.style.transform = `translate(${ev.clientX + 14}px, ${ev.clientY + 18}px)`;
    const overCanvas = (ev.target as HTMLElement | null)?.closest?.('.canvas') || document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.canvas');
    last = overCanvas ? dropAt(ev.clientX, ev.clientY, ev.ctrlKey || ev.metaKey, exclude) : null;
    place(ui.line, last?.line);
    ui.line.classList.toggle('is-vertical', !!last?.vertical);
    // the line means "between siblings"; a tinted frame means "inside here"
    const inside = last && (last.free || !last.line || !(getState().doc?.findNode(last.parent ?? '')?.node.children?.length));
    place(ui.box, last?.outline);
    ui.box.classList.toggle('is-inside', !!inside);
    ui.ghost.textContent = describe(label, last);
  };
  const stop = () => {
    window.removeEventListener('pointermove', update);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('keydown', key, true);
    document.body.classList.remove('is-dragging');
    ui?.remove();
  };
  const up = () => { const started = !!ui, d = last; stop(); if (started) markDragged(); if (started && d) onDrop(d); };
  const key = (ev: KeyboardEvent) => { if (ev.key === 'Escape') { ev.stopPropagation(); last = null; stop(); } };
  window.addEventListener('pointermove', update);
  window.addEventListener('pointerup', up);
  window.addEventListener('keydown', key, true);
}

let dragged = false;
const markDragged = () => { dragged = true; };
/** true once after a drag, so the click that ends it does not change the selection */
export function consumeDnd(): boolean { const d = dragged; dragged = false; return d; }

/** Drag a new item (RDL) from the Add panel. */
export function startInsertDrag(e: React.PointerEvent, label: string, line: string) {
  session(e, label, undefined, async (d) => {
    const head = line.split('\n');
    const script = d.parent ? `insert #${d.parent} ${d.before ? `index ${d.index}` : 'end'}\n${indent(line)}` : head.join('\n');
    const res = await rdl(script, `add ${label}`);
    const id = res?.created[0];
    if (!id) return;
    if (d.free && d.parent) await rdl(`set #${id} abs at:${d.x},${d.y}`, 'place');
    select([id]);
  });
}

/** Drag an existing layer to another place in the layout. */
export function startLayerDrag(e: React.PointerEvent, node: RNode, el: HTMLElement) {
  session(e, node.name, node.id, async (d) => {
    if (!d.parent) return;
    const where = d.before ? `before #${d.before}` : `into #${d.parent} end`;
    const script = [`move #${node.id} ${where}`];
    if (d.free) script.push(`set #${node.id} abs at:${d.x},${d.y}`);
    else if (node.absolute) script.push(`set #${node.id} unset:abs`);
    await rdl(script.join('\n'), `move ${node.name}`);
    select([node.id]);
  }, () => { el.style.opacity = '.35'; window.addEventListener('pointerup', () => { el.style.opacity = ''; }, { once: true }); });
}

/** Snap guides for a moving free-floating layer: parent edges/centre and sibling edges/centres. */
export function snapper(el: HTMLElement, node: RNode, doc: RangoliDocument) {
  const parentEl = el.parentElement!;
  const pr = parentEl.getBoundingClientRect();
  const r0 = el.getBoundingClientRect();
  const xs: number[] = [pr.left, pr.left + pr.width / 2, pr.right];
  const ys: number[] = [pr.top, pr.top + pr.height / 2, pr.bottom];
  for (const c of (node.parent ? doc.node(node.parent).children ?? [] : [])) {
    if (c === node.id || !shadow) continue;
    const b = shadow.querySelector<HTMLElement>(`[data-rid="${c}"]`)?.getBoundingClientRect();
    if (!b?.width) continue;
    xs.push(b.left, b.left + b.width / 2, b.right);
    ys.push(b.top, b.top + b.height / 2, b.bottom);
  }
  const vg = document.createElement('div'), hg = document.createElement('div');
  vg.className = hg.className = 'dnd-guide';
  document.body.append(vg, hg);
  const snapAxis = (d: number, start: number, size: number, targets: number[]) => {
    for (const off of [0, size / 2, size]) for (const t of targets) { const delta = t - (start + d + off); if (Math.abs(delta) <= 5) return { d: d + delta, at: t }; }
    return { d };
  };
  return {
    apply(dx: number, dy: number) {
      const a = snapAxis(dx, r0.left, r0.width, xs), b = snapAxis(dy, r0.top, r0.height, ys);
      vg.style.display = a.at === undefined ? 'none' : 'block';
      hg.style.display = b.at === undefined ? 'none' : 'block';
      if (a.at !== undefined) Object.assign(vg.style, { left: `${a.at}px`, top: `${pr.top}px`, width: '1px', height: `${pr.height}px` });
      if (b.at !== undefined) Object.assign(hg.style, { left: `${pr.left}px`, top: `${b.at}px`, width: `${pr.width}px`, height: '1px' });
      return { dx: a.d, dy: b.d };
    },
    done() { vg.remove(); hg.remove(); },
  };
}
