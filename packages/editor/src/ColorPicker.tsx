import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { canvasElement } from './retained';
import { createPortal } from 'react-dom';
import { contrastRatio, generateRamp, hexToRgb, oklchToHex, rgbToHex, rgbToOklch, TokenResolver } from '@rangoli/engine';
import type { Opt } from './helpers';
import { getState, rdl } from './store';

// ------------------------------------------------------------------ colour maths

type HSV = { h: number; s: number; v: number };
function hsvToHex({ h, s, v }: HSV): string {
  const f = (n: number) => { const k = (n + h / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return rgbToHex({ r: f(5), g: f(3), b: f(1) });
}
function hexToHsv(hex: string): HSV {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: max ? d / max : 0, v: max };
}
function hexToHsl(hex: string) {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  const h = !d ? 0 : max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: h * 60, s: d ? d / (1 - Math.abs(2 * l - 1)) : 0, l };
}
function hslToHex(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return rgbToHex({ r: f(0), g: f(8), b: f(4) });
}
const harmonies = (hex: string): [string, string[]][] => {
  const { h, s, l } = hexToHsl(hex);
  const at = (d: number) => hslToHex((h + d + 360) % 360, s, l);
  return [
    ['Complementary', [hex, at(180)]],
    ['Analogous', [at(-30), hex, at(30)]],
    ['Triadic', [hex, at(120), at(240)]],
    ['Split', [hex, at(150), at(210)]],
    ['Shades', [0.25, 0.4, 0.55, 0.7, 0.85].map((x) => hslToHex(h, s, x))],
  ];
};

const HUES: [string, string][] = [['Red', '#e5383b'], ['Coral', '#f26a4f'], ['Orange', '#f08c00'], ['Amber', '#f5a800'], ['Yellow', '#e6c700'], ['Lime', '#82c91e'], ['Green', '#2f9e44'], ['Emerald', '#0ca678'], ['Teal', '#0d9488'], ['Cyan', '#0891b2'], ['Sky', '#0ea5e9'], ['Blue', '#2563eb'], ['Indigo', '#4f46e5'], ['Violet', '#7c3aed'], ['Purple', '#9333ea'], ['Fuchsia', '#c026d3'], ['Pink', '#db2777'], ['Rose', '#e11d48'], ['Brown', '#8b5a2b'], ['Taupe', '#857568'], ['Olive', '#7a7a2e'], ['Slate', '#64748b'], ['Gray', '#6b7280'], ['Stone', '#78716c']];
const STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const NAMED = 'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 darkgreen:006400 darkkhaki:bdb76b darkmagenta:8b008b darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b darkslategray:2f4f4f darkturquoise:00ced1 darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 lightgreen:90ee90 lightpink:ffb6c1 lightsalmon:ffa07a lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 limegreen:32cd32 linen:faf0e6 maroon:800000 mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 yellowgreen:9acd32'.split(' ').map((x) => { const [n = '', h = ''] = x.split(':'); return [n, `#${h}`] as const; });

const RECENT_KEY = 'rangoli.recentColors';
const loadRecent = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]') as string[]; } catch { return []; } };
const pushRecent = (hex: string) => { try { localStorage.setItem(RECENT_KEY, JSON.stringify([hex, ...loadRecent().filter((c) => c !== hex)].slice(0, 16))); } catch { /* private window */ } };

/** Parse a field value ("primary.600~40", "#ff0000~50") into a colour and alpha for the picker. */
function parseValue(value: string, swatch?: string): { hex: string; alpha: number; token?: string } {
  const m = /^(.*?)~(\d{1,3})$/.exec(value);
  const base = m ? m[1]! : value, alpha = m ? Number(m[2]) : 100;
  if (/^#[0-9a-f]{6}$/i.test(base)) return { hex: base.toLowerCase(), alpha };
  // nothing set yet: start from the document's accent rather than an arbitrary grey
  const accent = new TokenResolver(getState().doc!.data.tokens).resolve('color.action.primary', getState().mode) as string;
  return { hex: swatch && /^#[0-9a-f]{6}$/i.test(swatch) ? swatch : accent, alpha, ...(base && base !== 'none' ? { token: base } : {}) };
}

function useDrag(onMove: (x: number, y: number) => void, onEnd: () => void) {
  return (e: React.PointerEvent<HTMLElement>) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect();
      onMove(Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (ev.clientY - r.top) / r.height)));
    };
    at(e);
    const mv = (ev: PointerEvent) => at(ev);
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); onEnd(); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };
}

type Tab = 'custom' | 'tokens' | 'library' | 'mine';

/** Paint the selected layer directly while dragging; the one real edit happens on release. */
function previewOnCanvas(prop: string | undefined, css: string) {
  const id = getState().selection[0];
  const el = id ? canvasElement(id) : null;
  if (!prop || !el) return;
  if (prop === 'outline') { el.style.outline = `2px solid ${css}`; el.style.outlineOffset = '-2px'; } // the border preview
  else el.style.setProperty(prop, css);
}

export function ColorPopover({ anchor, value, swatch, options, allowNone, onCommit, onClose, live }: { anchor: DOMRect; value: string; swatch?: string; options: Opt[]; allowNone?: boolean; onCommit: (v: string) => void; onClose: () => void; live?: string }) {
  const init = useMemo(() => parseValue(value, swatch), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [hsv, setHsv] = useState<HSV>(() => hexToHsv(init.hex));
  const [alpha, setAlpha] = useState(init.alpha);
  const [tab, setTab] = useState<Tab>(init.token ? 'tokens' : 'custom');
  const [q, setQ] = useState('');
  const [fmt, setFmt] = useState<'HEX' | 'RGB' | 'HSL' | 'OKLCH'>('HEX');
  const [saving, setSaving] = useState('');
  const [paste, setPaste] = useState('');
  const [showHarmony, setShowHarmony] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const hex = hsvToHex(hsv);
  const state = useRef({ hex, alpha });
  state.current = { hex, alpha };
  const dragging = useRef(false);
  useEffect(() => { if (dragging.current) previewOnCanvas(live, `color-mix(in srgb, ${hex} ${alpha}%, transparent)`); }, [hex, alpha, live]);

  const output = (h: string, a = state.current.alpha) => (a < 100 ? `${h}~${a}` : h);
  const apply = (h = state.current.hex, a = state.current.alpha) => { pushRecent(h); onCommit(output(h, a)); };
  const pickHex = (h: string) => { setHsv(hexToHsv(h)); apply(h); };

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const pad = 8, w = el.offsetWidth, h = el.offsetHeight;
    // beside the inspector, so the fields being edited stay visible
    const edge = document.querySelector('.right')?.getBoundingClientRect().left ?? anchor.left;
    el.style.left = `${Math.max(pad, edge - w - 8)}px`;
    el.style.top = `${Math.max(pad, Math.min(window.innerHeight - h - pad, anchor.top - 12))}px`;
  });
  useEffect(() => {
    const off = (e: PointerEvent) => { if (ref.current && !e.composedPath().includes(ref.current)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const t = window.setTimeout(() => window.addEventListener('pointerdown', off), 0);
    window.addEventListener('keydown', key, true);
    return () => { window.clearTimeout(t); window.removeEventListener('pointerdown', off); window.removeEventListener('keydown', key, true); };
  }, [onClose]);

  const end = () => { dragging.current = false; apply(); };
  const drag = useDrag((x, y) => { dragging.current = true; setHsv((c) => ({ ...c, s: x, v: 1 - y })); }, end);
  const dragHue = useDrag((x) => { dragging.current = true; setHsv((c) => ({ ...c, h: x * 359.9 })); }, end);
  const dragAlpha = useDrag((x) => { dragging.current = true; setAlpha(Math.round(x * 100)); }, end);

  const doc = getState().doc!;
  const mode = getState().mode;
  const r = new TokenResolver(doc.data.tokens);
  const surface = r.resolve('color.bg.surface', mode) as string;
  const cr = contrastRatio(hex, surface);
  const crText = cr >= 7 ? 'AAA' : cr >= 4.5 ? 'AA' : cr >= 3 ? 'AA large' : 'Low';
  const mine = r.group('color.custom').map((t) => ({ path: t.path, name: t.path.split('.').slice(2).join('.'), hex: r.resolve(t.path, mode) as string }));
  const ramps = useMemo(() => HUES.map(([n, seed]) => [n, generateRamp(seed)] as const), []);
  const filter = (s: string) => !q || s.toLowerCase().includes(q.toLowerCase());
  const recent = loadRecent();

  const rgb = hexToRgb(hex);
  const hsl = hexToHsl(hex);
  const ok = rgbToOklch(rgb);
  const fields: Record<typeof fmt, { label: string; value: number; set: (n: number) => string | undefined }[]> = {
    HEX: [],
    RGB: (['r', 'g', 'b'] as const).map((k) => ({ label: k.toUpperCase(), value: Math.round(rgb[k] * 255), set: (n) => rgbToHex({ ...rgb, [k]: Math.min(255, Math.max(0, n)) / 255 }) })),
    HSL: [
      { label: 'H', value: Math.round(hsl.h), set: (n) => hslToHex(n, hsl.s, hsl.l) },
      { label: 'S', value: Math.round(hsl.s * 100), set: (n) => hslToHex(hsl.h, n / 100, hsl.l) },
      { label: 'L', value: Math.round(hsl.l * 100), set: (n) => hslToHex(hsl.h, hsl.s, n / 100) },
    ],
    OKLCH: [
      { label: 'L', value: Math.round(ok.l * 100), set: (n) => oklchToHex({ ...ok, l: n / 100 }) },
      { label: 'C', value: Math.round(ok.c * 1000) / 1000, set: (n) => oklchToHex({ ...ok, c: n }) },
      { label: 'H', value: Math.round(ok.h), set: (n) => oklchToHex({ ...ok, h: n }) },
    ],
  };
  const dropper = (window as unknown as { EyeDropper?: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper;
  const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const save = async () => { const s = slug(saving); if (!s) return; await rdl(`token color.custom.${s} ${hex}`, `add colour ${s}`); setSaving(''); };
  const importColors = async () => {
    const found = [...new Set(paste.match(/#[0-9a-f]{6}\b/gi) ?? [])].map((c) => c.toLowerCase());
    if (!found.length) return;
    await rdl(found.map((c) => `token color.custom.${c.slice(1)} ${c}`).join('\n'), `add ${found.length} colours`);
    setPaste('');
  };
  const Swatch = ({ c, title, onPick }: { c: string; title: string; onPick: () => void }) => <button className="cp-sw" style={{ background: c }} title={title} aria-label={title} onClick={onPick} />;

  return createPortal(
    <div className="cp" ref={ref} role="dialog" aria-label="Colour picker" onKeyDown={(e) => e.stopPropagation()}>
      <div className="cp-tabs" role="tablist">
        {([['custom', 'Custom'], ['tokens', 'Tokens'], ['library', 'Library'], ['mine', 'Saved']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className="cp-tab" onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'custom' && (
        <div className="cp-body">
          <div className="cp-sv" style={{ background: `linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${hsv.h} 100% 50%))` }} onPointerDown={drag} role="slider" aria-label="Saturation and brightness" aria-valuenow={Math.round(hsv.s * 100)}>
            <i style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: hex }} />
          </div>
          <div className="cp-sliders">
            <div className="cp-sl-col">
              <div className="cp-hue" onPointerDown={dragHue} role="slider" aria-label="Hue" aria-valuenow={Math.round(hsv.h)}><i style={{ left: `${(hsv.h / 360) * 100}%`, background: `hsl(${hsv.h} 100% 50%)` }} /></div>
              <div className="cp-alpha" style={{ '--c': hex } as React.CSSProperties} onPointerDown={dragAlpha} role="slider" aria-label="Opacity" aria-valuenow={alpha}><i style={{ left: `${alpha}%` }} /></div>
            </div>
            <span className="cp-big" style={{ background: `color-mix(in srgb, ${hex} ${alpha}%, transparent)` }} />
            {dropper && <button className="btn btn-icon" title="Pick a colour from the screen" aria-label="Pick a colour from the screen" onClick={() => void new dropper().open().then((c) => pickHex(c.sRGBHex)).catch(() => {})}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden><path d="M14 6l4 4M5 19l1-4 9-9 3 3-9 9zM16 4l4 4" /></svg>
            </button>}
          </div>
          <div className="cp-fields">
            <select className="input cp-fmt" value={fmt} aria-label="Colour format" onChange={(e) => setFmt(e.target.value as typeof fmt)}>{(['HEX', 'RGB', 'HSL', 'OKLCH'] as const).map((x) => <option key={x}>{x}</option>)}</select>
            {fmt === 'HEX'
              ? <input key={hex} className="input mono" aria-label="Hex colour" defaultValue={hex} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={(e) => { const v = e.currentTarget.value.trim(); const full = /^#?[0-9a-f]{6}$/i.test(v) ? (v.startsWith('#') ? v : `#${v}`) : ''; if (full && full.toLowerCase() !== hex) pickHex(full.toLowerCase()); }} />
              : fields[fmt].map((x) => <input key={`${x.label}${x.value}`} className="input cp-n" aria-label={x.label} title={x.label} defaultValue={x.value} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={(e) => { const n = Number(e.currentTarget.value); if (Number.isFinite(n) && n !== x.value) { const h = x.set(n); if (h) pickHex(h); } }} />)}
            <input key={`a${alpha}`} className="input cp-n" aria-label="Opacity percent" title="Opacity %" defaultValue={alpha} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} onBlur={(e) => { const n = Math.max(0, Math.min(100, Number(e.currentTarget.value) || 0)); if (n !== alpha) { setAlpha(n); apply(hex, n); } }} />
          </div>
          <div className="cp-note">
            <span className="hint" title="As text on this document's surface colour">{cr >= 4.5 ? '✓' : '✕'} {cr.toFixed(1)}:1 on surface · {crText}</span>
            {allowNone && <button className="btn btn-sm-inline cp-none" onClick={() => onCommit('none')}>None</button>}
          </div>
          <button className="cp-more" aria-expanded={showHarmony} onClick={() => setShowHarmony(!showHarmony)}>{showHarmony ? '▾' : '▸'} Harmonies</button>
          {showHarmony && harmonies(hex).map(([name, list]) => (
            <div key={name} className="cp-row"><span className="hint">{name}</span><div className="cp-strip">{list.map((c, i) => <Swatch key={i} c={c} title={`${name} ${c}`} onPick={() => pickHex(c)} />)}</div></div>
          ))}
          {recent.length > 0 && <div className="cp-row"><span className="hint">Recent</span><div className="cp-strip cp-wrap">{recent.map((c) => <Swatch key={c} c={c} title={c} onPick={() => pickHex(c)} />)}</div></div>}
          <div className="cp-save">
            <input className="input" placeholder="Name to save this colour" aria-label="Name for my colour" value={saving} onChange={(e) => setSaving(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void save(); }} />
            <button className="btn btn-sm-inline" disabled={!slug(saving)} onClick={() => void save()}>Save</button>
          </div>
        </div>
      )}
      {tab !== 'custom' && <input className="input cp-search" placeholder="Search colours" aria-label="Search colours" value={q} onChange={(e) => setQ(e.target.value)} />}
      {tab === 'tokens' && (
        <div className="cp-list">
          {options.filter((o) => filter(o.label)).map((o) => (
            <button key={o.value} className="cp-tok" onClick={() => { onCommit(alpha < 100 ? `${o.value}~${alpha}` : o.value); onClose(); }}>
              <span className="swatch" style={{ background: o.swatch }} /><span className="cp-tok-name">{o.label}</span><span className="cp-tok-hex">{o.swatch}</span>
            </button>
          ))}
        </div>
      )}
      {tab === 'library' && (
        <div className="cp-list">
          {ramps.filter(([n]) => filter(n)).map(([n, ramp]) => (
            <div key={n} className="cp-ramp"><span className="hint">{n}</span><div className="cp-ramp-sw">{STEPS.map((s) => <Swatch key={s} c={ramp[s]!} title={`${n} ${s} ${ramp[s]}`} onPick={() => pickHex(ramp[s]!)} />)}</div></div>
          ))}
          <h4 className="cp-h">Named colours</h4>
          <div className="cp-named">{NAMED.filter(([n]) => filter(n)).map(([n, c]) => <Swatch key={n} c={c} title={`${n} ${c}`} onPick={() => pickHex(c)} />)}</div>
        </div>
      )}
      {tab === 'mine' && (
        <div className="cp-list">
          {!mine.length && <p className="hint">Colours you save appear here and everywhere tokens are offered.</p>}
          {mine.filter((m) => filter(m.name)).map((m) => (
            <div key={m.path} className="cp-tok">
              <button className="cp-tok-main" onClick={() => { onCommit(m.name); onClose(); }}><span className="swatch" style={{ background: m.hex }} /><span className="cp-tok-name">{m.name}</span><span className="cp-tok-hex">{m.hex}</span></button>
              <button className="btn btn-icon" aria-label={`Remove ${m.name}`} onClick={() => void rdl(`token ${m.path} none`, `remove colour ${m.name}`)}>×</button>
            </div>
          ))}
          <h4 className="cp-h">Add many at once</h4>
          <textarea className="input textarea" rows={2} placeholder="Paste a palette: #ff5a1f, #0ea5e9 …" aria-label="Paste hex colours" value={paste} onChange={(e) => setPaste(e.target.value)} />
          <button className="btn btn-sm-inline" disabled={!/#[0-9a-f]{6}/i.test(paste)} onClick={() => void importColors()}>Add colours</button>
        </div>
      )}
    </div>,
    document.body,
  );
}
