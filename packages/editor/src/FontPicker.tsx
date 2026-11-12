import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FONT_PAIRS, allFonts, findFont, proxiedFontPreviewUrl, proxiedFontUrl, type CatalogFont } from '@rangoli/engine';
import { getState, rdl, toast, useEditor } from './store';

const RECENT = 'rangoli.recentFonts';
const recentFonts = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[]; } catch { return []; } };
const remember = (f: string) => { try { localStorage.setItem(RECENT, JSON.stringify([f, ...recentFonts().filter((x) => x !== f)].slice(0, 12))); } catch { /* private window */ } };

// Previews load only the letters of each name, under a private family name, so a preview can never
// stand in for the real font on the canvas.
const previewed = new Set<string>();
function previewFamily(f: CatalogFont): string {
  if (f.source !== 'google') return f.family;
  const alias = `rp-${f.family.replace(/[^\w]/g, '-')}`;
  if (!previewed.has(f.family)) {
    previewed.add(f.family);
    void fetch(proxiedFontPreviewUrl(f.family)).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); }).then((css) => {
      const style = document.createElement('style');
      style.textContent = css.replace(/font-family:\s*'[^']+'/g, `font-family:'${alias}'`);
      document.head.appendChild(style);
    }).catch(() => window.setTimeout(() => previewed.delete(f.family), 30_000)); // not on every render: the list redraws as it scrolls
  }
  return alias;
}

const CHIPS: [string, string][] = [['all', 'All'], ['recent', 'Recent'], ['mine', 'Mine'], ['sans', 'Sans'], ['serif', 'Serif'], ['display', 'Display'], ['handwriting', 'Script'], ['mono', 'Mono'], ['system', 'System']];
const ROW = 40;
const TOKENS: [string, string][] = [['sans', 'Body'], ['display', 'Heading'], ['mono', 'Code']];

/** Hovering a font loads the whole face for the sample line (the list itself only loads each name). */
const loadedFull = new Set<string>();
function loadFull(f: CatalogFont) {
  if (f.source !== 'google' || loadedFull.has(f.family)) return;
  loadedFull.add(f.family);
  const url = proxiedFontUrl([f.family]);
  if (!url) return;
  const l = document.createElement('link');
  l.rel = 'stylesheet'; l.href = url;
  document.head.appendChild(l);
}

function FontPopover({ anchor, value, onPick, onClose, tokens: showTokens }: { anchor: DOMRect; value: string; onPick: (v: string) => void; onClose: () => void; tokens: boolean }) {
  useEditor((s) => s.version);
  const doc = getState().doc!;
  const fonts = useMemo(() => allFonts(doc.data.tokens), [doc, doc.data.tokens]);
  const [q, setQ] = useState('');
  const [chip, setChip] = useState('all');
  const [top, setTop] = useState(0);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [sample, setSample] = useState('Handgloves 0123');
  const [hover, setHover] = useState<string>(value);
  const ref = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const edge = document.querySelector('.right')?.getBoundingClientRect().left ?? anchor.left;
    el.style.left = `${Math.max(8, Math.min(edge, anchor.left) - el.offsetWidth - 8)}px`;
    el.style.top = `${Math.max(8, Math.min(window.innerHeight - el.offsetHeight - 8, anchor.top - 12))}px`;
  });
  useEffect(() => {
    const off = (e: PointerEvent) => { if (ref.current && !e.composedPath().includes(ref.current)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = window.setTimeout(() => window.addEventListener('pointerdown', off), 0);
    window.addEventListener('keydown', key, true);
    return () => { window.clearTimeout(t); window.removeEventListener('pointerdown', off); window.removeEventListener('keydown', key, true); };
  }, [onClose]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    let out = fonts;
    if (chip === 'recent') out = recentFonts().map((n) => fonts.find((f) => f.family === n)).filter((f): f is CatalogFont => !!f);
    else if (chip === 'mine') out = fonts.filter((f) => f.source === 'custom');
    else if (chip === 'system') out = fonts.filter((f) => f.source === 'system');
    else if (chip !== 'all') out = fonts.filter((f) => f.category === chip && f.source !== 'custom');
    return s ? out.filter((f) => f.family.toLowerCase().includes(s)) : out;
  }, [fonts, q, chip]);

  const pick = (family: string) => { remember(family); onPick(family); onClose(); };
  const addFont = async (family: string, src: string) => {
    const ok = await rdl(`fontface ${JSON.stringify(family)} ${src.startsWith('data:') ? 'data' : 'url'}=${src}`, `add font ${family}`);
    if (ok) { setAdding(false); setName(''); setUrl(''); pick(family); }
  };
  const upload = (f: File | undefined) => {
    if (!f) return;
    const ext = /\.(woff2|woff|ttf|otf)$/i.exec(f.name)?.[1]?.toLowerCase();
    if (!ext) return toast('error', 'Use a .woff2, .woff, .ttf or .otf font file');
    if (f.size > 1_400_000) return toast('error', 'That font is over 1.4 MB. Use a .woff2 version, or add it by URL.');
    const reader = new FileReader();
    reader.onload = () => {
      const b64 = String(reader.result).split(',')[1] ?? '';
      void addFont(name.trim() || f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/[^\w ']/g, ''), `data:font/${ext};base64,${b64}`);
    };
    reader.readAsDataURL(f);
  };

  const height = 300;
  const start = Math.max(0, Math.floor(top / ROW) - 2);
  const visible = list.slice(start, start + Math.ceil(height / ROW) + 4);
  const suggested = FONT_PAIRS.find(([d, b]) => d === value || b === value);

  return createPortal(
    <div className="fp" ref={ref} role="dialog" aria-label="Font picker" onKeyDown={(e) => e.stopPropagation()}>
      <input className="input" autoFocus placeholder={`Search ${fonts.length.toLocaleString('en-US')} fonts`} aria-label="Search fonts" value={q} onChange={(e) => { setQ(e.target.value); setTop(0); }} />
      <div className="fp-chips">{CHIPS.map(([k, l]) => <button key={k} className="tog fp-chip" aria-pressed={chip === k} onClick={() => { setChip(k); setTop(0); }}>{l}</button>)}</div>
      <input className="fp-sample" style={{ fontFamily: `'${hover}', sans-serif` }} aria-label="Sample text" title="Type your own sample" value={sample} onChange={(e) => setSample(e.target.value)} />
      {showTokens && !q && chip === 'all' && (
        <div className="fp-tokens"><span className="hint">Use this document's</span>{TOKENS.map(([k, l]) => <button key={k} className="fp-token" aria-pressed={value === k} onClick={() => { onPick(k); onClose(); }}>{l}</button>)}<span className="hint">font</span></div>
      )}
      <div className="fp-list" style={{ height }} role="listbox" aria-label="Fonts" onScroll={(e) => setTop(e.currentTarget.scrollTop)}>
        <div style={{ height: list.length * ROW, position: 'relative' }}>
          {visible.map((f, i) => (
            <button key={f.family} role="option" aria-selected={f.family === value} className="fp-row" style={{ top: (start + i) * ROW }} onMouseEnter={() => { loadFull(f); setHover(f.family); }} onFocus={() => { loadFull(f); setHover(f.family); }} onClick={() => pick(f.family)}>
              <span className="fp-name" style={{ fontFamily: `'${previewFamily(f)}', ${f.category === 'serif' ? 'serif' : f.category === 'mono' ? 'monospace' : 'sans-serif'}` }}>{f.family}</span>
              <span className="fp-meta">{f.source === 'custom' ? 'Added' : f.variable ? 'Variable' : `${f.weights.length} wt`}</span>
            </button>
          ))}
        </div>
        {!list.length && <p className="hint fp-empty">{chip === 'mine' ? 'Fonts you add will appear here.' : `No fonts match “${q}”.`}</p>}
      </div>
      {suggested && <button className="fp-pair" onClick={() => pick(suggested[0] === value ? suggested[1] : suggested[0])}>Pairs well with <b>{suggested[0] === value ? suggested[1] : suggested[0]}</b></button>}
      {!adding && <button className="btn btn-sm-inline fp-addbtn" onClick={() => setAdding(true)}>Add your own font: upload or URL</button>}
      {adding && (
        <div className="fp-add">
          <input className="input" placeholder="Font name" aria-label="Font name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="input" placeholder="https://…/font.woff2" aria-label="Font URL" value={url} onChange={(e) => setUrl(e.target.value)} />
          <div className="btn-row">
            <button className="btn btn-primary" disabled={!name.trim() || !url.startsWith('https://')} onClick={() => void addFont(name.trim(), url.trim())}>Add from URL</button>
            <button className="btn btn-sm-inline" onClick={() => file.current?.click()}>Upload file</button>
            <input ref={file} type="file" hidden accept=".woff2,.woff,.ttf,.otf" aria-label="Upload a font file" onChange={(e) => upload(e.target.files?.[0])} />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}

/** Font field: shows the current font in itself; opens the searchable picker. */
export function FontField({ value, placeholder, onPick, tokens = true, label }: { value: string; placeholder?: string; onPick: (v: string) => void; tokens?: boolean; label?: string }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const known = value ? findFont(value) : undefined;
  return (
    <>
      <button ref={trigger} className="input font-field" aria-haspopup="dialog" aria-label={label ?? 'Font family'} style={known ? { fontFamily: `'${previewFamily(known)}', sans-serif` } : undefined}
        onClick={(e) => setAnchor(e.currentTarget.getBoundingClientRect())}>
        <span className={value ? '' : 'font-ph'}>{value || placeholder || 'Choose a font'}</span><span aria-hidden>▾</span>
      </button>
      {value && <button className="btn btn-icon" aria-label="Clear font" onClick={() => onPick('')}>×</button>}
      {anchor && <FontPopover anchor={anchor} value={value} tokens={tokens} onPick={onPick} onClose={() => { setAnchor(null); trigger.current?.focus(); }} />}
    </>
  );
}
