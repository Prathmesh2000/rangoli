import { useEffect, useMemo, useState } from 'react';
import { MOTION_PRESETS, resolveTiming, sampleMotion, serializeMotion, timelineDuration, TokenResolver, type MotionSpec, type RNode } from '@rangoli/engine';
import { playMotion, playTimeline } from './Canvas';
import { indent } from './helpers';
import { getState, rdl, useEditor } from './store';

/** Motion for the selected node: its own (#id) plus inherited component motion (read-only here). */
export function MotionTab({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const doc = getState().doc!;
  const own = `#${node.id}`;
  const motion = doc.data.motion ?? {};
  const inherited = useMemo(() => {
    if (!node.component) return [];
    const comp = doc.data.components[node.component];
    const variant = { ...(comp?.defaults ?? {}), ...(node.variant ?? {}) };
    return Object.values(motion).filter((d) => {
      if (!d.target.startsWith(`@${node.component}`)) return false;
      const m = /\[(.*)\]$/.exec(d.target);
      return !m || m[1]!.split(',').every((kv) => { const [k, v] = kv.split('='); return variant[k!] === v; });
    });
  }, [doc, node, version]);

  const source = serializeMotion(motion, [own]);
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const dirty = draft !== source;
  const def = motion[own];
  const apply = () => {
    const body = draft.trim();
    if (!body) return void rdl(`motion ${own} none`, 'remove motion');
    // accept either a full block ("motion #id\n  …") or just the indented lines
    const script = body.startsWith('motion ') ? body : `motion ${own}\n${indent(body)}`;
    void rdl(def ? `motion ${own} none\n${script}` : script, 'edit motion');
  };

  return (
    <div className="props">
      <section className="section">
        <h3 className="section-title">Presets</h3>
        <div className="chips">
          {Object.entries(MOTION_PRESETS).map(([k, p]) => (
            <button key={k} className="chip-btn" title={`${p.description}\n${p.rdl}`}
              onClick={() => void rdl(`motion ${own}\n${indent(p.rdl)}`, `motion ${k}`)}>
              {k}
            </button>
          ))}
        </div>
      </section>

      <section className="section">
        <h3 className="section-title">This layer</h3>
        <textarea className="code code-sm" spellCheck={false} rows={5} value={draft} placeholder={'enter opacity:0, y:md base out\nexit opacity:0 fast in'}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') apply();
            e.stopPropagation();
          }} />
        <div className="code-actions">
          <button className="btn" disabled={!def?.specs.some((s) => s.trigger === 'enter')} onClick={() => playMotion(node.id, 'enter')}>▶ Enter</button>
          <button className="btn" disabled={!def?.specs.some((s) => s.trigger === 'exit')} onClick={() => playMotion(node.id, 'exit')}>▶ Exit</button>
          <span className="hint" style={{ flex: 1 }} />
          {def && <button className="btn" onClick={() => void rdl(`motion ${own} none`, 'remove motion')}>Remove</button>}
          <button className="btn btn-primary" disabled={!dirty} onClick={apply}>Apply</button>
        </div>
        {def && <Curves specs={def.specs} />}
      </section>

      <Timelines node={node} />

      {inherited.length > 0 && (
        <section className="section">
          <h3 className="section-title">From component</h3>
          <p className="hint" style={{ marginBottom: 6 }}>Hover the element on the canvas to feel it. Edit via RDL: <code>motion @{node.component} …</code></p>
          {inherited.map((d) => (
            <div key={d.target}>
              <pre className="code code-ro code-sm">{serializeMotion({ [d.target]: d })}</pre>
              <Curves specs={d.specs} />
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

/** Timelines that animate this layer (or any, when a screen is selected), with play. */
function Timelines({ node }: { node: RNode }) {
  const doc = getState().doc!;
  const all = Object.values(doc.data.timelines ?? {});
  const inScreen = (id: string) => {
    let n = doc.findNode(id)?.node;
    while (n?.parent) n = doc.findNode(n.parent)?.node;
    return n?.id === node.id;
  };
  const relevant = all.filter((t) => t.tracks.some((tr) => tr.target === node.id || (!node.parent && inScreen(tr.target))));
  if (!relevant.length) return null;
  return (
    <section className="section">
      <h3 className="section-title">Timelines</h3>
      {relevant.map((t) => {
        const ms = timelineDuration(t, doc.data.tokens);
        return (
          <div key={t.name} className="version">
            <span className="version-name">{t.name}</span>
            <span className="hint">{t.tracks.length} steps · {ms}ms</span>
            <button className="btn btn-sm-inline" onClick={() => playTimeline(t.name, t.tracks.map((x) => x.target), ms)}>▶ Play</button>
          </div>
        );
      })}
    </section>
  );
}

function Curves({ specs }: { specs: MotionSpec[] }) {
  const doc = getState().doc!;
  const tokens = useMemo(() => new TokenResolver(doc.data.tokens), [doc]);
  return (
    <div className="curves">
      {specs.map((s, i) => {
        const tm = resolveTiming(s, tokens);
        const pts = Array.from({ length: 33 }, (_, k) => {
          const t = k / 32;
          const v = tm.fn(t);
          return `${(t * 100).toFixed(1)},${(40 - v * 32).toFixed(1)}`;
        }).join(' ');
        const sample = sampleMotion(s, doc.data.tokens, 5);
        return (
          <div key={i} className="curve" title={sample.lines.join('\n')}>
            <svg viewBox="0 -2 100 46" width="64" height="30" aria-hidden>
              <line x1="0" y1="40" x2="100" y2="40" className="curve-axis" />
              <line x1="0" y1="8" x2="100" y2="8" className="curve-axis" />
              <polyline points={pts} className="curve-line" />
            </svg>
            <span className="curve-trig">{s.trigger}</span>
            <span className="sem-val">{tm.ms}ms · {s.easing}</span>
          </div>
        );
      })}
    </div>
  );
}
