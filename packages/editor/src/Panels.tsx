import { useMemo, useState } from 'react';
import { contrastRatio, RAMP_STEPS, TokenResolver, wcagLevel } from '@rangoli/engine';
import { getState, rdl, select, setBrand, useEditor } from './store';

// ------------------------------------------------------------------ tokens

export function TokensPanel() {
  const version = useEditor((s) => s.version);
  const mode = useEditor((s) => s.mode);
  const doc = getState().doc;
  const r = useMemo(() => (doc ? new TokenResolver(doc.data.tokens) : null), [doc, version]);
  const [brand, setBrandDraft] = useState('');
  if (!doc || !r) return null;

  const ramps = ['primary', 'neutral', 'success', 'warning', 'error'].filter((g) => r.has(`color.${g}.500`));
  const surface = r.resolve('color.bg.surface', mode) as string;
  const semantic = r.group('color').filter((t) => !/\.\d+$/.test(t.path) && t.path !== 'color.white');
  const currentBrand = r.resolve('color.primary.600') as string;

  return (
    <div className="tokens">
      <section className="section">
        <h3 className="section-title">Brand</h3>
        <form className="brand-row" onSubmit={(e) => { e.preventDefault(); if (/^#[0-9a-fA-F]{6}$/.test(brand)) void setBrand(brand); }}>
          <input type="color" aria-label="Pick brand color" value={/^#[0-9a-fA-F]{6}$/.test(brand) ? brand : currentBrand} onChange={(e) => setBrandDraft(e.target.value)} />
          <input className="input" placeholder={currentBrand} value={brand} onChange={(e) => setBrandDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn" type="submit" disabled={!/^#[0-9a-fA-F]{6}$/.test(brand)}>Regenerate</button>
        </form>
        <p className="hint">Rebuilds every ramp and semantic token in OKLCH, for light and dark. Undoable.</p>
      </section>

      <section className="section">
        <h3 className="section-title">Ramps</h3>
        {ramps.map((g) => (
          <div key={g} className="ramp">
            <span className="ramp-name">{g}</span>
            <div className="ramp-swatches">
              {RAMP_STEPS.map((s) => {
                const hex = r.resolve(`color.${g}.${s}`) as string;
                return <span key={s} className="ramp-sw" style={{ background: hex }} title={`${g}.${s} ${hex}`} />;
              })}
            </div>
          </div>
        ))}
      </section>

      <section className="section">
        <h3 className="section-title">Semantic · {mode}</h3>
        <div className="sem-list">
          {semantic.map((t) => {
            const hex = r.resolve(t.path, mode);
            if (typeof hex !== 'string') return null;
            const short = r.shortName(t.path, 'color');
            // compare each text color with the background it is actually used on
            const pairBg: Record<string, string> = { 'color.text.onPrimary': 'color.action.primary', 'color.text.onDanger': 'color.action.danger' };
            const isText = (t.path.startsWith('color.text') || t.path.endsWith('.fg')) && t.path !== 'color.text.disabled'; // disabled text is WCAG-exempt
            const bgPath = pairBg[t.path] ?? (t.path.endsWith('.fg') ? t.path.replace(/\.fg$/, '.bg') : undefined);
            const bg = bgPath ? (r.resolve(bgPath, mode) as string) : surface;
            const c = isText ? contrastRatio(hex, bg) : null;
            return (
              <div key={t.path} className="sem">
                <span className="swatch" style={{ background: hex }} />
                <span className="sem-name">{short}</span>
                <span className="sem-val">{hex}</span>
                {c !== null && (
                  <span className={`badge ${wcagLevel(c) === 'AA' || wcagLevel(c) === 'AAA' ? 'badge-ok' : 'badge-bad'}`} title={`Contrast on ${bgPath ? r.shortName(bgPath, 'color') : 'surface'}`}>
                    {c.toFixed(1)} {wcagLevel(c)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="section">
        <h3 className="section-title">Spacing</h3>
        {r.group('space').filter((t) => (r.resolve(t.path) as number) > 0).map((t) => (
          <div key={t.path} className="space-row">
            <span className="sem-name">{t.path.slice(6)}</span>
            <span className="space-bar" style={{ width: Math.min(160, r.resolve(t.path) as number) }} />
            <span className="sem-val">{String(r.resolve(t.path))}px</span>
          </div>
        ))}
      </section>

      <section className="section">
        <h3 className="section-title">Type</h3>
        {r.group('textStyle').map((t) => {
          const v = r.resolve(t.path) as { fontSize: number; lineHeight: number; fontWeight: number };
          return (
            <div key={t.path} className="type-row">
              <span style={{ fontSize: Math.min(v.fontSize, 24), fontWeight: v.fontWeight, lineHeight: 1.2 }}>{t.path.slice(10)}</span>
              <span className="sem-val">{v.fontSize}/{v.lineHeight} · {v.fontWeight}</span>
            </div>
          );
        })}
      </section>
    </div>
  );
}

// ------------------------------------------------------------------ lint

export function LintPanel() {
  const lint = useEditor((s) => s.lint);
  if (!lint.length) return <div className="panel-empty">No issues. Clean work.</div>;
  const fixable = lint.filter((i) => i.fix);
  return (
    <div className="lint">
      {fixable.length > 1 && (
        <div className="lint-bar">
          <span className="hint">{lint.length} issues · {fixable.length} auto-fixable</span>
          <button className="btn" onClick={() => void rdl(fixable.filter((i) => !i.fix!.includes('…')).map((i) => i.fix!).join('\n'), 'apply lint fixes')}>Fix all</button>
        </div>
      )}
      {lint.map((i, k) => (
        <div key={k} className="lint-item">
          <span className={`sev sev-${i.severity}`}>{i.severity}</span>
          <div className="lint-body">
            <button className="lint-node" onClick={() => select([i.node])}>#{i.node}</button> <span className="lint-code">{i.code}</span>
            <p className="lint-msg">{i.message}</p>
            {i.fix && !i.fix.includes('…') && (
              <button className="btn btn-sm" onClick={() => void rdl(i.fix!, `fix ${i.code}`)}>Apply fix</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ activity

export function Activity() {
  const history = useEditor((s) => s.history);
  const items = [...history].reverse().slice(0, 30);
  if (!items.length) return <div className="panel-empty">No changes yet</div>;
  return (
    <ol className="activity">
      {items.map((h) => (
        <li key={h.seq} className="act">
          <span className={`act-who ${h.author.startsWith('agent') ? 'is-agent' : ''}`}>{h.author.startsWith('agent') ? 'Agent' : h.author === 'human' ? 'You' : h.author}</span>
          <span className="act-what">{h.label ?? `${h.touched} changes`}</span>
          <time className="act-time">{new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </li>
      ))}
    </ol>
  );
}
