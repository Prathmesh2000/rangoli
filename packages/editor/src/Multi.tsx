import type { RNode } from '@rangoli/engine';
import { nodeFlags } from './helpers';
import { getState, rdl, select, toast, useEditor } from './store';

const STYLE_KEYS = ['fill', 'stroke', 'color', 'font', 'size', 'weight', 'lh', 'ls', 'opacity', 'blur', 'bgblur', 'blend', 'overflow'];
let clip: string[] = [];

/** Copy a layer's look: colours, border, shadows, type, effects. */
export function copyStyle(node: RNode) {
  const doc = getState().doc!;
  const f = nodeFlags(doc, node);
  const flags = STYLE_KEYS.filter((k) => f.kv[k] !== undefined).map((k) => `${k}:${/\s/.test(f.kv[k]!) ? JSON.stringify(f.kv[k]) : f.kv[k]}`);
  f.shadows.forEach((s, i) => flags.push(`shadow${i ? '+' : ''}:${s}`));
  for (const b of f.bare) if (/^r(\d|full|card|control)|^(italic|underline|strike|upper|lower|capitalize)$/.test(b)) flags.push(b);
  if (f.kv.r) flags.push(`r:${f.kv.r}`);
  clip = flags;
  toast('info', flags.length ? 'Style copied. Ctrl+Alt+V pastes it.' : 'That layer has no style of its own to copy');
}

export async function pasteStyle(ids: string[]) {
  if (clip.length) await rdl(ids.map((id) => `set #${id} ${clip.join(' ')}`).join('\n'), 'paste style');
}

/** Wrap the selected layers in a new frame, placed where the first one was. */
export async function groupSelection() {
  const s = getState();
  const doc = s.doc!;
  const nodes = s.selection.map((id) => doc.findNode(id)?.node).filter((n): n is RNode => !!n);
  const parent = nodes[0]?.parent;
  if (!nodes.length || nodes.some((n) => n.parent !== parent)) return toast('error', 'Select layers from the same parent to group them');
  const gid = `g${Date.now().toString(36)}`;
  const line = `Group#${gid} col gap2`;
  const head = parent ? `insert #${nodes[0]!.id} before\n  ${line}` : line;
  const res = await rdl([head, ...nodes.map((n) => `move #${n.id} into #${gid} end`)].join('\n'), 'group');
  if (res) select([gid]);
}

type Edge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';

async function align(edge: Edge) {
  const s = getState();
  const doc = s.doc!;
  const nodes = s.selection.map((id) => doc.findNode(id)?.node).filter((n): n is RNode => !!n && !!n.position);
  if (nodes.length < 2) return toast('error', 'Align works on free-floating layers. Use Absolute in Position, or a Row/Column.');
  const shadow = document.querySelector('.canvas-zoom > div')?.shadowRoot;
  const zoom = s.zoom;
  const box = (id: string) => { const r = shadow?.querySelector(`[data-rid="${id}"]`)?.getBoundingClientRect(); return { w: (r?.width ?? 0) / zoom, h: (r?.height ?? 0) / zoom }; };
  const items = nodes.map((n) => ({ n, x: n.position!.x, y: n.position!.y, ...box(n.id) }));
  const minX = Math.min(...items.map((i) => i.x)), maxX = Math.max(...items.map((i) => i.x + i.w));
  const minY = Math.min(...items.map((i) => i.y)), maxY = Math.max(...items.map((i) => i.y + i.h));
  const script = items.map((i) => {
    const x = edge === 'left' ? minX : edge === 'right' ? maxX - i.w : edge === 'hcenter' ? (minX + maxX - i.w) / 2 : i.x;
    const y = edge === 'top' ? minY : edge === 'bottom' ? maxY - i.h : edge === 'vcenter' ? (minY + maxY - i.h) / 2 : i.y;
    return `set #${i.n.id} at:${Math.round(x)},${Math.round(y)}`;
  });
  await rdl(script.join('\n'), `align ${edge}`);
}

async function distribute(axis: 'x' | 'y') {
  const s = getState();
  const nodes = s.selection.map((id) => s.doc!.findNode(id)?.node).filter((n): n is RNode => !!n?.position).sort((a, b) => a.position![axis] - b.position![axis]);
  if (nodes.length < 3) return toast('error', 'Distribute needs three or more free-floating layers');
  const first = nodes[0]!.position![axis], step = (nodes[nodes.length - 1]!.position![axis] - first) / (nodes.length - 1);
  await rdl(nodes.map((n, i) => `set #${n.id} at:${axis === 'x' ? Math.round(first + step * i) : n.position!.x},${axis === 'y' ? Math.round(first + step * i) : n.position!.y}`).join('\n'), 'distribute');
}

const BUTTONS: [Edge, string, string][] = [
  ['left', 'Align left', 'M4 3v18M8 7h12M8 15h7'], ['hcenter', 'Align centre', 'M12 3v18M6 7h12M8 15h8'], ['right', 'Align right', 'M20 3v18M4 7h12M9 15h7'],
  ['top', 'Align top', 'M3 4h18M7 8v12M15 8v7'], ['vcenter', 'Align middle', 'M3 12h18M7 6v12M15 8v8'], ['bottom', 'Align bottom', 'M3 20h18M7 4v12M15 9v7'],
];

export function SelectionTools() {
  const count = useEditor((s) => s.selection.length);
  const view = useEditor((s) => s.compare);
  if (count < 2 || view) return null;
  return (
    <div className="sel-tools" role="toolbar" aria-label="Selection">
      {BUTTONS.map(([e, name, d]) => (
        <button key={e} className="draw-tool" aria-label={name} title={name} onClick={() => void align(e)}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d={d} /></svg>
        </button>
      ))}
    </div>
  );
}

export function MultiPanel({ ids }: { ids: string[] }) {
  return (
    <div className="panel-empty">
      <p>{ids.length} layers selected</p>
      <div className="btn-row">
        <button className="btn btn-sm-inline" onClick={() => void groupSelection()}>Group (Ctrl+G)</button>
        <button className="btn btn-sm-inline" onClick={() => void distribute('x')}>Space across</button>
        <button className="btn btn-sm-inline" onClick={() => void distribute('y')}>Space down</button>
      </div>
    </div>
  );
}
