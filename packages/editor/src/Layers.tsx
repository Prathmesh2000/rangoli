import { memo, useState } from 'react';
import { rdl, select, setHover, useEditor, getState } from './store';
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
