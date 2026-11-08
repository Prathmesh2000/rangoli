/**
 * Library, part 2: charts, rich inputs and media. Same contract as library.ts (ComponentDef + anatomy +
 * token CSS); merged into LIBRARY / ANATOMY / COMPONENT_CSS there.
 *
 * Charts follow the data-viz rules: fixed categorical order (color.chart.1–8, never cycled), one hue for
 * sequential, ≤24px bars with 4px rounded data-ends square at the baseline, 2px lines, ≥8px end dots with
 * a 2px surface ring, 2px surface gaps between touching marks, hairline grid, text in text tokens (never
 * the series colour), legend for ≥2 series, a native tooltip on every mark and a table for screen readers.
 */
import { hexToRgb } from './color.js';
import type { RNode, Sizing } from './model.js';
import type { AnatomyCtx, AnatomyResult, Def } from './library.js';

const t = (token: string) => ({ token });
const v = (p: string) => `var(--${p.replace(/\./g, '-')})`;
const num = (x: unknown, d: number) => (typeof x === 'number' ? x : x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : d);
const list = (x: unknown, sep = '|') => String(x ?? '').split(sep).map((s) => s.trim()).filter(Boolean);
const nums = (x: string) => x.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const fixedPx = (n: RNode, axis: 'w' | 'h', d: number) => {
  const dim = n.size?.[axis];
  return dim?.kind === 'fixed' && typeof dim.v === 'number' ? dim.v : d;
};
const r1 = (n: number) => Math.round(n * 10) / 10;
const ctl = (k: string): Sizing['h'] => ({ kind: 'fixed', v: t(`size.control.${k}`) });

/** Axis/label numbers: in full under 10,000, compact above (12.9K, 4.2M). */
export function fmtNum(n: number): string {
  const a = Math.abs(n);
  const trim = (x: number) => (Number.isInteger(x) ? String(x) : x.toFixed(1).replace(/\.0$/, ''));
  if (a >= 1e9) return `${trim(n / 1e9)}B`;
  if (a >= 1e6) return `${trim(n / 1e6)}M`;
  if (a >= 1e4) return `${trim(n / 1e3)}K`;
  return Number.isInteger(n) ? n.toLocaleString('en-US') : String(r1(n));
}
function niceMax(max: number): { top: number; step: number } {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
  return { top: Math.ceil(max / step) * step, step };
}
/** column/bar data-end: 4px round on the value end, square at the baseline */
const colPath = (x: number, y: number, w: number, h: number, round: boolean) => {
  const r = round ? Math.min(4, w / 2, h) : 0;
  return `M${r1(x)} ${r1(y + h)}V${r1(y + r)}Q${r1(x)} ${r1(y)} ${r1(x + r)} ${r1(y)}H${r1(x + w - r)}Q${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + r)}V${r1(y + h)}Z`;
};
const barPath = (x: number, y: number, w: number, h: number) => {
  const r = Math.min(4, h / 2, w);
  return `M${r1(x)} ${r1(y)}H${r1(x + w - r)}Q${r1(x + w)} ${r1(y)} ${r1(x + w)} ${r1(y + r)}V${r1(y + h - r)}Q${r1(x + w)} ${r1(y + h)} ${r1(x + w - r)} ${r1(y + h)}H${r1(x)}Z`;
};
const arc = (cx: number, cy: number, R: number, r: number, a0: number, a1: number) => {
  const p = (rad: number, a: number) => `${r1(cx + rad * Math.sin(a))} ${r1(cy - rad * Math.cos(a))}`;
  const big = a1 - a0 > Math.PI ? 1 : 0;
  return `M${p(R, a0)}A${R} ${R} 0 ${big} 1 ${p(R, a1)}L${p(r, a1)}A${r} ${r} 0 ${big} 0 ${p(r, a0)}Z`;
};

const SAMPLE = { data: '18,24,21,30,27,34,31', labels: 'Mon|Tue|Wed|Thu|Fri|Sat|Sun' };

function chart(n: RNode, kind: string, label: string | undefined, c: AnatomyCtx): AnatomyResult {
  const esc = c.esc;
  const unit = String(n.props?.unit ?? '');
  const series = String(n.props?.data ?? SAMPLE.data).split(';').map(nums).slice(0, 8);
  const cats = list(n.props?.labels ?? (n.props?.data ? '' : SAMPLE.labels));
  const nCat = Math.max(cats.length, ...series.map((s) => s.length));
  while (cats.length < nCat) cats.push(String(cats.length + 1));
  const names = list(n.props?.series);
  while (names.length < series.length) names.push(series.length === 1 ? label ?? 'Value' : `Series ${names.length + 1}`);
  const val = (s: number, i: number) => Math.max(0, series[s]?.[i] ?? 0);
  const fmt = (x: number) => `${fmtNum(x)}${unit}`;
  const W = fixedPx(n, 'w', 560);
  const legendOn = kind === 'donut' || (series.length >= 2 && kind !== 'heatmap');
  const H = Math.max(120, fixedPx(n, 'h', 240) - (legendOn && kind !== 'donut' ? 28 : 0) - (label ? 24 : 0));
  const table = `<table class="rk-sr"><caption>${esc(label ?? 'Chart data')}</caption><tr><th></th>${cats.map((x) => `<th>${esc(x)}</th>`).join('')}</tr>${series.map((s, k) => `<tr><th>${esc(names[k]!)}</th>${cats.map((_, i) => `<td>${esc(fmt(s[i] ?? 0))}</td>`).join('')}</tr>`).join('')}</table>`;
  const legend = legendOn
    ? `<div class="rk-legend">${(kind === 'donut' ? cats.slice(0, 8) : names).map((nm, k) => `<span><i class="rk-k${k + 1}"></i>${esc(nm)}${kind === 'donut' ? `<b>${esc(fmtPct(val(0, k), series[0]!.reduce((a, b) => a + Math.max(0, b), 0)))}</b>` : ''}</span>`).join('')}</div>`
    : '';
  const title = label ? `<div class="rk-title">${esc(label)}</div>` : '';
  const desc = esc(`${label ?? 'Chart'}: ${names.join(', ')} across ${nCat} ${nCat === 1 ? 'point' : 'points'}`);
  const svg = (w: number, h: number, body: string) => `<svg class="rk-plot" viewBox="0 0 ${w} ${h}" role="img" aria-label="${desc}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
  const tip = (i: number, s: number) => `<title>${esc(`${cats[i]} · ${names[s]}: ${fmt(series[s]?.[i] ?? 0)}`)}</title>`;

  if (kind === 'donut') {
    const vals = cats.slice(0, 8).map((_, i) => val(0, i));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const side = Math.min(H, 220);
    const R = side / 2 - 2, r = R * 0.68, cx = side / 2, cy = side / 2;
    let a = 0;
    const segs = vals
      .map((x, i) => {
        if (x <= 0) return '';
        const a1 = a + (x / total) * Math.PI * 2;
        const d = arc(cx, cy, R, r, a, Math.min(a1, a + Math.PI * 2 - 0.0001));
        a = a1;
        return `<path class="rk-s${i + 1}" d="${d}">${`<title>${esc(`${cats[i]}: ${fmt(x)} (${fmtPct(x, total)})`)}</title>`}</path>`;
      })
      .join('');
    const center = `<text class="rk-hero" x="${cx}" y="${cy + 2}" text-anchor="middle">${esc(fmt(vals.reduce((p, q) => p + q, 0)))}</text><text class="rk-tick" x="${cx}" y="${cy + 20}" text-anchor="middle">${esc(String(n.props?.total ?? 'Total'))}</text>`;
    return { inner: `${title}<div class="rk-donut">${svg(side, side, segs + center)}${legend}</div>${table}` };
  }

  if (kind === 'heatmap') {
    const padL = Math.min(120, Math.max(...names.map((s) => s.length)) * 7 + 12), padB = 22;
    const pw = W - padL, ph = H - padB;
    const cw = pw / nCat, chh = ph / series.length;
    const all = series.flat();
    const lo = Math.min(...all), hi = Math.max(...all);
    const step = (x: number) => (hi === lo ? 4 : 1 + Math.round(((x - lo) / (hi - lo)) * 6));
    let body = '';
    series.forEach((s, k) => {
      body += `<text class="rk-tick" x="${padL - 8}" y="${r1(k * chh + chh / 2 + 4)}" text-anchor="end">${esc(names[k]!)}</text>`;
      for (let i = 0; i < nCat; i++) {
        const x = s[i] ?? 0;
        body += `<rect class="rk-q${step(x)}" x="${r1(padL + i * cw + 1)}" y="${r1(k * chh + 1)}" width="${r1(cw - 2)}" height="${r1(chh - 2)}" rx="2">${tip(i, k)}</rect>`;
      }
    });
    const every = Math.max(1, Math.ceil((nCat * 36) / pw));
    cats.forEach((x, i) => { if (i % every === 0) body += `<text class="rk-tick" x="${r1(padL + i * cw + cw / 2)}" y="${H - 6}" text-anchor="middle">${esc(x)}</text>`; });
    const scale = `<div class="rk-scale"><span>${esc(fmt(lo))}</span>${[1, 2, 3, 4, 5, 6, 7].map((q) => `<i class="rk-q${q}"></i>`).join('')}<span>${esc(fmt(hi))}</span></div>`;
    return { inner: `${title}${svg(W, H, body)}${scale}${table}` };
  }

  const horizontal = kind === 'bar';
  const stacked = kind === 'stacked';
  const max = stacked ? Math.max(...cats.map((_, i) => series.reduce((a, _s, k) => a + val(k, i), 0))) : Math.max(...series.flat().map((x) => Math.max(0, x)));
  // bars always start at zero; a line may zoom to its range (unless zero=true) so small changes stay visible
  let { top, step } = niceMax(max);
  let bottom = 0;
  const lineLike = kind === 'line' || kind === 'area';
  const vals = series.flat();
  const lo = Math.min(...vals);
  if (lineLike && n.props?.zero !== true && lo > 0 && lo > max * 0.5) {
    const span = niceMax(max - lo || max * 0.1);
    step = span.step;
    bottom = Math.floor(lo / step) * step;
    if (bottom === lo) bottom -= step;
    top = Math.ceil(max / step) * step;
    if (top === max) top += step;
  }
  const ticks: number[] = [];
  for (let x = bottom; x <= top + step / 2; x += step) ticks.push(Math.round(x * 1000) / 1000);
  const tickW = Math.max(...ticks.map((x) => fmt(x).length)) * 6.5 + 10;
  const lineEnd = (kind === 'line' || kind === 'area') && series.length === 1;
  let body = '';

  if (horizontal) {
    const padL = Math.min(140, Math.max(...cats.map((s) => s.length)) * 7 + 12), padR = 44, padB = 20;
    const pw = W - padL - padR, ph = H - padB;
    const band = ph / nCat;
    const bw = Math.min(24, (band * 0.7 - (series.length - 1) * 2) / series.length);
    ticks.forEach((x) => {
      const gx = r1(padL + (x / top) * pw);
      body += `<line class="rk-grid" x1="${gx}" y1="0" x2="${gx}" y2="${ph}"/><text class="rk-tick" x="${gx}" y="${H - 4}" text-anchor="middle">${esc(fmt(x))}</text>`;
    });
    body += `<line class="rk-axis" x1="${padL}" y1="0" x2="${padL}" y2="${ph}"/>`;
    cats.forEach((cname, i) => {
      const gy = i * band + (band - (series.length * bw + (series.length - 1) * 2)) / 2;
      body += `<text class="rk-tick rk-cat" x="${padL - 8}" y="${r1(i * band + band / 2 + 4)}" text-anchor="end">${esc(cname)}</text>`;
      series.forEach((_s, k) => {
        const x = val(k, i), w = (x / top) * pw, y = gy + k * (bw + 2); // bars: zero baseline
        if (w > 0) body += `<path class="rk-s${k + 1}" d="${barPath(padL, y, w, bw)}">${tip(i, k)}</path>`;
        if (series.length === 1) body += `<text class="rk-val" x="${r1(padL + w + 6)}" y="${r1(y + bw / 2 + 4)}">${esc(fmt(x))}</text>`;
      });
    });
    return { inner: `${title}${legend}${svg(W, H, body)}${table}` };
  }

  const padL = tickW, padR = lineEnd ? 48 : 8, padT = 8, padB = 22;
  const pw = W - padL - padR, ph = H - padT - padB;
  const y = (x: number) => padT + ph - ((x - bottom) / (top - bottom)) * ph;
  ticks.forEach((x) => {
    body += `<line class="${x === bottom ? 'rk-axis' : 'rk-grid'}" x1="${padL}" y1="${r1(y(x))}" x2="${W - padR}" y2="${r1(y(x))}"/><text class="rk-tick" x="${padL - 8}" y="${r1(y(x) + 4)}" text-anchor="end">${esc(fmt(x))}</text>`;
  });
  const band = pw / nCat;
  const xAt = (i: number) => (kind === 'line' || kind === 'area' ? (nCat === 1 ? padL + pw / 2 : padL + (i * pw) / (nCat - 1)) : padL + i * band + band / 2);
  const every = Math.max(1, Math.ceil((nCat * Math.max(...cats.map((s) => s.length)) * 7 + nCat * 12) / pw));
  cats.forEach((cname, i) => { if (i % every === 0 || i === nCat - 1) body += `<text class="rk-tick" x="${r1(xAt(i))}" y="${H - 6}" text-anchor="${(kind === 'line' || kind === 'area') && i === 0 ? 'start' : (kind === 'line' || kind === 'area') && i === nCat - 1 ? 'end' : 'middle'}">${esc(cname)}</text>`; });

  if (kind === 'line' || kind === 'area') {
    series.forEach((s, k) => {
      const pts = cats.map((_, i) => `${r1(xAt(i))},${r1(y(Math.max(0, s[i] ?? 0)))}`);
      if (kind === 'area') body += `<path class="rk-wash${k + 1}" d="M${pts[0]}L${pts.join('L')}L${r1(xAt(nCat - 1))},${r1(y(bottom))}L${r1(xAt(0))},${r1(y(bottom))}Z"/>`;
      body += `<polyline class="rk-l${k + 1}" points="${pts.join(' ')}"/>`;
    });
    series.forEach((s, k) => {
      // hover targets: one per point (invisible, larger than the mark) + the end dot
      cats.forEach((_, i) => { body += `<circle class="rk-hit" cx="${r1(xAt(i))}" cy="${r1(y(val(k, i)))}" r="8">${tip(i, k)}</circle>`; });
      const last = nCat - 1;
      body += `<circle class="rk-dot rk-s${k + 1}" cx="${r1(xAt(last))}" cy="${r1(y(val(k, last)))}" r="4">${tip(last, k)}</circle>`;
      if (lineEnd) body += `<text class="rk-val" x="${r1(xAt(last) + 10)}" y="${r1(y(val(k, last)) + 4)}">${esc(fmt(s[last] ?? 0))}</text>`;
    });
  } else if (stacked) {
    const bw = Math.min(24, band * 0.6);
    cats.forEach((_, i) => {
      let base = 0;
      const topK = series.map((_s, k) => k).filter((k) => val(k, i) > 0).at(-1);
      series.forEach((_s, k) => {
        const x = val(k, i);
        if (x <= 0) return;
        const y0 = y(base), y1 = y(base + x);
        const gap = base > 0 ? 2 : 0;
        body += `<path class="rk-s${k + 1}" d="${colPath(xAt(i) - bw / 2, y1, bw, y0 - y1 - gap, k === topK)}">${tip(i, k)}</path>`;
        base += x;
      });
    });
  } else {
    const nS = series.length;
    const bw = Math.min(24, (band * 0.72 - (nS - 1) * 2) / nS);
    cats.forEach((_, i) => {
      const gx = xAt(i) - (nS * bw + (nS - 1) * 2) / 2;
      series.forEach((_s, k) => {
        const x = val(k, i), h = (x / top) * ph;
        if (h > 0) body += `<path class="rk-s${k + 1}" d="${colPath(gx + k * (bw + 2), y(x), bw, h, true)}">${tip(i, k)}</path>`;
      });
    });
  }
  return { inner: `${title}${legend}${svg(W, H, body)}${table}` };
}
const fmtPct = (x: number, total: number) => `${Math.round((x / (total || 1)) * 100)}%`;

function hueOf(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return Math.round(((h * 60) + 360) % 360);
}
function svOf(hex: string): { s: number; v: number } {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  return { s: max ? (max - min) / max : 0, v: max };
}

const KEYWORDS = /^(const|let|var|function|return|if|else|for|while|import|from|export|default|class|new|await|async|def|type|interface|extends|try|catch|finally|throw|in|of|and|or|not|with|as|public|private|static|void|yield|elif|lambda|pass|raise|SELECT|FROM|WHERE|JOIN|ON|GROUP|BY|ORDER|LIMIT)$/;
const LITERALS = /^(true|false|null|undefined|None|True|False|nil)$/;
function highlight(line: string, lang: string, esc: (s: string) => string): string {
  const hashComments = /^(py|python|sh|bash|shell|yaml|yml|rb|ruby|toml)$/i.test(lang);
  const re = hashComments
    ? /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g
    : /(\/\/.*$|\/\*.*?\*\/|--\s.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)/g;
  let out = '';
  let last = 0;
  for (const m of line.matchAll(re)) {
    out += esc(line.slice(last, m.index));
    const [tok] = m;
    if (m[1]) out += `<span class="rk-c">${esc(tok)}</span>`;
    else if (m[2]) out += `<span class="rk-str">${esc(tok)}</span>`;
    else if (m[3]) out += `<span class="rk-num">${esc(tok)}</span>`;
    else if (KEYWORDS.test(tok)) out += `<span class="rk-kw">${esc(tok)}</span>`;
    else if (LITERALS.test(tok)) out += `<span class="rk-num">${esc(tok)}</span>`;
    else if (line[m.index! + tok.length] === '(') out += `<span class="rk-fn">${esc(tok)}</span>`;
    else out += esc(tok);
    last = m.index! + tok.length;
  }
  return out + esc(line.slice(last));
}

export const DATA_ANATOMY: Record<string, (n: RNode, variant: Record<string, string>, label: string | undefined, c: AnatomyCtx) => AnatomyResult> = {
  chart: (n, vr, label, c) => chart(n, vr.kind ?? 'column', label, c),
  sparkline: (n, vr, label, c) => {
    const d = nums(String(n.props?.data ?? '4,6,5,8,7,9,8,11,10,12,11,14'));
    const W = fixedPx(n, 'w', 96), H = fixedPx(n, 'h', 28), pad = 4;
    const lo = Math.min(...d), hi = Math.max(...d);
    const xy = (x: number, i: number) => [pad + (i * (W - pad * 2)) / Math.max(1, d.length - 1), H - pad - (hi === lo ? 0.5 : (x - lo) / (hi - lo)) * (H - pad * 2)] as const;
    const pts = d.map((x, i) => xy(x, i).map(r1).join(','));
    const [ex, ey] = xy(d.at(-1) ?? 0, d.length - 1);
    const area = vr.area === 'true' ? `<path class="rk-wash1" d="M${pts.join('L')}L${r1(W - pad)},${H - pad}L${pad},${H - pad}Z"/>` : '';
    const desc = c.esc(`${label ?? 'Trend'}: ${d[0]} to ${d.at(-1)}`);
    return { inner: `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${desc}" xmlns="http://www.w3.org/2000/svg">${area}<polyline class="rk-trend" points="${pts.join(' ')}"/><circle class="rk-dot rk-s1" cx="${r1(ex)}" cy="${r1(ey)}" r="3"/></svg>` };
  },
  meter: (n, vr, label, c) => {
    const max = num(n.props?.max, 100);
    const val = Math.max(0, Math.min(max, num(n.props?.value, 64)));
    const warn = num(n.props?.warn, max * 0.75), danger = num(n.props?.danger, max * 0.9);
    const sev = val >= danger ? 'error' : val >= warn ? 'warning' : 'ok';
    const pct = Math.round((val / max) * 100);
    const shown = n.props?.unit === undefined ? `${pct}%` : `${fmtNum(val)}${n.props.unit}`;
    const status = sev === 'ok' ? '' : `<span class="rk-status rk-${sev}">${c.icon('ui/alert', 12)}${sev === 'error' ? 'Critical' : 'High'}</span>`;
    const aria = `role="meter" aria-valuenow="${val}" aria-valuemin="0" aria-valuemax="${max}" aria-label="${c.esc(label ?? 'Meter')}"`;
    if (vr.shape === 'gauge') {
      const R = 52, cx = 60, cy = 60, len = Math.PI * R;
      return {
        inner: `<svg viewBox="0 0 120 68" ${aria} xmlns="http://www.w3.org/2000/svg"><path class="rk-gtrack rk-${sev}" d="M${cx - R} ${cy}A${R} ${R} 0 0 1 ${cx + R} ${cy}"/><path class="rk-gfill rk-${sev}" d="M${cx - R} ${cy}A${R} ${R} 0 0 1 ${cx + R} ${cy}" stroke-dasharray="${r1((pct / 100) * len)} ${r1(len)}"/><text class="rk-gval" x="${cx}" y="${cy - 4}" text-anchor="middle">${c.esc(shown)}</text></svg><span class="rk-glabel">${c.esc(label ?? '')}</span>${status}`,
      };
    }
    return { inner: `<span class="rk-row"><span>${c.esc(label ?? '')}</span><b>${c.esc(shown)}</b></span><span class="rk-track rk-${sev}" ${aria}><span class="rk-fill rk-${sev}" style="width:${pct}%"></span></span>${status}` };
  },
  codeblock: (n, _v, label, c) => {
    const lang = String(n.props?.lang ?? '');
    const src = label ?? 'const result = await run("checkout");\nif (result.failed > 0) {\n  notify(result); // ping the owner\n}';
    const hl = new Set(list(n.props?.highlight, ',').map(Number));
    const showLn = n.props?.lines !== false;
    const head = n.props?.title !== undefined || lang ? `<div class="rk-head"><span>${c.esc(String(n.props?.title ?? lang))}</span><span class="rk-copy" title="Copy">${c.icon('ui/copy', 14)}</span></div>` : '';
    const lines = src.split('\n').map((l, i) => `<span class="rk-line${hl.has(i + 1) ? ' is-hl' : ''}">${showLn ? `<span class="rk-ln">${i + 1}</span>` : ''}<span>${highlight(l, lang, c.esc) || ' '}</span></span>`).join('');
    return { inner: `${head}<pre class="rk-pre"><code>${lines}</code></pre>` };
  },
  numberinput: (n, vr, _label, c) => {
    const val = num(n.props?.value, 1), min = num(n.props?.min, -Infinity), max = num(n.props?.max, Infinity);
    const unit = n.props?.unit ? `<span class="rk-unit">${c.esc(String(n.props.unit))}</span>` : '';
    const off = vr.state === 'disabled';
    return {
      inner: `<span class="rk-step${val <= min || off ? ' is-off' : ''}" aria-label="Decrease">${c.icon('ui/minus', 14)}</span><span class="rk-num" role="spinbutton" aria-valuenow="${val}"${Number.isFinite(min) ? ` aria-valuemin="${min}"` : ''}${Number.isFinite(max) ? ` aria-valuemax="${max}"` : ''}>${c.esc(fmtNum(val))}${unit}</span><span class="rk-step${val >= max || off ? ' is-off' : ''}" aria-label="Increase">${c.icon('ui/plus', 14)}</span>`,
    };
  },
  taginput: (n, _v, label, c) => {
    const tags = list(n.props?.tags ?? 'smoke|checkout');
    return { inner: `${tags.map((x) => `<span class="rk-tag">${c.esc(x)}<span class="rk-x" aria-label="Remove ${c.esc(x)}">${c.icon('ui/close', 12)}</span></span>`).join('')}<span class="rk-ph">${c.esc(label ?? 'Add tag…')}</span>` };
  },
  otp: (n, vr, _label, c) => {
    const len = Math.max(3, Math.min(8, num(n.props?.length, 6)));
    const val = String(n.props?.value ?? '').replace(/\s/g, '').slice(0, len);
    const err = vr.state === 'error';
    return { inner: Array.from({ length: len }, (_, i) => `<span class="rk-box${i === val.length && !err ? ' is-cur' : ''}${err ? ' is-err' : ''}${len === 6 && i === 2 ? ' rk-split' : ''}">${c.esc(val[i] ?? '')}</span>`).join('') };
  },
  avatargroup: (n, _v, _label, c) => {
    const names = list(n.props?.names ?? 'Asha Rao|Ben Ortiz|Chen Wei|Dana Kim|Eli Shah|Fay Lim');
    const max = num(n.props?.max, 4);
    const shown = names.slice(0, max);
    const ini = (s: string) => s.split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? '').join('');
    return { inner: `${shown.map((nm, i) => `<span class="rk-av rk-a${(i % 8) + 1}" title="${c.esc(nm)}">${c.esc(ini(nm))}</span>`).join('')}${names.length > max ? `<span class="rk-av rk-more" title="${names.length - max} more">+${names.length - max}</span>` : ''}`, attrs: [`aria-label="${c.esc(names.join(', '))}"`] };
  },
  colorpicker: (n, _v, _label, c) => {
    const hex = /^#[0-9a-f]{6}$/i.test(String(n.props?.value)) ? String(n.props!.value) : '#2a6fb0';
    const h = hueOf(hex), { s, v: val } = svOf(hex);
    const sw = list(n.props?.swatches ?? '#d63c3c|#d9900f|#2f9e57|#1baf7a|#2a6fb0|#6250d6|#e87ba4|#52514e');
    return {
      inner: `<span class="rk-sv" style="background:linear-gradient(to top,#000,transparent),linear-gradient(to right,#fff,hsl(${h} 100% 50%))"><i class="rk-knob" style="left:${r1(s * 100)}%;top:${r1((1 - val) * 100)}%;background:${hex}"></i></span><span class="rk-hue"><i class="rk-knob" style="left:${r1((h / 360) * 100)}%;background:hsl(${h} 100% 50%)"></i></span><span class="rk-row"><i class="rk-swatch" style="background:${hex}"></i><span class="rk-hex">${hex.toUpperCase()}</span><span class="rk-pct">100%</span></span><span class="rk-swatches">${sw.map((x) => `<i class="rk-sw${x.toLowerCase() === hex.toLowerCase() ? ' is-on' : ''}" style="background:${c.esc(x)}" title="${c.esc(x)}"></i>`).join('')}</span>`,
    };
  },
  video: (n, vr, label, c) => {
    const pct = Math.max(0, Math.min(100, num(n.props?.progress, 34)));
    const playing = vr.state === 'playing';
    const dur = String(n.props?.duration ?? '3:42');
    const [mm = 0, ss = 0] = dur.split(':').map(Number);
    const cur = Math.round(((mm * 60 + ss) * pct) / 100);
    const now = `${Math.floor(cur / 60)}:${String(cur % 60).padStart(2, '0')}`;
    return {
      inner: `${label ? `<span class="rk-vtitle">${c.esc(label)}</span>` : ''}${playing ? '' : `<span class="rk-big" aria-label="Play">${c.icon('ui/play', 28)}</span>`}<span class="rk-bar"><span class="rk-btn">${c.icon(playing ? 'ui/pause' : 'ui/play', 16)}</span><span class="rk-time">${now} / ${c.esc(dur)}</span><span class="rk-prog"><span style="width:${pct}%"></span></span><span class="rk-btn">${c.icon('ui/volume', 16)}</span><span class="rk-btn">${c.icon('ui/maximize', 16)}</span></span>`,
      attrs: [`aria-label="${c.esc(label ?? 'Video')}"`],
    };
  },
  carousel: (n, _v, label, c) => {
    const count = Math.max(1, num(n.props?.count, 4));
    const sel = Math.max(1, Math.min(count, num(n.props?.selected, 1)));
    return {
      inner: `<span class="rk-nav rk-prev" aria-label="Previous slide">${c.icon('ui/chevron-left', 18)}</span><span class="rk-nav rk-next" aria-label="Next slide">${c.icon('ui/chevron-right', 18)}</span><span class="rk-dots" aria-label="Slide ${sel} of ${count}">${Array.from({ length: count }, (_, i) => `<i${i + 1 === sel ? ' class="is-on"' : ''}></i>`).join('')}</span>`,
      attrs: ['role="region"', 'aria-roledescription="carousel"', `aria-label="${c.esc(label ?? 'Carousel')}"`],
    };
  },
};

// ---------------------------------------------------------------- definitions

const surfaceCard = { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.default'), width: 1, align: 'inside' as const }, radius: t('radius.card') };

export const DATA_LIBRARY: Record<string, Def> = {
  Chart: {
    id: 'Chart', name: 'Chart', tag: 'figure', role: 'img', labelProp: 'title', anatomy: 'chart',
    axes: { kind: ['column', 'bar', 'line', 'area', 'stacked', 'donut', 'heatmap'] },
    defaults: { kind: 'column' },
    styles: [{ when: {}, layout: { mode: 'col', gap: t('space.3') }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.caption'), color: t('color.text.secondary') } }],
    doc: {
      category: 'Charts',
      description: 'Bar/column/line/area/stacked/donut/heatmap. Quoted text = title. data="12,18,9" (one series) or "12,18;4,6" (series split by ;), labels="Mon|Tue", series="Passed|Failed". Max 8 series in fixed colour order; one axis only — different measures go in separate charts. Set w/h for the plot size.',
      props: {
        data: { type: 'string', description: 'numbers, comma separated; series separated by ;' },
        labels: { type: 'string', description: 'category labels, | separated' },
        series: { type: 'string', description: 'series names, | separated (legend)' },
        unit: { type: 'string', description: 'suffix for values: %, ms, s…' },
        total: { type: 'string', default: 'Total', description: 'donut centre caption' },
      },
      example: '@Chart kind=line w560 h240 data="96,95,97,94,98" labels="Mon|Tue|Wed|Thu|Fri" unit="%" "Pass rate"',
    },
  },
  Sparkline: {
    id: 'Sparkline', name: 'Sparkline', tag: 'span', role: 'img', labelProp: 'label', anatomy: 'sparkline',
    axes: { area: ['false', 'true'] }, defaults: { area: 'false' },
    styles: [{ when: {}, layout: { mode: 'row' }, size: { w: { kind: 'fixed', v: 96 }, h: { kind: 'fixed', v: 28 } }, style: {} }],
    doc: { category: 'Charts', description: 'Tiny trend line for stat tiles and table cells (de-emphasised line, accent end dot).', noLabel: true, props: { data: { type: 'string', description: 'numbers, comma separated' } }, example: '@Sparkline data="4,6,5,8,7,9,12"' },
  },
  Meter: {
    id: 'Meter', name: 'Meter', tag: 'div', role: 'meter', labelProp: 'label', anatomy: 'meter',
    axes: { shape: ['bar', 'gauge'] }, defaults: { shape: 'bar' },
    styles: [
      { when: {}, layout: { mode: 'col', gap: t('space.1.5') }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.caption'), color: t('color.text.secondary') } },
      { when: { shape: 'gauge' }, layout: { mode: 'col', align: 'center', gap: t('space.1') }, size: { w: { kind: 'fixed', v: 160 } }, style: {} },
    ],
    doc: { category: 'Charts', description: 'A value within a range. The colour moves from accent to warning to danger at warn=/danger= thresholds, and is always paired with an icon and label.', props: { value: { type: 'number', default: 64, description: 'current value' }, max: { type: 'number', default: 100, description: 'maximum' }, warn: { type: 'number', description: 'warning from (default 75% of max)' }, danger: { type: 'number', description: 'critical from (default 90% of max)' }, unit: { type: 'string', description: 'show value with unit instead of %' } }, example: '@Meter value=82 "Storage used"' },
  },
  CodeBlock: {
    id: 'CodeBlock', name: 'CodeBlock', tag: 'div', role: 'code', labelProp: 'code', anatomy: 'codeblock',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'col' }, size: { w: { kind: 'fill' } }, style: { fill: [t('color.bg.subtle')], stroke: { paint: t('color.border.default'), width: 1, align: 'inside' }, radius: t('radius.card'), textStyle: t('textStyle.code'), color: t('color.text.primary'), clip: true } }],
    doc: { category: 'Display', description: 'Code with line numbers, light syntax colouring and highlighted lines. Quoted text = code (use \\n for new lines).', props: { lang: { type: 'string', description: 'js ts py sh sql…' }, title: { type: 'string', description: 'file name in the header' }, highlight: { type: 'string', description: 'line numbers to highlight, e.g. "2,3"' }, lines: { type: 'boolean', default: true, description: 'show line numbers' } }, example: '@CodeBlock lang=ts title="checkout.spec.ts" highlight=2 "await page.goto(\'/cart\')\\nawait expect(total).toHaveText(\'$42\')"' },
  },
  NumberInput: {
    id: 'NumberInput', name: 'NumberInput', tag: 'div', role: 'field', labelProp: 'label', anatomy: 'numberinput',
    axes: { state: ['default', 'disabled'] }, defaults: { state: 'default' },
    styles: [{ when: {}, layout: { mode: 'row', align: 'center' }, size: { h: ctl('md'), w: { kind: 'fixed', v: 128 } }, style: { ...surfaceCard, stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, radius: t('radius.control'), shadow: t('shadow.control'), textStyle: t('textStyle.body'), color: t('color.text.primary') } }],
    doc: { category: 'Inputs', description: 'Number with − / + steppers.', noLabel: true, props: { value: { type: 'number', default: 1, description: 'value' }, min: { type: 'number', description: 'minimum' }, max: { type: 'number', description: 'maximum' }, unit: { type: 'string', description: 'suffix: ms, %, ×' } }, example: '@NumberInput value=3 min=1 max=10 unit="×"' },
  },
  TagInput: {
    id: 'TagInput', name: 'TagInput', tag: 'div', role: 'field', labelProp: 'placeholder', anatomy: 'taginput',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'row', align: 'center', wrap: true, gap: t('space.1'), padding: [t('space.1'), t('space.2'), t('space.1'), t('space.2')] }, size: { w: { kind: 'fill' }, minH: 36 }, style: { ...surfaceCard, stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, radius: t('radius.control'), shadow: t('shadow.control'), textStyle: t('textStyle.body-sm'), color: t('color.text.primary') } }],
    doc: { category: 'Inputs', description: 'Multi-select / tags field: chosen values as removable chips, then the input. Quoted text = placeholder.', props: { tags: { type: 'list', description: 'values, | separated' } }, example: '@TagInput tags="smoke|checkout|mobile" "Add label…"' },
  },
  OTP: {
    id: 'OTP', name: 'OTP', tag: 'div', role: 'field', labelProp: 'label', anatomy: 'otp',
    axes: { state: ['default', 'error'] }, defaults: { state: 'default' },
    styles: [{ when: {}, layout: { mode: 'row', gap: t('space.2'), align: 'center' }, style: { textStyle: t('textStyle.title'), color: t('color.text.primary') } }],
    doc: { category: 'Inputs', description: 'One-time code boxes (verification). Six digits split 3+3.', noLabel: true, props: { length: { type: 'number', default: 6, description: '3–8 boxes' }, value: { type: 'string', description: 'typed digits so far' } }, example: '@OTP value="482"' },
  },
  AvatarGroup: {
    id: 'AvatarGroup', name: 'AvatarGroup', tag: 'div', role: 'group', labelProp: 'label', anatomy: 'avatargroup',
    axes: { size: ['sm', 'md'] }, defaults: { size: 'md' },
    styles: [{ when: {}, layout: { mode: 'row', align: 'center' }, style: { textStyle: t('textStyle.caption'), font: { weight: 600 }, color: t('color.text.primary') } }],
    doc: { category: 'Display', description: 'Overlapping avatars with a +N overflow.', noLabel: true, props: { names: { type: 'list', description: 'people, | separated' }, max: { type: 'number', default: 4, description: 'shown before +N' } }, example: '@AvatarGroup names="Asha Rao|Ben Ortiz|Chen Wei|Dana Kim|Eli Shah"' },
  },
  ColorPicker: {
    id: 'ColorPicker', name: 'ColorPicker', tag: 'div', role: 'group', labelProp: 'label', anatomy: 'colorpicker',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'col', gap: t('space.3'), padding: [t('space.3'), t('space.3'), t('space.3'), t('space.3')] }, size: { w: { kind: 'fixed', v: 248 } }, style: { ...surfaceCard, shadow: t('shadow.md'), textStyle: t('textStyle.body-sm'), color: t('color.text.primary') } }],
    doc: { category: 'Inputs', description: 'Saturation/brightness area, hue slider, hex value and swatches.', noLabel: true, props: { value: { type: 'string', default: '#2a6fb0', description: '#rrggbb' }, swatches: { type: 'list', description: '#hex values, | separated' } }, example: '@ColorPicker value=#d9900f' },
  },
  Video: {
    id: 'Video', name: 'Video', tag: 'div', role: 'media', labelProp: 'title', anatomy: 'video',
    axes: { state: ['paused', 'playing'] }, defaults: { state: 'paused' },
    styles: [{ when: {}, layout: { mode: 'none' }, size: { w: { kind: 'fill' } }, style: { radius: t('radius.card'), clip: true, aspect: '16/9', textStyle: t('textStyle.caption') } }],
    doc: { category: 'Media', description: 'Video player frame: title, big play button (paused), control bar with time, progress, volume and fullscreen. Put an Image layer inside as the poster.', props: { duration: { type: 'string', default: '3:42', description: 'm:ss' }, progress: { type: 'number', default: 34, description: '0–100' } }, example: '@Video duration="12:08" progress=20 "Writing stable selectors"' },
  },
  Carousel: {
    id: 'Carousel', name: 'Carousel', tag: 'div', role: 'region', labelProp: 'label', anatomy: 'carousel',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'col', align: 'center', justify: 'center', padding: [t('space.6'), t('space.12'), t('space.10'), t('space.12')] }, size: { w: { kind: 'fill' }, minH: 200 }, style: { fill: [t('color.bg.subtle')], radius: t('radius.card'), clip: true } }],
    doc: { category: 'Media', description: 'Slides with prev/next and dots. Child layers = the current slide content.', noLabel: true, props: { count: { type: 'number', default: 4, description: 'number of slides' }, selected: { type: 'number', default: 1, description: '1-based current slide' } }, example: '@Carousel count=5 selected=2\n  Text title "Run tests from your phone"' },
  },
};

const series = Array.from({ length: 8 }, (_, i) => i + 1);
export const DATA_CSS: Record<string, string> = {
  Chart: `.rc-Chart{margin:0}.rc-Chart .rk-title{font:var(--textStyle-title-sm);color:${v('color.text.primary')}}.rc-Chart .rk-plot{display:block;width:100%;height:auto;overflow:visible}.rc-Chart .rk-tick{font-size:11px;fill:${v('color.text.secondary')};font-variant-numeric:tabular-nums}.rc-Chart .rk-val{font-size:11px;font-weight:600;fill:${v('color.text.primary')}}.rc-Chart .rk-hero{font-size:22px;font-weight:600;fill:${v('color.text.primary')}}.rc-Chart .rk-grid{stroke:${v('color.chart.grid')};stroke-width:1;shape-rendering:crispEdges}.rc-Chart .rk-axis{stroke:${v('color.chart.axis')};stroke-width:1;shape-rendering:crispEdges}.rc-Chart polyline{fill:none;stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.rc-Chart .rk-dot{stroke:${v('color.bg.surface')};stroke-width:2;paint-order:stroke}.rc-Chart .rk-hit{fill:transparent}.rc-Chart .rk-donut path{stroke:${v('color.bg.surface')};stroke-width:2}.rc-Chart .rk-donut{display:flex;align-items:center;gap:24px}.rc-Chart .rk-donut svg{width:auto;max-width:220px;flex-shrink:0}.rc-Chart .rk-donut .rk-legend{flex-direction:column;gap:8px}.rc-Chart .rk-legend{display:flex;flex-wrap:wrap;gap:6px 16px;color:${v('color.text.secondary')}}.rc-Chart .rk-legend span{display:inline-flex;align-items:center;gap:6px}.rc-Chart .rk-legend b{margin-left:4px;font-weight:600;color:${v('color.text.primary')};font-variant-numeric:tabular-nums}.rc-Chart .rk-legend i{width:10px;height:10px;border-radius:3px}.rc-Chart .rk-scale{display:flex;align-items:center;gap:2px;color:${v('color.text.secondary')}}.rc-Chart .rk-scale span{padding:0 6px}.rc-Chart .rk-scale i{width:20px;height:8px;border-radius:2px}.rc-Chart path:hover,.rc-Chart rect:hover{opacity:.85}${series.map((k) => `.rc-Chart .rk-s${k},.rc-Chart .rk-k${k}{fill:${v(`color.chart.${k}`)};background:${v(`color.chart.${k}`)}}.rc-Chart .rk-l${k}{stroke:${v(`color.chart.${k}`)}}.rc-Chart .rk-wash${k}{fill:${v(`color.chart.${k}`)};fill-opacity:.1}`).join('')}${[1, 2, 3, 4, 5, 6, 7].map((q) => `.rc-Chart .rk-q${q}{fill:${v(`color.chart.seq.${q}`)};background:${v(`color.chart.seq.${q}`)}}`).join('')}`,
  Sparkline: `.rc-Sparkline svg{display:block;width:100%;height:100%;overflow:visible}.rc-Sparkline .rk-trend{fill:none;stroke:${v('color.text.secondary')};stroke-width:1.5;stroke-linejoin:round;stroke-linecap:round}.rc-Sparkline .rk-s1{fill:${v('color.chart.1')}}.rc-Sparkline .rk-dot{stroke:${v('color.bg.surface')};stroke-width:1.5;paint-order:stroke}.rc-Sparkline .rk-wash1{fill:${v('color.chart.1')};fill-opacity:.1}`,
  Meter: `.rc-Meter .rk-row{display:flex;justify-content:space-between;gap:8px}.rc-Meter .rk-row b{font-weight:600;color:${v('color.text.primary')};font-variant-numeric:tabular-nums}.rc-Meter .rk-track{display:block;height:8px;border-radius:4px;overflow:hidden}.rc-Meter .rk-fill{display:block;height:100%;border-radius:4px}.rc-Meter .rk-ok{--m:${v('color.action.primary')}}.rc-Meter .rk-warning{--m:${v('color.warning.500')}}.rc-Meter .rk-error{--m:${v('color.error.500')}}.rc-Meter .rk-track{background:color-mix(in srgb,var(--m) 18%,${v('color.bg.surface')})}.rc-Meter .rk-fill{background:var(--m)}.rc-Meter .rk-status{display:inline-flex;align-items:center;gap:4px;font-weight:600}.rc-Meter .rk-status.rk-warning{color:${v('color.status.warning.fg')}}.rc-Meter .rk-status.rk-error{color:${v('color.status.error.fg')}}.rc-Meter>svg{width:100%;overflow:visible}.rc-Meter .rk-gtrack,.rc-Meter .rk-gfill{fill:none;stroke-width:10;stroke-linecap:round}.rc-Meter .rk-gtrack{stroke:color-mix(in srgb,var(--m) 18%,${v('color.bg.surface')})}.rc-Meter .rk-gfill{stroke:var(--m)}.rc-Meter .rk-gval{font-size:20px;font-weight:600;fill:${v('color.text.primary')}}.rc-Meter .rk-glabel{color:${v('color.text.secondary')}}`,
  CodeBlock: `.rc-CodeBlock .rk-head{display:flex;justify-content:space-between;align-items:center;padding:6px 12px;border-bottom:1px solid ${v('color.border.default')};font:var(--textStyle-caption);color:${v('color.text.secondary')}}.rc-CodeBlock .rk-copy{display:flex;cursor:pointer}.rc-CodeBlock .rk-pre{margin:0;padding:10px 0;overflow:auto;font:inherit}.rc-CodeBlock .rk-line{display:block;padding:0 14px 0 0;white-space:pre}.rc-CodeBlock .rk-line.is-hl{background:color-mix(in srgb,${v('color.action.primary')} 12%,transparent);box-shadow:inset 3px 0 0 ${v('color.action.primary')}}.rc-CodeBlock .rk-ln{display:inline-block;width:3ch;margin:0 12px 0 8px;text-align:right;color:${v('color.text.disabled')};user-select:none}.rc-CodeBlock .rk-kw{color:${v('color.primary.700')};font-weight:600}.rc-CodeBlock .rk-str{color:${v('color.success.700')}}.rc-CodeBlock .rk-num{color:${v('color.warning.800')}}.rc-CodeBlock .rk-fn{color:${v('color.error.700')}}.rc-CodeBlock .rk-c{color:${v('color.text.secondary')};font-style:italic}[data-mode="dark"] .rc-CodeBlock .rk-kw{color:${v('color.primary.300')}}[data-mode="dark"] .rc-CodeBlock .rk-str{color:${v('color.success.300')}}[data-mode="dark"] .rc-CodeBlock .rk-num{color:${v('color.warning.300')}}[data-mode="dark"] .rc-CodeBlock .rk-fn{color:${v('color.error.300')}}`,
  NumberInput: `.rc-NumberInput .rk-step{display:grid;place-items:center;width:var(--size-control-md);height:100%;flex-shrink:0;color:${v('color.text.secondary')};cursor:pointer}.rc-NumberInput .rk-step:hover{background:${v('color.bg.subtle')};color:${v('color.text.primary')}}.rc-NumberInput .rk-step.is-off{opacity:.4;pointer-events:none}.rc-NumberInput .rk-num{flex:1;text-align:center;font-variant-numeric:tabular-nums;border-inline:1px solid ${v('color.border.default')};align-self:stretch;display:grid;place-items:center;grid-auto-flow:column;gap:2px}.rc-NumberInput .rk-unit{color:${v('color.text.secondary')}}`,
  TagInput: `.rc-TagInput .rk-tag{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 4px 0 8px;border-radius:${v('radius.1')};background:${v('color.bg.subtle')};box-shadow:inset 0 0 0 1px ${v('color.border.default')}}.rc-TagInput .rk-x{display:grid;place-items:center;width:16px;height:16px;border-radius:3px;color:${v('color.text.secondary')};cursor:pointer}.rc-TagInput .rk-x:hover{background:${v('color.border.default')}}.rc-TagInput .rk-ph{flex:1;min-width:80px;padding:0 4px;color:${v('color.text.disabled')}}`,
  OTP: `.rc-OTP .rk-box{display:grid;place-items:center;width:calc(var(--size-control-lg) * .9);height:var(--size-control-lg);border-radius:${v('radius.control')};background:${v('color.bg.surface')};box-shadow:inset 0 0 0 1px ${v('color.border.strong')};font-variant-numeric:tabular-nums}.rc-OTP .rk-box.is-cur{box-shadow:inset 0 0 0 2px ${v('color.border.focus')}}.rc-OTP .rk-box.is-err{box-shadow:inset 0 0 0 1.5px ${v('color.status.error.fg')}}.rc-OTP .rk-split{margin-right:12px}`,
  AvatarGroup: `.rc-AvatarGroup .rk-av{display:grid;place-items:center;width:32px;height:32px;border-radius:50%;margin-left:-8px;box-shadow:0 0 0 2px ${v('color.bg.surface')};flex-shrink:0}.rc-AvatarGroup .rk-av:first-child{margin-left:0}.rc-AvatarGroup[data-size="sm"] .rk-av{width:24px;height:24px;margin-left:-6px;font-size:10px}.rc-AvatarGroup .rk-more{background:${v('color.bg.subtle')};color:${v('color.text.secondary')}}${series.map((k) => `.rc-AvatarGroup .rk-a${k}{background:color-mix(in srgb,${v(`color.chart.${k}`)} 22%,${v('color.bg.surface')})}`).join('')}`,
  ColorPicker: `.rc-ColorPicker .rk-sv{position:relative;display:block;height:140px;border-radius:${v('radius.1')}}.rc-ColorPicker .rk-knob{position:absolute;width:14px;height:14px;border-radius:50%;transform:translate(-50%,-50%);box-shadow:0 0 0 2px #fff,0 0 0 3px rgba(0,0,0,.25)}.rc-ColorPicker .rk-hue{position:relative;display:block;height:10px;border-radius:5px;background:linear-gradient(to right,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)}.rc-ColorPicker .rk-hue .rk-knob{top:50%}.rc-ColorPicker .rk-row{display:flex;align-items:center;gap:8px}.rc-ColorPicker .rk-swatch{width:24px;height:24px;border-radius:${v('radius.1')};box-shadow:inset 0 0 0 1px rgba(0,0,0,.1)}.rc-ColorPicker .rk-hex{flex:1;height:28px;display:flex;align-items:center;padding:0 8px;border-radius:${v('radius.control')};box-shadow:inset 0 0 0 1px ${v('color.border.strong')};font-family:${v('font.family.mono')}}.rc-ColorPicker .rk-pct{color:${v('color.text.secondary')};font-variant-numeric:tabular-nums}.rc-ColorPicker .rk-swatches{display:grid;grid-template-columns:repeat(8,1fr);gap:6px}.rc-ColorPicker .rk-sw{aspect-ratio:1;border-radius:${v('radius.1')};cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.1)}.rc-ColorPicker .rk-sw.is-on{box-shadow:0 0 0 2px ${v('color.bg.surface')},0 0 0 4px ${v('color.border.focus')}}`,
  Video: `.rc-Video{position:relative;background:#0b0b0c;color:#fff}.rc-Video>*:not(.rk-vtitle):not(.rk-big):not(.rk-bar){width:100%;height:100%}.rc-Video .rk-vtitle{position:absolute;top:0;left:0;right:0;padding:12px 16px 24px;font:var(--textStyle-label);background:linear-gradient(rgba(0,0,0,.55),transparent)}.rc-Video .rk-big{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:grid;place-items:center;width:64px;height:64px;border-radius:50%;background:rgba(255,255,255,.92);color:#0b0b0c;cursor:pointer}.rc-Video .rk-big svg{margin-left:3px}.rc-Video .rk-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;gap:12px;padding:20px 12px 10px;background:linear-gradient(transparent,rgba(0,0,0,.65))}.rc-Video .rk-btn{display:grid;place-items:center;width:28px;height:28px;border-radius:6px;cursor:pointer}.rc-Video .rk-btn:hover{background:rgba(255,255,255,.15)}.rc-Video .rk-time{font-variant-numeric:tabular-nums;opacity:.9}.rc-Video .rk-prog{flex:1;height:4px;border-radius:2px;background:rgba(255,255,255,.3)}.rc-Video .rk-prog span{display:block;height:100%;border-radius:2px;background:#fff}`,
  Carousel: `.rc-Carousel{position:relative}.rc-Carousel .rk-nav{position:absolute;top:50%;transform:translateY(-50%);display:grid;place-items:center;width:36px;height:36px;border-radius:50%;background:${v('color.bg.surface')};color:${v('color.text.primary')};box-shadow:${v('shadow.sm')};cursor:pointer}.rc-Carousel .rk-prev{left:12px}.rc-Carousel .rk-next{right:12px}.rc-Carousel .rk-dots{position:absolute;bottom:14px;left:50%;transform:translateX(-50%);display:flex;gap:6px}.rc-Carousel .rk-dots i{width:6px;height:6px;border-radius:3px;background:${v('color.text.secondary')};opacity:.4}.rc-Carousel .rk-dots i.is-on{width:18px;opacity:1;background:${v('color.text.primary')}}`,
};
