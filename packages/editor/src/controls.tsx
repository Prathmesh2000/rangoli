import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ColorPopover } from './ColorPicker';
import type { Opt } from './helpers';
import { getState, rdl } from './store';

/** Apply RDL flags to one layer (every inspector edit is the same language an agent writes). */
export const setFlags = (id: string, flags: string, label?: string) => {
  const name = getState().doc?.findNode(id)?.node.name ?? `#${id}`;
  return rdl(`set #${id} ${flags}`, label ? `${name}: ${label}` : `${name}: ${flags.length > 40 ? flags.slice(0, 39) + '…' : flags}`);
};

export function Section({ title, children, collapsed, action }: { title: string; children: React.ReactNode; collapsed?: boolean; action?: React.ReactNode }) {
  const [open, setOpen] = useState(!collapsed);
  return (
    <section className="section">
      <div className="section-head">
        <button className="section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <span className="section-caret" aria-hidden>{open ? '▾' : '▸'}</span>
          <span className="section-title">{title}</span>
        </button>
        {open && action}
      </div>
      {open && children}
    </section>
  );
}

export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <div className="row-control">{children}</div>
    </div>
  );
}

export function Segmented({ value, options, labels, onChange }: { value: string; options: string[]; labels?: Record<string, string>; onChange: (v: string) => void }) {
  return (
    <div className="seg" role="radiogroup">
      {options.map((o) => (
        <button key={o} role="radio" aria-checked={value === o} className="seg-item" onClick={() => value !== o && onChange(o)}>
          {labels?.[o] ?? o}
        </button>
      ))}
    </div>
  );
}

export function Select({ value, options, placeholder, onChange }: { value: string; options: Opt[]; placeholder?: string; onChange: (v: string) => void }) {
  const known = options.some((o) => o.value === value);
  return (
    <select className="input select" value={known ? value : ''} onChange={(e) => e.target.value && onChange(e.target.value)}>
      <option value="" disabled>{value && !known ? value : placeholder ?? '—'}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function TextInput({ value, onCommit, small, placeholder, label }: { value: string; onCommit: (v: string) => void; small?: boolean; placeholder?: string; label?: string }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input className={`input${small ? ' input-sm' : ''}`} value={v} placeholder={placeholder} aria-label={label} onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v.trim())}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setV(value);
        e.stopPropagation();
      }} />
  );
}

/** Free-text field with a suggestion list: tokens are one click away, any value is allowed. */
export function Combo({ value, options, onCommit, placeholder, label, small }: { value: string; options: Opt[]; onCommit: (v: string) => void; placeholder?: string; label?: string; small?: boolean }) {
  const [v, setV] = useState(value);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typed, setTyped] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => setV(value), [value]);
  const commit = (next: string) => { if (next.trim() !== value) onCommit(next.trim()); };
  const list = typed && v ? options.filter((o) => `${o.value} ${o.label}`.toLowerCase().includes(v.toLowerCase())) : options;
  const show = () => { setRect(input.current?.getBoundingClientRect() ?? null); setOpen(true); setActive(-1); };
  const pick = (o: Opt) => { setV(o.value); setOpen(false); setTyped(false); commit(o.value); };
  return (
    <>
      <input ref={input} role="combobox" aria-expanded={open} className={`input${small ? ' input-sm' : ''}`} value={v} placeholder={placeholder} aria-label={label}
        onFocus={show} onClick={show}
        onChange={(e) => { setV(e.target.value); setTyped(true); if (!open) show(); }}
        onBlur={() => { setOpen(false); setTyped(false); commit(v); }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(); setActive((a) => Math.min(list.length - 1, a + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          if (e.key === 'Enter') { if (open && list[active]) { e.preventDefault(); pick(list[active]!); } else e.currentTarget.blur(); }
          if (e.key === 'Escape') { setV(value); setOpen(false); }
        }} />
      {open && rect && list.length > 0 && createPortal(
        <div className="combo-list" role="listbox" style={{ left: rect.left, top: rect.bottom + 2, minWidth: Math.max(rect.width, 150) }} onPointerDown={(e) => e.preventDefault()}>
          {list.slice(0, 200).map((o, i) => (
            <button key={o.value} role="option" aria-selected={i === active} className={`combo-opt${i === active ? ' is-active' : ''}`} onClick={() => pick(o)}>
              {o.swatch && <span className="swatch" style={{ background: o.swatch }} />}<span>{o.label}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

/** Colour: opens the full picker; the text field still takes any token, #hex or token~alpha. */
export function ColorField({ value, options, onCommit, swatch: given, placeholder, label, allowNone, live }: { value: string; options: Opt[]; onCommit: (v: string) => void; swatch?: string; placeholder?: string; label?: string; allowNone?: boolean; live?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const bare = value.replace(/~\d+$/, '');
  const swatch = given ?? (/^#[0-9a-f]{6}$/i.test(bare) ? bare : options.find((o) => o.value === bare)?.swatch);
  return (
    <div className="color-select">
      <button ref={trigger} className="swatch swatch-pick" style={{ background: swatch ?? 'transparent' }} data-empty={!swatch} aria-label={`${label ?? 'Colour'} picker`} aria-haspopup="dialog" title="Open colour picker"
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())} />
      <Combo value={value} options={options} onCommit={onCommit} placeholder={placeholder} label={label} />
      {anchor && <ColorPopover anchor={anchor} value={value} swatch={swatch} options={options} allowNone={allowNone} live={live} onCommit={onCommit} onClose={() => { setAnchor(null); trigger.current?.focus(); }} />}
    </div>
  );
}

export function Toggle({ on, onClick, children, title }: { on: boolean; onClick: () => void; children: React.ReactNode; title?: string }) {
  return <button className="tog" aria-pressed={on} title={title} onClick={onClick}>{children}</button>;
}

export function Area({ value, onCommit, placeholder, label, rows = 3, code }: { value: string; onCommit: (v: string) => void; placeholder?: string; label?: string; rows?: number; code?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <textarea className={`input textarea${code ? ' mono' : ''}`} value={v} rows={rows} placeholder={placeholder} aria-label={label} spellCheck={!code}
      onChange={(e) => setV(e.target.value)} onBlur={() => v !== value && onCommit(v.trim())} onKeyDown={(e) => e.stopPropagation()} />
  );
}
