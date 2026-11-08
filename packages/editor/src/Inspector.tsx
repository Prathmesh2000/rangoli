import { useEffect, useMemo, useState } from 'react';
import { renderFragment, resolveInstance, serializeRdl, type Dim, type Padding, type RNode } from '@rangoli/engine';
import { indent, lenValue, paintValue, resolvePaintHex, tokenOptions, type Opt } from './helpers';
import { getState, rdl, useEditor } from './store';
import { MotionTab } from './MotionTab';
import { ProtoTab } from './ProtoTab';

const set = (id: string, flags: string, label?: string) => {
  const name = getState().doc?.findNode(id)?.node.name ?? `#${id}`;
  return rdl(`set #${id} ${flags}`, label ? `${name}: ${label}` : `${name}: ${flags.length > 40 ? flags.slice(0, 39) + '…' : flags}`);
};

export function Inspector() {
  const selection = useEditor((s) => s.selection);
  const version = useEditor((s) => s.version);
  const [tab, setTab] = useState<'design' | 'motion' | 'proto' | 'rdl' | 'css'>('design');
  const doc = getState().doc;
  const node = selection.length === 1 && doc ? doc.findNode(selection[0]!)?.node : undefined;

  if (!doc) return null;
  if (selection.length === 0) return <div className="panel-empty">Select a layer to inspect it.<br />Shift-click to select several.</div>;
  if (!node) return <div className="panel-empty">{selection.length} layers selected</div>;

  return (
    <div className="inspector" data-v={version}>
      <div className="inspector-head">
        <div className="inspector-title">{node.name}</div>
        <div className="inspector-sub">
          {node.component ? `@${node.component}` : node.type} · #{node.id}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(['design', 'motion', 'proto', 'rdl', 'css'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className="tab" onClick={() => setTab(t)}>
            {t === 'rdl' ? 'RDL' : t === 'css' ? 'CSS' : t === 'motion' ? 'Motion' : t === 'proto' ? 'Prototype' : 'Design'}
          </button>
        ))}
      </div>
      {tab === 'design' && <DesignTab node={node} />}
      {tab === 'motion' && <MotionTab node={node} />}
      {tab === 'proto' && <ProtoTab node={node} />}
      {tab === 'rdl' && <RdlTab node={node} />}
      {tab === 'css' && <CssTab node={node} />}
    </div>
  );
}

// ------------------------------------------------------------------ design

function DesignTab({ node }: { node: RNode }) {
  const mode = useEditor((s) => s.mode);
  const doc = getState().doc!;
  const opts = useMemo(() => tokenOptions(doc, mode), [doc, mode]);
  const comp = node.component ? doc.data.components[node.component] : undefined;
  const eff = comp ? resolveInstance(node, comp) : { layout: node.layout, size: node.size, style: node.style ?? {}, variant: {} as Record<string, string> };
  const st = eff.style;
  const id = node.id;
  const isText = node.type === 'text';
  const isContainer = node.type === 'frame' || node.type === 'group';

  return (
    <div className="props">
      {comp && (
        <Section title="Component">
          {Object.entries(comp.axes).map(([axis, values]) => (
            <Row key={axis} label={axis}>
              <Segmented value={eff.variant[axis] ?? ''} options={values} onChange={(v) => set(id, `${axis}=${v}`)} />
            </Row>
          ))}
          <Row label={comp.labelProp ?? 'label'}>
            <TextInput value={String(node.props?.[comp.labelProp ?? 'label'] ?? '')} onCommit={(v) => set(id, JSON.stringify(v), 'edit label')} />
          </Row>
        </Section>
      )}

      {isText && (
        <Section title="Text">
          <textarea className="input textarea" defaultValue={node.text ?? ''} key={`${id}-${node.text}`} rows={3}
            onBlur={(e) => e.currentTarget.value !== node.text && void set(id, JSON.stringify(e.currentTarget.value), 'edit text')} />
          <Row label="Style">
            <Select value={st.textStyle?.token.replace('textStyle.', '') ?? ''} options={opts.textStyles} placeholder="inherit" onChange={(v) => set(id, v)} />
          </Row>
        </Section>
      )}

      {isContainer && (
        <Section title="Layout">
          <Row label="Direction">
            <Segmented value={eff.layout?.mode ?? 'col'} options={['col', 'row', 'grid', 'none']} labels={{ col: '↓ Col', row: '→ Row', grid: '▦ Grid', none: 'Free' }} onChange={(v) => set(id, v)} />
          </Row>
          {eff.layout?.mode !== 'none' && (
            <>
              <Row label="Gap">
                <Select value={lenValue(eff.layout?.gap, 'space')} options={opts.space} placeholder="0" onChange={(v) => set(id, `gap${v}`)} />
              </Row>
              <Row label="Padding">
                <Select value={uniformPad(eff.layout?.padding)} options={opts.space} placeholder={eff.layout?.padding ? 'mixed' : '0'} onChange={(v) => set(id, `p${v}`)} />
              </Row>
              <Row label="Justify">
                <Segmented value={eff.layout?.justify ?? 'start'} options={['start', 'center', 'end', 'between']} labels={{ start: 'Start', center: 'Center', end: 'End', between: 'Space' }}
                  onChange={(v) => set(id, v === 'between' ? 'between' : `j${v}`)} />
              </Row>
              <Row label="Align">
                <Segmented value={eff.layout?.align ?? 'stretch'} options={['start', 'center', 'end', 'stretch']} labels={{ start: 'Start', center: 'Center', end: 'End', stretch: 'Fill' }} onChange={(v) => set(id, v)} />
              </Row>
            </>
          )}
        </Section>
      )}

      <Section title="Size">
        <DimRow axis="w" dim={eff.size?.w} id={id} />
        <DimRow axis="h" dim={eff.size?.h} id={id} />
      </Section>

      <Section title="Appearance">
        {!isText && (
          <Row label="Fill">
            <ColorSelect value={paintValue(st.fill?.[0], opts.resolver)} options={opts.colors} allowNone onChange={(v) => set(id, `fill:${v}`)} swatch={resolvePaintHex(st.fill?.[0], opts.resolver, mode)} />
          </Row>
        )}
        <Row label={isText || comp ? 'Text color' : 'Color'}>
          <ColorSelect value={paintValue(st.color, opts.resolver)} options={opts.colors} onChange={(v) => set(id, `color:${v}`)} swatch={resolvePaintHex(st.color, opts.resolver, mode)} />
        </Row>
        {!isText && (
          <>
            <Row label="Border">
              <ColorSelect value={paintValue(st.stroke?.paint, opts.resolver)} options={opts.colors} allowNone onChange={(v) => set(id, `stroke:${v}`)} swatch={resolvePaintHex(st.stroke?.paint, opts.resolver, mode)} />
            </Row>
            <Row label="Radius">
              <Select value={Array.isArray(st.radius) ? 'mixed' : lenValue(st.radius, 'radius')} options={opts.radius} placeholder="0" onChange={(v) => set(id, `r${v}`)} />
            </Row>
            <Row label="Shadow">
              <Select value={st.shadow && 'token' in st.shadow ? st.shadow.token.replace('shadow.', '') : ''} options={[{ value: 'none', label: 'none' }, ...opts.shadows]} placeholder="none" onChange={(v) => set(id, `shadow:${v}`)} />
            </Row>
          </>
        )}
        <Row label="Opacity">
          <TextInput value={String(st.opacity ?? 1)} onCommit={(v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n >= 0 && n <= 1) void set(id, `opacity:${n}`);
          }} />
        </Row>
      </Section>
    </div>
  );
}

function uniformPad(p: Padding | undefined): string {
  if (!p) return '';
  const vals = p.map((v) => lenValue(v, 'space'));
  return vals.every((v) => v === vals[0]) ? vals[0]! : '';
}

function DimRow({ axis, dim, id }: { axis: 'w' | 'h'; dim: Dim | undefined; id: string }) {
  const kind = dim?.kind ?? 'auto';
  const px = dim?.kind === 'fixed' && typeof dim.v === 'number' ? String(dim.v) : '';
  return (
    <Row label={axis === 'w' ? 'Width' : 'Height'}>
      <div className="dim">
        <Segmented value={kind === 'auto' ? 'hug' : kind} options={['hug', 'fill', 'fixed']} labels={{ hug: 'Hug', fill: 'Fill', fixed: 'Fixed' }}
          onChange={(v) => (v === 'fixed' ? set(id, `${axis}${px || 100}`) : set(id, `${axis}${v}`))} />
        {kind === 'fixed' && <TextInput value={px} small onCommit={(v) => /^\d+(\.\d+)?$/.test(v) && void set(id, `${axis}${v}`)} />}
      </div>
    </Row>
  );
}

// ------------------------------------------------------------------ rdl / css

function RdlTab({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const doc = getState().doc!;
  const source = useMemo(() => serializeRdl(doc, { roots: [node.id] }), [doc, node.id, version]);
  const [draft, setDraft] = useState(source);
  useEffect(() => setDraft(source), [source]);
  const dirty = draft !== source;
  return (
    <div className="code-tab">
      <textarea className="code" spellCheck={false} value={draft} onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') void rdl(`replace #${node.id}\n${indent(draft)}`, 'edit RDL');
          e.stopPropagation();
        }} />
      <div className="code-actions">
        <span className="hint">{dirty ? 'Ctrl+Enter to apply' : 'Same language your agent writes'}</span>
        <button className="btn" disabled={!dirty} onClick={() => setDraft(source)}>Reset</button>
        <button className="btn btn-primary" disabled={!dirty} onClick={() => void rdl(`replace #${node.id}\n${indent(draft)}`, 'edit RDL')}>Apply</button>
      </div>
    </div>
  );
}

function CssTab({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const doc = getState().doc!;
  const css = useMemo(() => {
    const frag = renderFragment(doc, { roots: [node.id] });
    return frag.css.split('\n').map((r) => r.replace(/\{/, ' {\n  ').replace(/;/g, ';\n  ').replace(/\}$/, '\n}')).join('\n\n');
  }, [doc, node.id, version]);
  return (
    <div className="code-tab">
      <pre className="code code-ro">{css || '/* no styles */'}</pre>
      <div className="code-actions">
        <span className="hint">Generated from tokens · read-only</span>
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(css)}>Copy</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ controls

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="section">
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">{label}</span>
      <div className="row-control">{children}</div>
    </div>
  );
}

function Segmented({ value, options, labels, onChange }: { value: string; options: string[]; labels?: Record<string, string>; onChange: (v: string) => void }) {
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

function Select({ value, options, placeholder, onChange }: { value: string; options: Opt[]; placeholder?: string; onChange: (v: string) => void }) {
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

function ColorSelect({ value, options, onChange, swatch, allowNone }: { value: string; options: Opt[]; onChange: (v: string) => void; swatch?: string; allowNone?: boolean }) {
  return (
    <div className="color-select">
      <span className="swatch" style={{ background: swatch ?? 'transparent' }} data-empty={!swatch} aria-hidden />
      <Select value={value} options={allowNone ? [{ value: 'none', label: 'none' }, ...options] : options} placeholder="inherit" onChange={onChange} />
    </div>
  );
}

function TextInput({ value, onCommit, small }: { value: string; onCommit: (v: string) => void; small?: boolean }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input className={`input${small ? ' input-sm' : ''}`} value={v} onChange={(e) => setV(e.target.value)}
      onBlur={() => v !== value && onCommit(v)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setV(value);
        e.stopPropagation();
      }} />
  );
}
