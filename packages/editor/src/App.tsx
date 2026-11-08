import { useEffect, useState } from 'react';
import { serializeRdl } from '@rangoli/engine';
import { Canvas } from './Canvas';
import { duplicateScript, indent, stripIds } from './helpers';
import { Inspector } from './Inspector';
import { Layers } from './Layers';
import { Activity, LintPanel, TokensPanel } from './Panels';
import { connect, getState, rdl, redo, requestFit, select, setMode, setZoom, undo, useEditor } from './store';

const INSERTS: { key: string; label: string; rdl: string }[] = [
  { key: 'frame', label: 'Frame', rdl: 'Frame col gap3 p4 w320 fill:surface stroke:border r3' },
  { key: 'text', label: 'Text', rdl: 'Text body "Text"' },
  { key: 'button', label: 'Button', rdl: '@Button variant=secondary "Button"' },
  { key: 'chip', label: 'Chip', rdl: '@Chip variant=neutral "Status"' },
  { key: 'input', label: 'Input', rdl: '@Input "Placeholder"' },
];

async function insert(line: string) {
  const s = getState();
  const doc = s.doc;
  if (!doc) return;
  const target = s.selection.length === 1 ? doc.findNode(s.selection[0]!)?.node : undefined;
  const script = !target ? line : target.type === 'frame' || target.type === 'group' ? `insert #${target.id} end\n${indent(line)}` : `insert #${target.id} after\n${indent(line)}`;
  const res = await rdl(script, `insert ${line.split(' ')[0]}`);
  if (res?.created[0]) select([res.created[0]]);
}

function isTyping(e: Event) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return;
      const s = getState();
      const doc = s.doc;
      const mod = e.ctrlKey || e.metaKey;
      const sel = s.selection;
      const one = sel.length === 1 ? doc?.findNode(sel[0]!)?.node : undefined;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? redo() : undo()); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); void redo(); return; }
      if (mod && e.key === '0') { e.preventDefault(); setZoom(1); return; }
      if (e.shiftKey && e.code === 'Digit1') { e.preventDefault(); requestFit(); return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(s.zoom * 1.2); return; }
      if (mod && e.key === '-') { e.preventDefault(); setZoom(s.zoom / 1.2); return; }
      if (!doc) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && sel.length) {
        e.preventDefault();
        void rdl(sel.map((id) => `delete #${id}`).join('\n'), `delete ${sel.length}`).then((r) => r && select([]));
        return;
      }
      if (mod && e.key.toLowerCase() === 'd' && one) {
        e.preventDefault();
        void rdl(duplicateScript(doc, one.id), 'duplicate').then((r) => r?.created[0] && select([r.created[0]]));
        return;
      }
      if (e.key === 'Escape') { select([]); return; }
      if (e.key === 'Enter' && one) {
        e.preventDefault();
        if (e.shiftKey && one.parent) select([one.parent]);
        else if (!e.shiftKey && one.children?.[0]) select([one.children[0]]);
        return;
      }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && one) {
        e.preventDefault();
        const sib = one.parent ? doc.node(one.parent).children ?? [] : doc.page().children;
        const i = sib.indexOf(one.id);
        const other = sib[e.key === 'ArrowUp' ? i - 1 : i + 1];
        if (other) void rdl(`move #${one.id} ${e.key === 'ArrowUp' ? 'before' : 'after'} #${other}`, 'reorder');
      }
    };
    // copy = RDL text (paste it into a chat with your agent, or back into the canvas)
    const onCopy = (e: ClipboardEvent) => {
      if (isTyping(e)) return;
      const s = getState();
      if (!s.doc || !s.selection.length) return;
      e.preventDefault();
      e.clipboardData?.setData('text/plain', stripIds(serializeRdl(s.doc, { roots: s.selection })));
    };
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e)) return;
      const text = e.clipboardData?.getData('text/plain')?.trim();
      if (!text) return;
      e.preventDefault();
      void insert(stripIds(text));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('copy', onCopy);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('paste', onPaste);
    };
  }, []);
}

function Toolbar() {
  const name = useEditor((s) => s.doc?.data.manifest.name ?? '');
  const mode = useEditor((s) => s.mode);
  const zoom = useEditor((s) => s.zoom);
  const connected = useEditor((s) => s.connected);
  const agentActiveAt = useEditor((s) => s.agentActiveAt);
  const [now, setNow] = useState(Date.now());
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const agentActive = now - agentActiveAt < 4000;

  return (
    <header className="toolbar">
      <div className="tb-left">
        <span className="brand" aria-hidden>◈</span>
        <span className="doc-name">{name}</span>
        <div className="menu-wrap">
          <button className="btn" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>Insert ▾</button>
          {menu && (
            <div className="menu" role="menu" onMouseLeave={() => setMenu(false)}>
              {INSERTS.map((i) => (
                <button key={i.key} role="menuitem" className="menu-item" onClick={() => { setMenu(false); void insert(i.rdl); }}>{i.label}</button>
              ))}
            </div>
          )}
        </div>
        <button className="btn btn-icon" title="Undo (Ctrl+Z)" aria-label="Undo" onClick={() => void undo()}>↶</button>
        <button className="btn btn-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" onClick={() => void redo()}>↷</button>
      </div>
      <div className="tb-right">
        {agentActive && <span className="agent-pill" role="status">Agent editing…</span>}
        <div className="seg" role="radiogroup" aria-label="Color mode">
          <button role="radio" aria-checked={mode === 'light'} className="seg-item" onClick={() => setMode('light')}>Light</button>
          <button role="radio" aria-checked={mode === 'dark'} className="seg-item" onClick={() => setMode('dark')}>Dark</button>
        </div>
        <div className="zoom">
          <button className="btn btn-icon" aria-label="Zoom out" onClick={() => setZoom(zoom / 1.2)}>−</button>
          <button className="btn zoom-val" title="Reset zoom (Ctrl+0)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
          <button className="btn btn-icon" aria-label="Zoom in" onClick={() => setZoom(zoom * 1.2)}>+</button>
          <button className="btn" title="Zoom to fit (Shift+1)" onClick={requestFit}>Fit</button>
        </div>
        <span className={`conn ${connected ? 'is-on' : ''}`} title={connected ? 'Live: synced with server and agents' : 'Disconnected — retrying'} role="status" aria-label={connected ? 'Connected' : 'Disconnected'} />
      </div>
    </header>
  );
}

type RightTab = 'inspect' | 'tokens' | 'lint';

export function App() {
  useShortcuts();
  useEffect(connect, []);
  const toastMsg = useEditor((s) => s.toast);
  const lintCount = useEditor((s) => s.lint.filter((i) => i.severity !== 'P3').length);
  const [tab, setTab] = useState<RightTab>('inspect');

  return (
    <div className="app">
      <Toolbar />
      <aside className="left">
        <div className="panel-head">Layers</div>
        <div className="panel-body"><Layers /></div>
        <div className="panel-head">Activity</div>
        <div className="panel-body activity-body"><Activity /></div>
      </aside>
      <main className="center"><Canvas /></main>
      <aside className="right">
        <div className="tabs tabs-top" role="tablist">
          <button role="tab" aria-selected={tab === 'inspect'} className="tab" onClick={() => setTab('inspect')}>Inspect</button>
          <button role="tab" aria-selected={tab === 'tokens'} className="tab" onClick={() => setTab('tokens')}>Tokens</button>
          <button role="tab" aria-selected={tab === 'lint'} className="tab" onClick={() => setTab('lint')}>
            Lint{lintCount > 0 && <span className="count">{lintCount}</span>}
          </button>
        </div>
        <div className="panel-body">
          {tab === 'inspect' && <Inspector />}
          {tab === 'tokens' && <TokensPanel />}
          {tab === 'lint' && <LintPanel />}
        </div>
      </aside>
      {toastMsg && <div className={`toast toast-${toastMsg.kind}`} role="alert">{toastMsg.text}</div>}
    </div>
  );
}
