import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { findIcon, iconSvg, packIconNames } from '@rangoli/engine';
import { getState, setView, useEditor } from './store';

const COLS = 6, CELL = 46;

function Popover({ anchor, value, onPick, onClose }: { anchor: DOMRect; value: string; onPick: (v: string) => void; onClose: () => void }) {
  useEditor((s) => s.version);
  const [q, setQ] = useState('');
  const [top, setTop] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const doc = getState().doc!;
  const all = useMemo(() => [
    ...Object.values(doc.data.icons ?? {}).filter((s) => s.name !== 'drafts').flatMap((s) => Object.keys(s.icons).map((n) => `${s.name}/${n}`)),
    ...packIconNames('lucide').map((n) => `lucide/${n}`),
  ], [doc, doc.data.icons]);
  const s = q.trim().toLowerCase();
  const list = s ? all.filter((n) => n.includes(s)) : all;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const edge = document.querySelector('.right')?.getBoundingClientRect().left ?? anchor.left;
    el.style.left = `${Math.max(8, edge - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, anchor.top - 12))}px`;
  });
  useEffect(() => {
    const off = (e: PointerEvent) => { if (ref.current && !e.composedPath().includes(ref.current)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = window.setTimeout(() => window.addEventListener('pointerdown', off), 0);
    window.addEventListener('keydown', key, true);
    return () => { window.clearTimeout(t); window.removeEventListener('pointerdown', off); window.removeEventListener('keydown', key, true); };
  }, [onClose]);
  const startRow = Math.max(0, Math.floor(top / CELL) - 1);
  const visible = list.slice(startRow * COLS, (startRow + 9) * COLS);
  return createPortal(
    <div className="ip" ref={ref} role="dialog" aria-label="Icon picker" onKeyDown={(e) => e.stopPropagation()}>
      <input className="input" autoFocus placeholder={`Search ${list.length.toLocaleString('en-US')} icons`} aria-label="Search icons" value={q} onChange={(e) => { setQ(e.target.value); setTop(0); }} />
      <div className="ip-list" onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        <div style={{ height: Math.ceil(list.length / COLS) * CELL, position: 'relative' }}>
          {visible.map((ref2, i) => {
            const f = findIcon(doc.data.icons, ref2);
            if (!f) return null;
            const idx = startRow * COLS + i;
            const short = ref2.startsWith('lucide/') ? ref2.slice(7) : ref2;
            return <button key={ref2} className="ip-tile" title={short} aria-label={short} aria-selected={value === short || value === ref2} style={{ left: (idx % COLS) * CELL, top: Math.floor(idx / COLS) * CELL }} onClick={() => { onPick(short); onClose(); }} dangerouslySetInnerHTML={{ __html: iconSvg(f.set, f.icon, { size: 20 }) }} />;
          })}
        </div>
      </div>
      <button className="btn btn-sm-inline" onClick={() => { onClose(); setView('icons'); }}>Draw or import your own</button>
    </div>,
    document.body,
  );
}

/** Icon field: shows the current icon; opens a searchable grid of every available icon. */
export function IconField({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const f = value ? findIcon(getState().doc?.data.icons, value) : undefined;
  return (
    <>
      <button ref={trigger} className="input icon-field" aria-haspopup="dialog" aria-label="Choose icon" onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        {f && <span dangerouslySetInnerHTML={{ __html: iconSvg(f.set, f.icon, { size: 16 }) }} />}
        <span>{value || 'None'}</span>
      </button>
      {anchor && <Popover anchor={anchor} value={value} onPick={onPick} onClose={() => { setAnchor(null); trigger.current?.focus(); }} />}
    </>
  );
}
