import { useEffect, useMemo, useState } from 'react';
import { renderFragment, serializeRdl, type RNode } from '@rangoli/engine';
import { indent } from './helpers';
import { getState, rdl, useEditor } from './store';
import { DesignTab } from './DesignTab';
import { MotionTab } from './MotionTab';
import { ProtoTab } from './ProtoTab';

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
