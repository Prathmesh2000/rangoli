import { memo, useState } from 'react';
import { canEdit, rdl, select, setHover, useEditor, getState } from './store';

/** Drag a layer row: upper/lower edge = before/after, middle of a container row = inside it. */
function startRowDrag(e: React.PointerEvent, id: string) {
  const sy = e.clientY;
  let line: HTMLDivElement | null = null;
  let drop: string | null = null;
  const doc = getState().doc!;
  const inside = (t: string) => { for (let c: string | undefined = t; c; c = doc.findNode(c)?.node.parent) if (c === id) return true; return false; };
  const mv = (ev: PointerEvent) => {
    if (!line && Math.abs(ev.clientY - sy) < 5) return;
    if (!line) { line = document.createElement('div'); line.className = 'dnd-line'; document.body.appendChild(line); }
    const row = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>('[data-layer]');
    const t = row?.dataset.layer;
    if (!row || !t || inside(t)) { line.style.display = 'none'; drop = null; return; }
    const r = row.getBoundingClientRect(), f = (ev.clientY - r.top) / r.height;
    const n = doc.findNode(t)!.node;
    const into = f > 0.3 && f < 0.7 && (n.type === 'frame' || n.type === 'group');
    if (!n.parent && !into) { line.style.display = 'none'; drop = null; return; }
    drop = into ? `into #${t} end` : f < 0.5 ? `before #${t}` : `after #${t}`;
    Object.assign(line.style, into ? { display: 'block', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, opacity: '.3' } : { display: 'block', left: `${r.left}px`, top: `${f < 0.5 ? r.top - 1 : r.bottom - 1}px`, width: `${r.width}px`, height: '2px', opacity: '1' });
  };
  const up = () => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    line?.remove();
    if (drop) void rdl(`move #${id} ${drop}`, 'reorder');
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}
import { TYPE_GLYPH } from './helpers';

export function Layers() {
  const version = useEditor((s) => s.version);
  const doc = useEditor((s) => s.doc);
  if (!doc) return <div className="panel-empty">Loading…</div>;
  const roots = doc.page().children;
  return (
    <div className="layers" role="tree" aria-label="Layers" data-v={version}>
      {roots.length === 0 && <div className="panel-empty">No layers yet</div>}
      {roots.map((id) => (
        <LayerRow key={id} id={id} depth={0} version={version} />
      ))}
    </div>
  );
}

const LayerRow = memo(function LayerRow({ id, depth, version }: { id: string; depth: number; version: number }) {
  const node = useEditor((s) => s.doc?.findNode(id)?.node);
  const selected = useEditor((s) => s.selection.includes(id));
  const hovered = useEditor((s) => s.hover === id);
  const [open, setOpen] = useState(depth < 2);
  const [editing, setEditing] = useState(false);
  if (!node) return null;
  const kids = node.children ?? [];
  const label = node.component ? `${node.name}` : node.type === 'text' ? node.text?.slice(0, 40) || node.name : node.name;

  return (
    <>
      <div
        role="treeitem"
        aria-selected={selected}
        aria-expanded={kids.length ? open : undefined}
        className={`layer${selected ? ' is-sel' : ''}${hovered ? ' is-hover' : ''}${node.hidden ? ' is-hidden' : ''}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-layer={id}
        onPointerDown={(e) => { if (e.button === 0 && canEdit() && !editing && node.parent) startRowDrag(e, id); }}
        onMouseEnter={() => setHover(id)}
        onMouseLeave={() => setHover(null)}
        onClick={(e) => {
          const cur = getState().selection;
          select(e.shiftKey ? (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]) : [id]);
        }}
        onDoubleClick={() => setEditing(true)}
      >
        <button
          className="layer-twisty"
          aria-label={open ? 'Collapse' : 'Expand'}
          style={{ visibility: kids.length ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
        >
          {open ? '▾' : '▸'}
        </button>
        <span className={`layer-glyph t-${node.type}`} aria-hidden>
          {TYPE_GLYPH[node.type]}
        </span>
        {editing ? (
          <input
            className="layer-rename"
            autoFocus
            defaultValue={node.name}
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              setEditing(false);
              const v = e.currentTarget.value.trim();
              if (v && v !== node.name) void rdl(`set #${id} name:${JSON.stringify(v)}`, 'rename');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
              e.stopPropagation();
            }}
          />
        ) : (
          <span className="layer-name">{label}</span>
        )}
        <span className="layer-id">#{id}</span>
      </div>
      {open && kids.map((c) => <LayerRow key={c} id={c} depth={depth + 1} version={version} />)}
    </>
  );
});
