import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ASSET_PROXY, applyRdl, cloneDocument, compileIcon, findIcon, iconReact, iconSprite, iconSvg, lintIcons, normalizePath, packIconNames, svgToIconSrc, type Diagnostic, type IconDef, type IconSet } from '@rangoli/engine';
import { renderInto } from './Canvas';
import { indent } from './helpers';
import { Row, Section, Segmented, TextInput, Toggle } from './controls';
import { canEdit, getState, rdl, setState, toast, useEditor } from './store';
import { VectorBoard, VectorTools, bboxOf, getOpt, importSvgText, loadPaper, mapLine, parseLine, setOpt, usePathOps, useVector, type VTool, type VState } from './VectorEditor';

const download = (name: string, content: string, type = 'image/svg+xml') => {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  URL.revokeObjectURL(url);
};
const slug = (s: string) => s.toLowerCase().replace(/\.[a-z0-9]+$/, '').replace(/[^a-z0-9~-]+/g, '-').replace(/^-|-$/g, '') || 'icon';
const uniqueName = (set: IconSet | undefined, base: string) => { let n = base, k = 2; while (set?.icons[n]) n = `${base}-${k++}`; return n; };
const iconScript = (ref: string, src: string, stroke?: number) => `icon ${ref}${stroke ? ` stroke${stroke}` : ''}\n${indent(src)}`;

export function IconStudio() {
  const version = useEditor((s) => s.version);
  const sel = useEditor((s) => s.iconSel);
  const doc = getState().doc;
  const sets = doc?.data.icons ?? {};
  const [setName, iconName] = (sel ?? '').split('/') as [string, string];
  const set = sets[setName ?? ''];
  const icon = set?.icons[iconName ?? ''];
  const [leftTab, setLeftTab] = useState<'mine' | 'library'>('mine');

  useEffect(() => {
    if (!sel) {
      const first = Object.values(sets).find((s) => s.name !== 'drafts' && Object.keys(s.icons).length);
      const name = first && Object.keys(first.icons)[0];
      if (first && name) setState({ iconSel: `${first.name}/${name}` });
    }
  }, [version, sel, sets]);

  if (!doc) return null;
  return (
    <div className="studio">
      <aside className="studio-left">
        <div className="tabs tabs-top" role="tablist">
          <button role="tab" aria-selected={leftTab === 'mine'} className="tab" onClick={() => setLeftTab('mine')}>My icons</button>
          <button role="tab" aria-selected={leftTab === 'library'} className="tab" onClick={() => setLeftTab('library')}>Library</button>
        </div>
        {leftTab === 'mine' ? <IconSets sets={sets} sel={sel} /> : <IconLibrary sets={sets} />}
      </aside>
      {set && icon ? <Editor key={sel} set={set} icon={icon} /> : <main className="studio-center"><div className="panel-empty">Select an icon</div></main>}
    </div>
  );
}

function Editor({ set, icon }: { set: IconSet; icon: IconDef }) {
  const v = useVector(set, icon);
  const [tool, setTool] = useState<VTool>('select');
  const [snap, setSnap] = useState(0.5);
  const [sym, setSym] = useState('');
  const c = set.grid / 2;
  const preview: IconDef = { ...icon, src: v.lines.join('\n') ? `exact\n${v.lines.join('\n')}` : icon.src };
  return (
    <>
      <main className="studio-center vs-center">
        <div className="vs-top">
          <VectorTools tool={tool} setTool={setTool} />
          <label className="vs-snap">Snap
            <select className="input" aria-label="Snap step" value={snap} onChange={(e) => setSnap(Number(e.target.value))}>
              <option value={1}>1</option><option value={0.5}>0.5</option><option value={0.25}>0.25</option><option value={0}>Off</option>
            </select>
          </label>
          <label className="vs-snap">Symmetry
            <select className="input" aria-label="Live symmetry for new shapes" value={sym} onChange={(e) => setSym(e.target.value)}>
              <option value="">Off</option><option value={`h${c}`}>Left-right</option><option value={`v${c}`}>Top-bottom</option><option value={`hv${c}`}>Both</option><option value={`r3c${c}`}>Radial 3</option><option value={`r4c${c}`}>Radial 4</option><option value={`r6c${c}`}>Radial 6</option><option value={`r8c${c}`}>Radial 8</option>
            </select>
          </label>
        </div>
        <VectorBoard set={set} icon={icon} v={v} tool={tool} setTool={setTool} snapStep={snap} symmetry={sym} />
        <IconPreview set={set} icon={preview} />
      </main>
      <aside className="studio-right"><IconPanel set={set} icon={icon} v={v} /></aside>
    </>
  );
}

function IconSets({ sets, sel }: { sets: Record<string, IconSet>; sel: string | null }) {
  const [q, setQ] = useState('');
  const [newSet, setNewSet] = useState(false);
  const [name, setName] = useState('');
  const [grid, setGrid] = useState('24');
  const [stroke, setStroke] = useState('1.5');
  const drafts = sets.drafts;
  const main = Object.values(sets).filter((s) => s.name !== 'drafts');
  const target = sel?.split('/')[0] && sets[sel.split('/')[0]!] && sel.split('/')[0] !== 'drafts' ? sel.split('/')[0]! : main[0]?.name ?? 'ui';
  const file = useRef<HTMLInputElement>(null);
  const groups = useMemo(() => {
    const g = new Map<string, IconDef[]>();
    for (const ic of Object.values(drafts?.icons ?? {})) {
      const base = ic.name.split('~')[0]!;
      g.set(base, [...(g.get(base) ?? []), ic]);
    }
    return [...g];
  }, [drafts]);
  const keep = (base: string, ic: IconDef) => {
    const discard = (drafts ? Object.keys(drafts.icons) : []).filter((n) => n.split('~')[0] === base).map((n) => `icon drafts/${n} none`);
    void rdl([iconScript(`${target}/${base}`, ic.src, ic.stroke), ...discard].join('\n'), `keep ${ic.name} as ${target}/${base}`).then((r) => r && setState({ iconSel: `${target}/${base}` }));
  };
  const importFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const set = sets[target];
    const parts: string[] = [];
    let last = '', skipped = 0;
    for (const f of [...files]) {
      try {
        const { src } = svgToIconSrc(await f.text(), set?.grid ?? 24);
        const n = uniqueName(set, slug(f.name));
        parts.push(iconScript(`${target}/${n}`, src));
        last = `${target}/${n}`;
      } catch { skipped++; }
    }
    if (parts.length && (await rdl(parts.join('\n'), `import ${parts.length} icons`))) setState({ iconSel: last });
    if (skipped) toast('error', `${skipped} file(s) had no usable shapes`);
  };
  const create = async () => {
    const n = slug(name);
    if (n && (await rdl(`iconset ${n} grid${Number(grid) || 24} stroke${Number(stroke) || 1.5} round\nicon ${n}/first\n  circle 12 12 8.5`, `new set ${n}`))) { setNewSet(false); setName(''); setState({ iconSel: `${n}/first` }); }
  };
  const match = (ic: IconDef) => !q || `${ic.name} ${(ic.tags ?? []).join(' ')}`.includes(q.toLowerCase());
  return (
    <>
      <section className="section">
        <input className="input" placeholder="Search my icons" aria-label="Search my icons" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
        {canEdit() && (
          <div className="btn-row">
            <button className="btn btn-sm-inline" onClick={() => file.current?.click()}>Import SVG</button>
            <input ref={file} type="file" hidden multiple accept=".svg,image/svg+xml" aria-label="Import SVG files" onChange={(e) => void importFiles(e.target.files)} />
            <button className="btn btn-sm-inline" onClick={() => setNewSet(!newSet)}>New set</button>
          </div>
        )}
        {newSet && (
          <div className="comp-edit">
            <Row label="Name"><input className="input" aria-label="Set name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></Row>
            <Row label="Grid / stroke"><div className="pair"><TextInput value={grid} label="Grid size" onCommit={setGrid} /><TextInput value={stroke} label="Stroke width" onCommit={setStroke} /></div></Row>
            <button className="btn btn-primary" disabled={!slug(name) || !name.trim()} onClick={() => void create()}>Create set</button>
          </div>
        )}
      </section>
      {groups.length > 0 && drafts && (
        <section className="section">
          <h3 className="section-title">Drafts: pick one</h3>
          {groups.map(([base, list]) => (
            <div key={base} className="draft-group">
              <div className="draft-name">{base}</div>
              <div className="icon-grid">
                {list.map((ic) => (
                  <div key={ic.name} className={`draft${sel === `drafts/${ic.name}` ? ' is-sel' : ''}`}>
                    <button className="icon-tile" title={ic.name} onClick={() => setState({ iconSel: `drafts/${ic.name}` })} dangerouslySetInnerHTML={{ __html: iconSvg(drafts, ic, { size: 24 }) }} />
                    {canEdit() && <button className="btn btn-sm-inline" onClick={() => keep(base, ic)}>Keep</button>}
                  </div>
                ))}
              </div>
              {canEdit() && <button className="btn btn-sm-inline" onClick={() => void rdl(list.map((ic) => `icon drafts/${ic.name} none`).join('\n'), `discard ${base} drafts`)}>Discard all</button>}
            </div>
          ))}
        </section>
      )}
      {main.map((s) => (
        <section key={s.name} className="section">
          <h3 className="section-title">{s.name} · {Object.keys(s.icons).length} · grid {s.grid} · stroke {s.stroke}</h3>
          <div className="icon-grid">
            {Object.values(s.icons).filter(match).map((ic) => (
              <button key={ic.name} className={`icon-tile${sel === `${s.name}/${ic.name}` ? ' is-sel' : ''}`} title={ic.name} aria-label={ic.name} onClick={() => setState({ iconSel: `${s.name}/${ic.name}` })} dangerouslySetInnerHTML={{ __html: iconSvg(s, ic, { size: 24 }) }} />
            ))}
            {canEdit() && (
              <button className="icon-tile icon-new" title="New icon" aria-label={`New icon in ${s.name}`} onClick={() => { const n = uniqueName(s, 'new'); void rdl(`icon ${s.name}/${n}\n  circle 12 12 8.5`, 'new icon').then((r) => r && setState({ iconSel: `${s.name}/${n}` })); }}>+</button>
            )}
          </div>
          <div className="code-actions">
            <button className="btn btn-sm-inline" onClick={() => download(`${s.name}-sprite.svg`, iconSprite(s))}>Sprite</button>
            <button className="btn btn-sm-inline" onClick={() => download(`${s.name}.json`, JSON.stringify(s, null, 2), 'application/json')}>Export set</button>
            <button className="btn btn-sm-inline" title="TTF, WOFF and CSS for this set" onClick={() => void exportFont(s)}>Icon font</button>
          </div>
        </section>
      ))}
    </>
  );
}

// ------------------------------------------------------------------ library

const API = `${ASSET_PROXY}/icons`;
const getOk = async (url: string) => { const r = await fetch(url); if (!r.ok) throw new Error(r.status === 429 ? 'Too many requests. Try again in a moment.' : 'The online library could not be reached.'); return r; };
interface Coll { name: string; total: number; license?: { title: string }; palette?: boolean }

function IconLibrary({ sets }: { sets: Record<string, IconSet> }) {
  const main = Object.values(sets).filter((s) => s.name !== 'drafts');
  const [target, setTarget] = useState(main[0]?.name ?? 'ui');
  const [q, setQ] = useState('');
  const [coll, setColl] = useState('builtin');
  const [colls, setColls] = useState<Record<string, Coll>>({});
  const [names, setNames] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(120);
  const [offline, setOffline] = useState(false);
  const builtin = useMemo(() => packIconNames('lucide'), []);
  useEffect(() => { void getOk(`${API}/collections`).then((r) => r.json()).then(setColls).catch(() => setOffline(true)); }, []);
  useEffect(() => {
    setLimit(120);
    if (coll === 'builtin') { setNames([]); return; }
    let live = true;
    const t = window.setTimeout(async () => {
      setBusy(true);
      try {
        const url = q.trim() ? `${API}/search?query=${encodeURIComponent(q.trim())}&limit=240${coll !== 'all' ? `&prefix=${coll}` : ''}` : coll !== 'all' ? `${API}/collection?prefix=${coll}` : '';
        if (!url) { setNames([]); return; }
        const j = await (await getOk(url)).json();
        if (!live) return;
        if (q.trim()) setNames(j.icons ?? []);
        else {
          const all: string[] = [...(j.uncategorized ?? []), ...Object.values((j.categories ?? {}) as Record<string, string[]>).flat()];
          setNames([...new Set(all)].map((n) => `${coll}:${n}`));
        }
      } catch { setOffline(true); } finally { if (live) setBusy(false); }
    }, 250);
    return () => { live = false; window.clearTimeout(t); };
  }, [q, coll]);

  const shownBuiltin = coll === 'builtin' ? builtin.filter((n) => !q || n.includes(q.toLowerCase())).slice(0, limit) : [];
  const set = sets[target];
  const addRemote = async (full: string) => {
    const [prefix = '', name = ''] = full.split(':');
    try {
      const svg = await (await getOk(`${API}/svg/${prefix}/${name}.svg`)).text();
      const { src } = svgToIconSrc(svg, set?.grid ?? 24);
      const n = uniqueName(set, slug(name));
      if (await rdl(iconScript(`${target}/${n}`, src), `add ${name}`)) toast('info', `Added ${n} to ${target}`);
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Could not add that icon'); }
  };
  const addBuiltin = async (name: string) => {
    const found = findIcon(undefined, `lucide/${name}`);
    if (!found) return;
    const n = uniqueName(set, name);
    if (await rdl(iconScript(`${target}/${n}`, found.icon.src), `add ${name}`)) toast('info', `Added ${n} to ${target}`);
  };
  const sorted = Object.entries(colls).filter(([, c]) => !c.palette).sort((a, b) => b[1].total - a[1].total);
  const info = colls[coll];
  const total = Object.values(colls).reduce((a, c) => a + c.total, 0);
  return (
    <section className="section lib">
      <input className="input" placeholder="Search icons" aria-label="Search the icon library" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
      <Row label="Source">
        <select className="input" aria-label="Icon collection" value={coll} onChange={(e) => setColl(e.target.value)}>
          <option value="builtin">Built-in Lucide ({builtin.length.toLocaleString('en-US')}, works offline)</option>
          <option value="all">{total ? `All collections (${total.toLocaleString('en-US')})` : 'All collections'}</option>
          {sorted.map(([id, c]) => <option key={id} value={id}>{c.name} ({c.total.toLocaleString('en-US')})</option>)}
        </select>
      </Row>
      <Row label="Add to">
        <select className="input" aria-label="Add icons to set" value={target} onChange={(e) => setTarget(e.target.value)}>{main.map((s) => <option key={s.name}>{s.name}</option>)}</select>
      </Row>
      <p className="hint">{coll === 'builtin' ? 'Usable by name everywhere, e.g. icon:rocket. Click to copy one into your set to edit it.' : info?.license ? `${info.name} · ${info.license.title}. Check the licence before shipping.` : offline ? 'The online collections could not be reached. Built-in Lucide still works.' : 'Click an icon to add it to your set as editable shapes.'}</p>
      <div className="icon-grid lib-grid">
        {shownBuiltin.map((n) => { const f = findIcon(undefined, `lucide/${n}`)!; return <button key={n} className="icon-tile" title={n} aria-label={`Add ${n}`} onClick={() => void addBuiltin(n)} dangerouslySetInnerHTML={{ __html: iconSvg(f.set, f.icon, { size: 22 }) }} />; })}
        {coll !== 'builtin' && names.slice(0, limit).map((full) => {
          const [p, n] = full.split(':');
          return <button key={full} className="icon-tile" title={full} aria-label={`Add ${n}`} onClick={() => void addRemote(full)}><img loading="lazy" width={22} height={22} alt="" src={`${API}/svg/${p}/${n}.svg`} /></button>;
        })}
      </div>
      {busy && <p className="hint">Searching…</p>}
      {coll !== 'builtin' && !busy && !names.length && <p className="hint">{coll === 'all' ? 'Type to search every collection.' : 'Nothing found.'}</p>}
      {(coll === 'builtin' ? builtin.length : names.length) > limit && <button className="btn btn-sm-inline" onClick={() => setLimit(limit + 240)}>Show more</button>}
    </section>
  );
}

// ------------------------------------------------------------------ preview

function PixelPreview({ svg, px }: { svg: string; px: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const img = new Image();
    img.onload = () => { const ctx = c.getContext('2d'); if (!ctx) return; ctx.clearRect(0, 0, px, px); ctx.drawImage(img, 0, 0, px, px); };
    img.src = `data:image/svg+xml,${encodeURIComponent(svg.replace('currentColor', '#1c2026').replace(/currentColor/g, '#1c2026'))}`;
  }, [svg, px]);
  return <canvas ref={ref} width={px} height={px} className="pixel" title={`${px}px enlarged: how it really rasterises`} />;
}

function IconPreview({ set, icon }: { set: IconSet; icon: IconDef }) {
  const ctxRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ctxRef.current;
    const doc = getState().doc;
    if (!host || !doc) return;
    const copy = cloneDocument(doc);
    const ref = `${set.name}/${icon.name}`;
    if (copy.data.icons?.[set.name]) copy.data.icons[set.name]!.icons[icon.name] = icon;
    try {
      const r = applyRdl(copy, `Ctx row gap4 p3 center fill:surface r3\n  @Button variant=secondary size=sm "Run again"\n    Icon icon:${ref} w16 h16\n  @Button variant=primary size=sm "Start"\n    Icon icon:${ref} w16 h16\n  @Chip variant=info "Queued"\n    Icon icon:${ref} w12 h12\n  Line row gap2 center\n    Icon icon:${ref} w16 h16 color:text.secondary\n    Text body-sm "Checkout flow"`);
      const root = host.shadowRoot ?? host.attachShadow({ mode: 'open' });
      const only = cloneDocument(copy);
      only.page().children = [r.created[0]!];
      renderInto(root, only, '.stage{padding:0;gap:0}');
    } catch { /* invalid shapes: keep the last good preview */ }
  });
  const svg = iconSvg(set, icon, { size: 24 });
  return (
    <div className="vs-preview">
      {[16, 20, 24, 32, 48].map((s) => <span key={s} className="icon-size" title={`${s}px`} dangerouslySetInnerHTML={{ __html: iconSvg(set, icon, { size: s }) }} />)}
      <span className="icon-sizes-sep" />
      {[16, 24, 32].map((s) => <span key={s} className="icon-size is-dark" title={`${s}px on dark`} dangerouslySetInnerHTML={{ __html: iconSvg(set, icon, { size: s }) }} />)}
      <span className="icon-sizes-sep" />
      <PixelPreview svg={svg} px={16} /><PixelPreview svg={svg} px={24} />
      <span className="icon-sizes-sep" />
      <div className="icon-ctx" ref={ctxRef} />
    </div>
  );
}

// ------------------------------------------------------------------ right panel

const widths = (w: number, ...k: number[]) => k.map((x) => Math.round(w * x * 100) / 100).join(',');
const PROFILES: [string, (w: number) => string][] = [
  ['Taper end', (w) => widths(w, 1.4, 0.1)],
  ['Taper start', (w) => widths(w, 0.1, 1.4)],
  ['Taper both', (w) => widths(w, 0.1, 1.6, 0.1)],
  ['Brush', (w) => widths(w, 0.2, 1.6, 0.9, 1.3, 0.1)],
  ['Pinch', (w) => widths(w, 1.5, 0.4, 1.5)],
];

function Grad({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [angle = '135', a = '#f59e0b', b = '#ef4444'] = value ? value.split(',') : [];
  const write = (x: string, y: string, z: string) => onChange(`${x},${y},${z}`);
  return (
    <>
      <Row label="Gradient"><Toggle on={!!value} title="Paint this shape with a gradient" onClick={() => onChange(value ? '' : '135,#f59e0b,#ef4444')}>{value ? 'On' : 'Off'}</Toggle></Row>
      {value && <Row label="Colours"><div className="stop">
        <input type="color" aria-label="Gradient start" value={/^#[0-9a-f]{6}$/i.test(a) ? a : '#000000'} onChange={(e) => write(angle, e.target.value, b)} />
        <input type="color" aria-label="Gradient end" value={/^#[0-9a-f]{6}$/i.test(b) ? b : '#000000'} onChange={(e) => write(angle, a, e.target.value)} />
        <TextInput value={angle} label="Gradient angle" onCommit={(x) => /^-?\d+$/.test(x) && write(x, a, b)} />
      </div></Row>}
    </>
  );
}

/** TTF, WOFF and a stylesheet for a set. Fonts are single-colour, so strokes are outlined first. */
async function exportFont(set: IconSet) {
  try {
    const [{ paper, offset }, ttfMod, { toWoff }] = await Promise.all([loadPaper(), import('svg2ttf'), import('./woff')]);
    const svg2ttf = ttfMod.default ?? ttfMod;
    const units = 1000, k = units / set.grid;
    const glyphs: string[] = [], css: string[] = [];
    let code = 0xe000;
    for (const ic of Object.values(set.icons)) {
      const compiled = compileIcon(ic.src).shapes;
      let all: any = null;
      for (const s of compiled) {
        const item = new paper.CompoundPath({ pathData: s.d, insert: false });
        const parts = s.fill ? [item] : item.children.map((c: any) => offset.offsetStroke(c, (s.w ?? ic.stroke ?? set.stroke) / 2, { cap: set.cap === 'butt' ? 'butt' : 'round', join: set.join === 'bevel' ? 'bevel' : set.join === 'miter' ? 'miter' : 'round', insert: false }));
        for (const p of parts) all = all ? all.unite(p, { insert: false }) : p;
      }
      if (!all) continue;
      all.scale(k, -k, new paper.Point(0, 0));
      all.translate(new paper.Point(0, units));
      const hex = code.toString(16);
      glyphs.push(`<glyph glyph-name="${ic.name}" unicode="&#x${hex};" horiz-adv-x="${units}" d="${normalizePath(all.pathData)}"/>`);
      css.push(`.${set.name}-${ic.name}::before{content:"\\${hex}"}`);
      code++;
    }
    const svgFont = `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><defs><font id="${set.name}" horiz-adv-x="${units}"><font-face font-family="${set.name}" units-per-em="${units}" ascent="${units}" descent="0"/><missing-glyph horiz-adv-x="${units}"/>${glyphs.join('')}</font></defs></svg>`;
    const ttf = new Uint8Array(svg2ttf(svgFont, {}).buffer);
    const woff = toWoff(ttf);
    const save = (name: string, data: BlobPart, type: string) => { const u = URL.createObjectURL(new Blob([data], { type })); Object.assign(document.createElement('a'), { href: u, download: name }).click(); window.setTimeout(() => URL.revokeObjectURL(u), 5000); };
    save(`${set.name}.ttf`, ttf, 'font/ttf');
    save(`${set.name}.woff`, woff, 'font/woff');
    save(`${set.name}.css`, `@font-face{font-family:"${set.name}";src:url("${set.name}.woff") format("woff"),url("${set.name}.ttf") format("truetype");font-display:block}\n[class^="${set.name}-"]::before{font-family:"${set.name}";font-style:normal;font-weight:400;line-height:1}\n${css.join('\n')}\n`, 'text/css');
    toast('info', `Icon font made with ${glyphs.length} icons`);
  } catch (e) { toast('error', `Could not build the font: ${e instanceof Error ? e.message : e}`); }
}

function Ops({ title, items }: { title: string; items: [string, () => void, string?][] }) {
  return (
    <div className="ops">
      <span className="hint">{title}</span>
      <div className="ops-row">{items.map(([l, f, t]) => <button key={l} className="btn btn-sm-inline" title={t} onClick={f}>{l}</button>)}</div>
    </div>
  );
}

function IconPanel({ set, icon, v }: { set: IconSet; icon: IconDef; v: VState }) {
  const version = useEditor((s) => s.version);
  const ops = usePathOps(v, set, icon);
  const { lines, commit } = v;
  const sel = ops.sel;
  const ref = `${set.name}/${icon.name}`;
  const editable = canEdit();
  const first = sel.length === 1 ? lines[sel[0]!] : undefined;
  const [offset, setOffset] = useState('1');
  const [radius, setRadius] = useState('2');
  const [copies, setCopies] = useState('6');
  const [angle, setAngle] = useState('45');
  const setAll = (key: string, value: string | null) => commit(lines.map((l, i) => (sel.includes(i) ? setOpt(l, key, value) : l)), key);
  const parsed = first ? parseLine(first) : undefined;
  const box = sel.length ? bboxOf(sel.map((i) => lines[i]!)) : undefined;
  const resize = (key: 'x' | 'y' | 'w' | 'h', val: string) => {
    const n = Number(val);
    if (!box || !Number.isFinite(n)) return;
    const f = (x: number, y: number): [number, number] => {
      if (key === 'x') return [x + n - box.x0, y];
      if (key === 'y') return [x, y + n - box.y0];
      if (key === 'w') return [box.x0 + (x - box.x0) * (n / (box.w || 1)), y];
      return [x, box.y0 + (y - box.y0) * (n / (box.h || 1))];
    };
    commit(lines.map((l, i) => (sel.includes(i) ? mapLine(l, f) : l)), 'resize');
  };
  const trace = async (file?: File) => {
    if (!file) return;
    try {
      const mod: any = await import('imagetracerjs');
      const tracer = mod.default ?? mod;
      const img = await createImageBitmap(file);
      const c = document.createElement('canvas');
      const k = 256 / Math.max(img.width, img.height);
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      const svg: string = tracer.imagedataToSVG(ctx.getImageData(0, 0, c.width, c.height), { numberofcolors: 2, colorquantcycles: 1, pathomit: 16, ltres: 1, qtres: 1, blurradius: 2, scale: 1, roundcoords: 2, strokewidth: 0, viewbox: true });
      const paths = [...svg.matchAll(/<path[^>]*fill="rgb\((\d+),(\d+),(\d+)\)"[^>]*\sd="([^"]+)"/g)].filter((m) => Number(m[1]) + Number(m[2]) + Number(m[3]) < 380).map((m) => `<path d="${m[4]}" fill-rule="evenodd"/>`);
      const paths2 = paths.length ? paths : [...svg.matchAll(/<path[^>]*\sd="([^"]+)"[^>]*fill="rgb\((\d+),(\d+),(\d+)\)"/g)].filter((m) => Number(m[2]) + Number(m[3]) + Number(m[4]) < 380).map((m) => `<path d="${m[1]}" fill-rule="evenodd"/>`);
      const { src } = importSvgText(`<svg viewBox="0 0 ${c.width} ${c.height}">${paths2.join('')}</svg>`, set.grid);
      commit([...lines, ...src.split('\n').slice(1)], 'trace image');
    } catch (e) { toast('error', e instanceof Error ? e.message : 'Could not trace that image'); }
  };
  const pasteSvg = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const { src, warnings } = importSvgText(text, set.grid);
      commit([...lines, ...src.split('\n').slice(1)], 'paste SVG');
      if (warnings.length) toast('info', warnings.join('; '));
    } catch { toast('error', 'Copy some SVG markup first'); }
  };
  const png = async (size: number) => {
    const img = new Image();
    img.src = `data:image/svg+xml,${encodeURIComponent(iconSvg(set, icon, { size }).replace(/currentColor/g, '#000'))}`;
    await img.decode();
    const c = Object.assign(document.createElement('canvas'), { width: size, height: size });
    c.getContext('2d')!.drawImage(img, 0, 0);
    Object.assign(document.createElement('a'), { href: c.toDataURL('image/png'), download: `${icon.name}-${size}.png` }).click();
  };
  const copy = (text: string, msg: string) => void navigator.clipboard?.writeText(text).then(() => toast('info', msg));
  const inner = iconSvg(set, icon).replace(/^<svg[^>]*>|<\/svg>\s*$/g, '');
  const vue = `<template>\n  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 ${set.grid} ${set.grid}" fill="none" stroke="currentColor" stroke-width="${icon.stroke ?? set.stroke}" stroke-linecap="${set.cap}" stroke-linejoin="${set.join}">${inner}</svg>\n</template>\n<script setup>\ndefineProps({ size: { type: Number, default: 20 } })\n</script>\n`;
  const issues = lintIcons({ [set.name]: { ...set, icons: { ...set.icons, [icon.name]: { ...icon, src: `${/^\s*exact/.test(icon.src) ? 'exact\n' : ''}${lines.join('\n')}` } } } }, [ref]);
  return (
    <div className="props" data-v={version}>
      <div className="inspector-head">
        <div className="inspector-title">{icon.name}</div>
        <div className="inspector-sub">{set.name} · grid {set.grid} · {lines.length} shapes{sel.length ? ` · ${sel.length} selected` : ''}</div>
      </div>
      {sel.length > 0 && box && (
        <Section title="Selection">
          <Row label="X / Y"><div className="pair"><TextInput value={String(Math.round(box.x0 * 100) / 100)} label="X" onCommit={(x) => resize('x', x)} /><TextInput value={String(Math.round(box.y0 * 100) / 100)} label="Y" onCommit={(x) => resize('y', x)} /></div></Row>
          <Row label="W / H"><div className="pair"><TextInput value={String(Math.round(box.w * 100) / 100)} label="Width" onCommit={(x) => resize('w', x)} /><TextInput value={String(Math.round(box.h * 100) / 100)} label="Height" onCommit={(x) => resize('h', x)} /></div></Row>
          {parsed?.kind === 'rect' && <Row label="Corner"><TextInput value={getOpt(first!, 'r') ?? '0'} label="Corner radius" onCommit={(x) => setAll('r', x || null)} /></Row>}
          {parsed?.kind === 'star' && <Row label="Inner / points"><div className="pair"><TextInput value={parsed.args[3] ?? ''} label="Inner radius" onCommit={(x) => commit(lines.map((l, i) => (i === sel[0] ? ['star', ...parsed.args.slice(0, 3), x, ...parsed.args.slice(4), ...parsed.opts].join(' ') : l)), 'star')} /><TextInput value={parsed.args[4] ?? '5'} label="Star points" onCommit={(x) => commit(lines.map((l, i) => (i === sel[0] ? ['star', ...parsed.args.slice(0, 4), x, ...parsed.args.slice(5), ...parsed.opts].join(' ') : l)), 'star')} /></div></Row>}
          {parsed?.kind === 'ngon' && <Row label="Sides"><TextInput value={parsed.args[3] ?? '6'} label="Polygon sides" onCommit={(x) => commit(lines.map((l, i) => (i === sel[0] ? ['ngon', ...parsed.args.slice(0, 3), x, ...parsed.args.slice(4), ...parsed.opts].join(' ') : l)), 'polygon')} /></Row>}
          <Row label="Paint"><Segmented value={first && getOpt(first, 'fill') === 'true' ? 'fill' : 'stroke'} options={['stroke', 'fill']} labels={{ stroke: 'Stroke', fill: 'Fill' }} onChange={(x) => setAll('fill', x === 'fill' ? 'true' : null)} /></Row>
          <Row label="Stroke"><TextInput value={first ? getOpt(first, 'w') ?? '' : ''} placeholder={String(icon.stroke ?? set.stroke)} label="Shape stroke width" onCommit={(x) => setAll('w', x || null)} /></Row>
          <Row label="Width"><select className="input" aria-label="Width profile" value={first ? getOpt(first, 'vw') ?? '' : ''} onChange={(e) => setAll('vw', e.target.value || null)}>
            <option value="">Uniform</option>
            {PROFILES.map(([l, f]) => <option key={l} value={f(icon.stroke ?? set.stroke)}>{l}</option>)}
            {first && getOpt(first, 'vw') && !PROFILES.some(([, f]) => f(icon.stroke ?? set.stroke) === getOpt(first, 'vw')) && <option value={getOpt(first, 'vw')}>Custom ({getOpt(first, 'vw')})</option>}
          </select></Row>
          <Row label="Symmetry"><div className="stop"><select className="input" aria-label="Shape symmetry" value={first ? getOpt(first, 'sym') ?? '' : ''} onChange={(e) => setAll('sym', e.target.value || null)}>
            <option value="">Off</option><option value={`h${set.grid / 2}`}>Left-right</option><option value={`v${set.grid / 2}`}>Top-bottom</option><option value={`hv${set.grid / 2}`}>Both</option><option value={`r4c${set.grid / 2}`}>Radial 4</option><option value={`r6c${set.grid / 2}`}>Radial 6</option><option value={`r8c${set.grid / 2}`}>Radial 8</option>
          </select><button className="btn btn-sm-inline" title="Turn live copies and width profiles into ordinary paths" onClick={ops.bake}>Bake</button></div></Row>
          <Row label="Dash"><TextInput value={first ? getOpt(first, 'dash') ?? '' : ''} placeholder="2,2" label="Dash pattern" onCommit={(x) => setAll('dash', x || null)} /></Row>
          <Row label="Opacity"><TextInput value={first ? getOpt(first, 'o') ?? '' : ''} placeholder="1" label="Shape opacity" onCommit={(x) => setAll('o', x || null)} /></Row>
          <Row label="Colour"><TextInput value={first ? getOpt(first, 'c') ?? '' : ''} placeholder="currentColor" label="Shape colour" onCommit={(x) => setAll('c', x || null)} /></Row>
          <Grad value={first ? getOpt(first, 'grad') ?? '' : ''} onChange={(x) => setAll('grad', x || null)} />
          <Row label="Holes"><Toggle on={!!first && getOpt(first, 'rule') === 'evenodd'} title="Even-odd fill rule" onClick={() => setAll('rule', first && getOpt(first, 'rule') === 'evenodd' ? null : 'evenodd')}>Even-odd</Toggle></Row>
        </Section>
      )}
      <Section title="Combine">
        <Ops title="Boolean" items={[['Union', () => ops.boolean('unite')], ['Subtract', () => ops.boolean('subtract')], ['Intersect', () => ops.boolean('intersect')], ['Exclude', () => ops.boolean('exclude')], ['Divide', () => ops.boolean('divide')]]} />
        <Ops title="Paths" items={[['Combine', ops.combine], ['Break apart', ops.breakApart], ['Join', ops.join], ['Close', ops.closePath], ['To path', ops.toPaths]]} />
      </Section>
      <Section title="Shape">
        <Ops title="Stroke & outline" items={[['Outline stroke', ops.outline, 'Turn strokes into filled shapes']]} />
        <Row label="Offset"><div className="stop"><TextInput value={offset} label="Offset distance" onCommit={setOffset} /><button className="btn btn-sm-inline" onClick={() => ops.offsetPath(Number(offset) || 0)}>Grow</button><button className="btn btn-sm-inline" onClick={() => ops.offsetPath(-(Number(offset) || 0))}>Shrink</button></div></Row>
        <Row label="Round"><div className="stop"><TextInput value={radius} label="Corner radius for points" onCommit={setRadius} /><button className="btn btn-sm-inline" onClick={() => ops.roundCorners(Number(radius) || 0)}>Round corners</button></div></Row>
        <Ops title="Curves" items={[['Simplify', ops.simplify, 'Fewer points, same shape'], ['Smooth', ops.smooth], ['Flatten', ops.flatten, 'Curves to straight lines'], ['Reverse', ops.reverse]]} />
      </Section>
      <Section title="Transform">
        <Ops title="Flip & rotate" items={[['Flip H', () => ops.flip('h')], ['Flip V', () => ops.flip('v')], ['−90°', () => ops.rotate(-90)], ['+90°', () => ops.rotate(90)], ['Skew 15°', () => ops.skew(15)]]} />
        <Row label="Rotate"><div className="stop"><TextInput value={angle} label="Rotation angle" onCommit={setAngle} /><button className="btn btn-sm-inline" onClick={() => ops.rotate(Number(angle) || 0)}>Apply</button></div></Row>
        <Ops title="Align to grid, or to each other" items={[['Left', () => ops.alignTo('left')], ['Centre', () => ops.alignTo('hcenter')], ['Right', () => ops.alignTo('right')], ['Top', () => ops.alignTo('top')], ['Middle', () => ops.alignTo('vcenter')], ['Bottom', () => ops.alignTo('bottom')]]} />
        <Ops title="Distribute" items={[['Across', () => ops.distribute('x')], ['Down', () => ops.distribute('y')]]} />
        <Ops title="Repeat" items={[['Mirror H', () => ops.mirror('h')], ['Mirror V', () => ops.mirror('v')]]} />
        <Row label="Copies"><div className="stop"><TextInput value={copies} label="Rotated copies" onCommit={setCopies} /><button className="btn btn-sm-inline" onClick={() => ops.rotateCopies(Number(copies) || 0)}>Around centre</button></div></Row>
      </Section>
      <Section title="Style">
        <Ops title="Whole icon" items={[['Make solid', ops.toSolid], ['Duotone', ops.duotone, 'Adds a soft filled copy of the selection']]} />
        {editable && <Row label="Set stroke"><TextInput value={String(set.stroke)} label="Stroke for the whole set" onCommit={(x) => { if (Number(x) > 0) void rdl(`iconset ${set.name} stroke${x}`, `set stroke ${x}`); }} /></Row>}
        {editable && <Row label="Line ends"><Segmented value={set.cap} options={['round', 'butt', 'square']} labels={{ round: 'Round', butt: 'Flat', square: 'Square' }} onChange={(x) => void rdl(`iconset ${set.name} ${x}`, `set caps ${x}`)} /></Row>}
      </Section>
      {editable && (
        <Section title="Bring in art">
          <div className="btn-row">
            <button className="btn btn-sm-inline" onClick={() => void pasteSvg()}>Paste SVG</button>
            <label className="btn btn-sm-inline">Trace an image<input type="file" hidden accept="image/*" aria-label="Trace an image" onChange={(e) => void trace(e.target.files?.[0])} /></label>
          </div>
        </Section>
      )}
      <Source set={set} icon={icon} />
      <Section title="Checks">
        {!issues.length && <p className="hint">Consistent with the set.</p>}
        {issues.map((i, k) => <div key={k} className="lint-row"><span className={`sev sev-${i.severity}`}>{i.severity}</span><span>{i.message}</span></div>)}
      </Section>
      {editable && set.name !== 'drafts' && <Manage set={set} icon={icon} />}
      <Section title="Export">
        <div className="chips">
          <button className="chip-btn" onClick={() => download(`${icon.name}.svg`, iconSvg(set, icon) + '\n')}>SVG</button>
          {[16, 24, 48, 96, 256, 512].map((s) => <button key={s} className="chip-btn" onClick={() => void png(s)}>PNG {s}</button>)}
          <button className="chip-btn" onClick={() => copy(iconSvg(set, icon), 'SVG copied')}>Copy SVG</button>
          <button className="chip-btn" onClick={() => copy(iconReact(set, icon), 'React component copied')}>Copy React</button>
          <button className="chip-btn" onClick={() => copy(vue, 'Vue component copied')}>Copy Vue</button>
          <button className="chip-btn" onClick={() => copy(`url("data:image/svg+xml,${encodeURIComponent(iconSvg(set, icon))}")`, 'CSS data URI copied')}>Copy CSS</button>
          <button className="chip-btn" onClick={() => copy(`Icon icon:${set.name}/${icon.name} w16 h16`, 'RDL copied')}>Copy RDL</button>
        </div>
      </Section>
    </div>
  );
}

function Source({ set, icon }: { set: IconSet; icon: IconDef }) {
  const version = useEditor((s) => s.version);
  const [draft, setDraft] = useState(icon.src);
  useEffect(() => setDraft(icon.src), [icon.src, version]);
  const diag: Diagnostic[] = [];
  compileIcon(draft, diag);
  const dirty = draft !== icon.src;
  const apply = () => void rdl(iconScript(`${set.name}/${icon.name}`, draft, icon.stroke), `edit icon ${icon.name}`);
  return (
    <Section title="Shape text" collapsed>
      <textarea className="code code-sm" rows={8} spellCheck={false} aria-label="Icon shapes as text" value={draft} readOnly={!canEdit()} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && dirty && !diag.length) apply(); e.stopPropagation(); }} />
      {diag.length > 0 && <p className="cs-conflict">{diag.map((d) => `line ${d.line}: ${d.message}`).join('\n')}</p>}
      {canEdit() && <div className="code-actions"><span className="hint" style={{ flex: 1 }}>The same text an agent writes</span><button className="btn btn-primary" disabled={!dirty || diag.length > 0} onClick={apply}>Apply</button></div>}
    </Section>
  );
}

function Manage({ set, icon }: { set: IconSet; icon: IconDef }) {
  const [name, setName] = useState(icon.name);
  useEffect(() => setName(icon.name), [icon.name]);
  const ref = `${set.name}/${icon.name}`;
  const tags = (icon.tags ?? []).join(',');
  const others = Object.values(getState().doc?.data.icons ?? {}).filter((s) => s.name !== set.name && s.name !== 'drafts');
  return (
    <Section title="Organise" collapsed>
      <div className="brand-row">
        <input className="input" value={name} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, '-'))} onKeyDown={(e) => e.stopPropagation()} aria-label="Icon name" />
        <button className="btn" disabled={!name || name === icon.name || !!set.icons[name]} onClick={() => void rdl(`${iconScript(`${set.name}/${name}`, icon.src, icon.stroke)}\nicon ${ref} none`, `rename ${ref}`).then((r) => r && setState({ iconSel: `${set.name}/${name}` }))}>Rename</button>
      </div>
      <Row label="Tags"><TextInput value={tags} placeholder="arrow, navigation" label="Icon tags" onCommit={(x) => void rdl(`icon ${ref}${icon.stroke ? ` stroke${icon.stroke}` : ''}${x ? ` tags=${x.replace(/\s+/g, '')}` : ''}\n${indent(icon.src)}`, 'tags')} /></Row>
      <div className="btn-row">
        <button className="btn btn-sm-inline" onClick={() => { const n = uniqueName(set, `${icon.name}-copy`); void rdl(iconScript(`${set.name}/${n}`, icon.src, icon.stroke), 'duplicate').then((r) => r && setState({ iconSel: `${set.name}/${n}` })); }}>Duplicate</button>
        {others.map((o) => <button key={o.name} className="btn btn-sm-inline" onClick={() => void rdl(`${iconScript(`${o.name}/${uniqueName(o, icon.name)}`, icon.src, icon.stroke)}\nicon ${ref} none`, `move to ${o.name}`).then((r) => r && setState({ iconSel: null }))}>Move to {o.name}</button>)}
        <button className="btn btn-sm-inline" onClick={() => void rdl(`icon ${ref} none`, `delete icon ${ref}`).then((r) => r && setState({ iconSel: null }))}>Delete</button>
      </div>
    </Section>
  );
}
