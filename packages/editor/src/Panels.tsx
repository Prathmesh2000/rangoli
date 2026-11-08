import { useMemo, useState } from 'react';
import { LANGUAGES, contrastRatio, fontStack, languageOf, languageTokens, RAMP_STEPS, TokenResolver, wcagLevel, type RangoliDocument } from '@rangoli/engine';
import { TextInput } from './controls';
import { authorLabel, getState, rdl, select, setBrand, useEditor } from './store';

// ------------------------------------------------------------------ tokens

/** A token's stored value (alias text like {color.neutral.50} stays an alias). */
function rawToken(doc: RangoliDocument, path: string): unknown {
  let cur: unknown = doc.data.tokens;
  for (const p of path.split('.')) cur = (cur as Record<string, unknown> | undefined)?.[p];
  return (cur as { $value?: unknown } | undefined)?.$value;
}
const tokenArg = (v: string) => (/^[^\s"]+$/.test(v) ? v : JSON.stringify(v));
const shown = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''));

/** Write one token, for the active mode only (dark edits leave the light value alone). */
function writeToken(doc: RangoliDocument, path: string, value: string, mode: string) {
  if (!value) return;
  const script = mode === 'dark' ? `token ${path} ${tokenArg(shown(rawToken(doc, path)))} dark=${tokenArg(value)}` : `token ${path} ${tokenArg(value)}`;
  void rdl(script, `token ${path}`);
}

function LanguageGallery({ doc }: { doc: RangoliDocument }) {
  const current = languageOf(doc.data.tokens).id;
  const cards = useMemo(() => Object.values(LANGUAGES).map((l) => {
    const r = new TokenResolver(languageTokens(l.id));
    const fam = (p: string) => { const v = r.resolve(p); return Array.isArray(v) ? fontStack(v as string[]) : String(v); };
    const head = r.resolve('textStyle.headline') as { fontWeight: number };
    const label = r.resolve('textStyle.label') as { fontWeight: number; textCase?: string };
    return { ...l, display: fam('font.family.display'), sans: fam('font.family.sans'), weight: head.fontWeight, labelWeight: label.fontWeight, upper: label.textCase === 'uppercase', brand: r.resolve('color.primary.600') as string, ctl: r.resolve('radius.control') as number, card: r.resolve('radius.card') as number, shadow: r.resolve('shadow.control') as string, canvas: r.resolve('color.bg.canvas') as string, border: r.resolve('color.border.strong') as string };
  }), []);
  const active = cards.find((c) => c.id === current);
  return (
    <section className="section">
      <h3 className="section-title">Design language</h3>
      <div className="lang-grid">
        {cards.map((c) => (
          <button key={c.id} className="lang-card" aria-pressed={c.id === current} title={`Best for: ${c.bestFor}`} onClick={() => c.id !== current && void rdl(`language ${c.id}`, `language ${c.name}`)}>
            <span className="lang-prev" style={{ background: c.canvas }}>
              <span style={{ fontFamily: c.display, fontWeight: c.weight, fontSize: 20, lineHeight: 1, color: '#1c2026' }}>Aa</span>
              <span style={{ fontFamily: c.sans, fontWeight: c.labelWeight, fontSize: 10, padding: '4px 8px', background: c.brand, color: '#fff', borderRadius: Math.min(c.ctl, 14), boxShadow: c.shadow, textTransform: c.upper ? 'uppercase' : 'none' }}>Save</span>
            </span>
            <span className="lang-name">{c.name.replace(/ \(.*\)$/, '').replace('-style', '')}</span>
          </button>
        ))}
      </div>
      {active && <p className="hint">{active.feel} Switching keeps a brand colour you set yourself and replaces manual token edits. Undoable.</p>}
    </section>
  );
}

function ScalarTokens({ title, paths, doc, mode, unit }: { title: string; paths: string[]; doc: RangoliDocument; mode: string; unit?: string }) {
  return (
    <section className="section">
      <h3 className="section-title">{title}</h3>
      {paths.map((p) => (
        <div key={p} className="tok-row">
          <span className="sem-name">{p.split('.').slice(1).join('.')}</span>
          <TextInput value={shown(rawToken(doc, p))} label={p} onCommit={(v) => writeToken(doc, p, v, mode)} />
          {unit && <span className="hint">{unit}</span>}
        </div>
      ))}
    </section>
  );
}

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
    <div className="tokens" data-v={version}>
      <LanguageGallery doc={doc} />
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
                <TextInput small value={hex} label={`${t.path} value`} onCommit={(v) => writeToken(doc, t.path, v, mode)} />
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

      <ScalarTokens title="Corner radius" doc={doc} mode="light" unit="px" paths={r.group('radius').map((t) => t.path).filter((x) => x !== 'radius.0')} />
      <ScalarTokens title="Control heights" doc={doc} mode="light" unit="px" paths={r.group('size').map((t) => t.path)} />
      <ScalarTokens title="Fonts" doc={doc} mode="light" paths={r.group('font.family').map((t) => t.path)} />
      <ScalarTokens title={`Shadows · ${mode}`} doc={doc} mode={mode} paths={r.group('shadow').map((t) => t.path)} />
      <ScalarTokens title="Motion durations" doc={doc} mode="light" unit="ms" paths={r.group('motion.duration').map((t) => t.path).filter((x) => x !== 'motion.duration.instant')} />

      <section className="section">
        <h3 className="section-title">Spacing</h3>
        {r.group('space').filter((t) => (r.resolve(t.path) as number) > 0).map((t) => (
          <div key={t.path} className="space-row">
            <span className="sem-name">{t.path.slice(6)}</span>
            <span className="space-bar" style={{ width: Math.min(160, r.resolve(t.path) as number) }} />
            <TextInput small value={String(r.resolve(t.path))} label={t.path} onCommit={(v) => writeToken(doc, t.path, v, 'light')} />
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
              <span className="type-fields">
                <TextInput small value={String(v.fontSize)} label={`${t.path} size`} onCommit={(x) => void rdl(`token ${t.path}.fontSize ${x}`, 'type size')} />
                <TextInput small value={String(v.lineHeight)} label={`${t.path} line height`} onCommit={(x) => void rdl(`token ${t.path}.lineHeight ${x}`, 'line height')} />
                <TextInput small value={String(v.fontWeight)} label={`${t.path} weight`} onCommit={(x) => void rdl(`token ${t.path}.fontWeight ${x}`, 'font weight')} />
              </span>
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
          <span className={`act-who ${h.author.startsWith('agent') || h.author.includes('accepted agent') ? 'is-agent' : ''}`}>{authorLabel(h.author)}</span>
          <span className="act-what">{h.label ?? `${h.touched} changes`}</span>
          <time className="act-time">{new Date(h.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
        </li>
      ))}
    </ol>
  );
}
