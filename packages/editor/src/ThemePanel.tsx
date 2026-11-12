import { useState } from 'react';
import { THEME_PRESETS, TokenResolver, customFonts, themesOf, type RangoliDocument } from '@rangoli/engine';
import { ColorField, Row, TextInput } from './controls';
import { FontField } from './FontPicker';
import { getState, rdl, setMode, useEditor } from './store';

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').replace(/^(\d)/, 't$1');

export function ThemeManager({ doc }: { doc: RangoliDocument }) {
  const mode = useEditor((s) => s.mode);
  const themes = themesOf(doc.data.tokens);
  const r = new TokenResolver(doc.data.tokens);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [seeds, setSeeds] = useState({ bg: '#101820', surface: '#1a2530', text: '#f4f7fa', primary: '#ffb000' });
  const addPreset = async (id: string) => { if (await rdl(`theme ${id} preset=${id}`, `theme ${id}`)) setMode(id); };
  const create = async () => {
    const id = slug(name);
    if (!id) return;
    if (await rdl(`theme ${id} name=${JSON.stringify(name.trim())} bg=${seeds.bg} surface=${seeds.surface} text=${seeds.text} primary=${seeds.primary}`, `theme ${name}`)) { setMaking(false); setName(''); setMode(id); }
  };
  const remove = async (id: string) => { if (await rdl(`theme ${id} none`, `remove theme ${id}`) && mode === id) setMode('light'); };
  const field = (k: keyof typeof seeds, label: string) => (
    <Row label={label}><ColorField value={seeds[k]} swatch={seeds[k]} options={[]} label={`Theme ${label}`} onCommit={(v) => { const hex = /^#[0-9a-f]{6}/i.exec(v)?.[0]; if (hex) setSeeds({ ...seeds, [k]: hex }); }} /></Row>
  );
  return (
    <section className="section">
      <h3 className="section-title">Themes</h3>
      {Object.entries(themes).map(([id, t]) => (
        <div key={id} className="theme-row">
          <span className="swatch" style={{ background: r.resolve('color.bg.canvas', id) as string }} />
          <span>{t.name}</span>
          <button className="btn btn-sm-inline" disabled={mode === id} onClick={() => setMode(id)}>{mode === id ? 'Active' : 'Use'}</button>
          <button className="btn btn-icon" aria-label={`Delete ${t.name} theme`} title="Delete (undoable)" onClick={() => void remove(id)}>×</button>
        </div>
      ))}
      <div className="theme-chips">
        {Object.entries(THEME_PRESETS).filter(([id]) => !themes[id]).map(([id, t]) => (
          <button key={id} className="theme-chip" title={`Add the ${t.name} theme`} onClick={() => void addPreset(id)}>
            <span className="theme-prev" style={{ background: t.bg }}><i style={{ background: t.surface ?? t.bg }} /><i style={{ background: t.primary }} /></span>
            <span className="theme-name">{t.name}</span>
          </button>
        ))}
      </div>
      {!making && <button className="btn btn-sm-inline" onClick={() => setMaking(true)}>New theme</button>}
      {making && (
        <>
          <Row label="Name"><input className="input" aria-label="Theme name" value={name} placeholder="Brand night" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></Row>
          {field('bg', 'Page')}{field('surface', 'Surface')}{field('text', 'Text')}{field('primary', 'Accent')}
          <div className="btn-row">
            <button className="btn btn-primary" disabled={!slug(name)} onClick={() => void create()}>Create</button>
            <button className="btn" onClick={() => setMaking(false)}>Cancel</button>
          </div>
          <p className="hint">The rest is derived and kept readable. Pick the theme in the top bar, then edit any token below for it.</p>
        </>
      )}
    </section>
  );
}

const SCALES: [string, number][] = [['Minor third', 1.2], ['Major third', 1.25], ['Perfect fourth', 1.333], ['Golden', 1.618]];

export function FontTokens({ doc }: { doc: RangoliDocument }) {
  const raw = (p: string) => { const v = new TokenResolver(doc.data.tokens).resolve(`font.family.${p}`); return (Array.isArray(v) ? String(v[0]) : String(v ?? '')).replace(/^["']|["']$/g, ''); };
  const set = (k: string, family: string) => family && void rdl(`token font.family.${k} ${JSON.stringify(family)}`, `${k} font`);
  const custom = Object.keys(customFonts(doc.data.tokens));
  const [base, setBase] = useState(String((new TokenResolver(getState().doc!.data.tokens).resolve('textStyle.body') as { fontSize: number }).fontSize));
  const applyScale = (ratio: number) => {
    const b = Number(base);
    if (!(b > 0)) return;
    const size = (n: number) => Math.round(b * ratio ** n);
    const map: [string, number][] = [['caption', -2], ['body-sm', -1], ['body', 0], ['body-lg', 1], ['title-sm', 1], ['title', 2], ['headline', 3], ['display', 5]];
    void rdl(map.flatMap(([s, n]) => [`token textStyle.${s}.fontSize ${Math.max(11, size(n))}`, `token textStyle.${s}.lineHeight ${Math.round(Math.max(11, size(n)) * (n > 1 ? 1.2 : 1.5))}`]).join('\n'), 'type scale');
  };
  return (
    <section className="section">
      <h3 className="section-title">Fonts</h3>
      {([['display', 'Headings'], ['sans', 'Body'], ['mono', 'Code']] as const).map(([k, l]) => (
        <Row key={k} label={l}><FontField value={raw(k)} tokens={false} label={`${l} font`} onPick={(f) => set(k, f)} /></Row>
      ))}
      {custom.length > 0 && <p className="hint">Added: {custom.join(', ')}</p>}
      <Row label="Base size"><TextInput value={base} label="Base font size" onCommit={setBase} /></Row>
      <div className="btn-row">{SCALES.map(([n, r]) => <button key={n} className="btn btn-sm-inline" title={`Rebuild every text size at a ${r} ratio`} onClick={() => applyScale(r)}>{n}</button>)}</div>
    </section>
  );
}
