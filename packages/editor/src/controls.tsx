import { useEffect, useId, useRef, useState } from 'react';
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

/** Free-text field with token suggestions: tokens are one click away, any value is allowed. */
export function Combo({ value, options, onCommit, placeholder, label, small }: { value: string; options: Opt[]; onCommit: (v: string) => void; placeholder?: string; label?: string; small?: boolean }) {
  const id = useId();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  const commit = (next: string) => { if (next !== value) onCommit(next.trim()); };
  return (
    <>
      <input className={`input${small ? ' input-sm' : ''}`} list={id} value={v} placeholder={placeholder} aria-label={label}
        onChange={(e) => {
          setV(e.target.value);
          // picking from the suggestion list applies at once; typing waits for Enter or blur
          if (options.some((o) => o.value === e.target.value) && (e.nativeEvent as InputEvent).inputType !== 'insertText') commit(e.target.value);
        }}
        onBlur={() => commit(v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
          if (e.key === 'Escape') setV(value);
          e.stopPropagation();
        }} />
      <datalist id={id}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</datalist>
    </>
  );
}

/** Colour: native picker for any custom colour + free-text field with token suggestions (token~alpha, #hex). */
export function ColorField({ value, options, onCommit, swatch, placeholder, label }: { value: string; options: Opt[]; onCommit: (v: string) => void; swatch?: string; placeholder?: string; label?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // the native "change" event fires once when the picker closes (React's onChange fires while dragging)
    const fn = () => commit.current(el.value);
    el.addEventListener('change', fn);
    return () => el.removeEventListener('change', fn);
  }, []);
  const hex = swatch && /^#[0-9a-f]{6}$/i.test(swatch) ? swatch : '#808080';
  return (
    <div className="color-select">
      <label className="swatch swatch-pick" style={{ background: swatch ?? 'transparent' }} data-empty={!swatch} title="Pick any colour">
        <input ref={ref} type="color" key={hex} defaultValue={hex} aria-label={`${label ?? 'Colour'} picker`} />
      </label>
      <Combo value={value} options={options} onCommit={onCommit} placeholder={placeholder} label={label} />
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
