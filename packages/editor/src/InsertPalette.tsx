import { useEffect, useMemo, useRef, useState } from 'react';
import { LIBRARY, PATTERNS } from '@rangoli/engine';

interface Entry {
  key: string;
  label: string;
  group: string;
  hint: string;
  rdl: string;
}

const BASICS: Entry[] = [
  { key: 'frame', label: 'Frame', group: 'Basics', hint: 'Container with auto layout', rdl: 'Frame col gap3 p4 w320 fill:surface stroke:border r3' },
  { key: 'text', label: 'Text', group: 'Basics', hint: 'Body text', rdl: 'Text body "Text"' },
  { key: 'heading', label: 'Heading', group: 'Basics', hint: 'Section title', rdl: 'Title text title "Heading"' },
  { key: 'icon', label: 'Icon', group: 'Basics', hint: '16px icon (change in Design)', rdl: 'Icon icon:check w16 h16' },
  { key: 'image', label: 'Image slot', group: 'Basics', hint: 'Placeholder until an asset is set', rdl: 'Image w320 h180 alt:"Describe the image"' },
];

/** Searchable palette of basics, every component and every pattern. */
export function InsertPalette({ onInsert, onClose }: { onInsert: (rdl: string, label: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const all = useMemo<Entry[]>(
    () => [
      ...BASICS,
      ...Object.entries(LIBRARY).map(([name, d]) => ({ key: `c-${name}`, label: name, group: `Components · ${d.doc.category}`, hint: d.doc.description, rdl: d.doc.example })),
      ...Object.entries(PATTERNS).map(([name, p]) => ({ key: `p-${name}`, label: name.replace(/-/g, ' '), group: `Patterns · ${p.category}`, hint: p.description, rdl: `+${name}` })),
    ],
    [],
  );
  const q = query.trim().toLowerCase();
  const list = q ? all.filter((e) => `${e.label} ${e.group} ${e.hint}`.toLowerCase().includes(q)) : all;
  const groups = useMemo(() => {
    const m = new Map<string, Entry[]>();
    for (const e of list) m.set(e.group, [...(m.get(e.group) ?? []), e]);
    return [...m];
  }, [list]);
  const pick = (e: Entry) => {
    onInsert(e.rdl, `insert ${e.label}`);
    onClose();
  };

  return (
    <div className="palette" role="dialog" aria-label="Insert" onKeyDown={(e) => e.stopPropagation()}>
      <input ref={inputRef} className="input" placeholder={`Search ${all.length} components and patterns…`} value={query}
        onChange={(e) => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(list.length - 1, a + 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
          if (e.key === 'Enter' && list[active]) pick(list[active]!);
        }} />
      <div className="palette-list" role="listbox">
        {!list.length && <p className="hint" style={{ padding: 12 }}>Nothing matches “{query}”.</p>}
        {groups.map(([g, entries]) => (
          <section key={g}>
            <h4 className="palette-group">{g}</h4>
            {entries.map((e) => {
              const idx = list.indexOf(e);
              return (
                <button key={e.key} role="option" aria-selected={idx === active} className={`palette-item${idx === active ? ' is-active' : ''}`} onMouseEnter={() => setActive(idx)} onClick={() => pick(e)} title={e.rdl}>
                  <span className="palette-name">{e.label}</span>
                  <span className="palette-hint">{e.hint}</span>
                </button>
              );
            })}
          </section>
        ))}
      </div>
      <p className="palette-foot hint">Inserts into the selected frame · ↑↓ Enter · Esc</p>
    </div>
  );
}
