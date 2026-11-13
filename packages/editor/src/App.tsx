import { useEffect, useState } from 'react';
import { serializeRdl } from '@rangoli/engine';
import { Canvas, PageBar } from './Canvas';
import { duplicateScript, indent, stripIds } from './helpers';
import { Inspector } from './Inspector';
import { NotesPanel } from './NotesPanel';
import { AskAgent } from './AskAgent';
import { Layers } from './Layers';
import { Activity, LintPanel, TokensPanel } from './Panels';
import { IconStudio } from './IconStudio';
import { AddPanel } from './AddPanel';
import { SceneStudio } from './SceneStudio';
import { RunOverlay, exportHtml } from './Run';
import { SelectionTools, groupSelection, copyStyle, pasteStyle } from './Multi';
import { themesOf } from '@rangoli/engine';
import { DrawTools } from './Draw';
import { actionFor, canvasHasFocus, cycleRegion, isTypingTarget, shortcutLabel, useKeymap, type Action } from './keymap';
import { liveCanvas } from './retained';
import { moveFrames } from './Canvas';
import { ImageStudio } from './ImageStudio';
import { ReviewPanel } from './ReviewPanel';
import { setSkin, api, canEdit, connect, getState, rdl, redo, requestFit, select, setMode, setRightTab, setView, setZoom, undo, useEditor, myClientId, setTool, openAddPanel, setState, activePageId, type Tool } from './store';

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

/** Typing in a field, or editing text in place on the canvas (inside a frame's shadow root). */
const isTyping = isTypingTarget;

const TOOL_OF: Partial<Record<Action, Tool>> = { 'tool.select': 'select', 'tool.frame': 'frame', 'tool.rect': 'rect', 'tool.ellipse': 'ellipse', 'tool.line': 'line', 'tool.pen': 'pen', 'tool.text': 'text' };

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // F6 / Shift+F6 cycle the regions: tool bar, layers, canvas, inspector (works from anywhere)
      if (e.key === 'F6' && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); cycleRegion(e.shiftKey); return; }
      if (isTyping(e)) return;
      const s = getState();
      const doc = s.doc;
      const mod = e.ctrlKey || e.metaKey;
      const sel = s.selection;
      const one = sel.length === 1 ? doc?.findNode(sel[0]!)?.node : undefined;
      const page = doc?.page(activePageId());
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); void (e.shiftKey ? redo() : undo()); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); void redo(); return; }
      if (mod && e.key === '0') { e.preventDefault(); setZoom(1); return; }
      if (e.shiftKey && !mod && e.code === 'Digit1' && canvasHasFocus()) { e.preventDefault(); requestFit(); return; }
      if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(s.zoom * 1.2); return; }
      if (mod && e.key === '-') { e.preventDefault(); setZoom(s.zoom / 1.2); return; }
      if (!doc || !page || s.view !== 'design') return;
      // everything below without a modifier is a single-key shortcut: only while the canvas has focus (WCAG 2.1.4)
      const onCanvas = canvasHasFocus();
      if (!mod && !onCanvas) return;
      // keyboard alternative to the marquee: select every frame, or every layer beside the selection
      if (mod && !e.altKey && e.key.toLowerCase() === 'a' && onCanvas) {
        e.preventDefault();
        const parent = one?.parent ? doc.node(one.parent) : undefined;
        select(parent ? [...(parent.children ?? [])] : [...page.children]);
        return;
      }
      const action = actionFor(e);
      if (action === 'shortcuts') { e.preventDefault(); window.dispatchEvent(new Event('rangoli:shortcuts')); return; }
      if (e.key === 'Escape') { select([]); return; }
      // arrows with nothing selected pan the view (the non-drag path for panning)
      if (!mod && !e.altKey && e.key.startsWith('Arrow') && !sel.length) {
        e.preventDefault();
        const d = e.shiftKey ? 240 : 48;
        window.dispatchEvent(new CustomEvent('rangoli:pan', { detail: { dx: e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy: e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0 } }));
        return;
      }
      if (!canEdit()) return; // viewers and reviewers: navigation only
      if (action === 'add') { e.preventDefault(); openAddPanel(); return; }
      if (mod && e.key.toLowerCase() === 'g' && sel.length) { e.preventDefault(); void groupSelection(); return; }
      if (mod && e.altKey && e.key.toLowerCase() === 'c' && one) { e.preventDefault(); copyStyle(one); return; }
      if (mod && e.altKey && e.key.toLowerCase() === 'v' && sel.length) { e.preventDefault(); void pasteStyle(sel); return; }
      if (action === 'delete' && sel.length) {
        e.preventDefault();
        void rdl(sel.map((id) => `delete #${id}`).join('\n'), `delete ${sel.length}`).then((r) => r && select([]));
        return;
      }
      if (mod && e.key.toLowerCase() === 'd' && one) {
        e.preventDefault();
        void rdl(duplicateScript(doc, one.id), 'duplicate').then((r) => r?.created[0] && select([r.created[0]]));
        return;
      }
      if (action && TOOL_OF[action]) { setTool(TOOL_OF[action]!); return; }
      // arrow keys move top-level frames (the non-drag path for placing frames) and free-floating layers
      if (!mod && !e.altKey && e.key.startsWith('Arrow') && sel.length) {
        const d = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0, dy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        const frames = sel.filter((id) => page.nodes[id] && !page.nodes[id]!.parent);
        const c = liveCanvas();
        if (frames.length === sel.length && c) { e.preventDefault(); void moveFrames(c, frames, dx, dy); return; }
        if (one?.position && (one.absolute || (one.parent && doc.node(one.parent).layout?.mode === 'none'))) {
          e.preventDefault();
          void rdl(`set #${one.id} at:${one.position.x + dx},${one.position.y + dy}`, 'nudge');
        }
        return;
      }
      if (action === 'edit' && one && !e.shiftKey) {
        e.preventDefault();
        if (one.type === 'text') window.dispatchEvent(new CustomEvent('rangoli:edit-text', { detail: one.id }));
        else if (one.children?.[0]) select([one.children[0]]);
        return;
      }
      if (e.key === 'Enter' && e.shiftKey && one?.parent) { e.preventDefault(); select([one.parent]); return; }
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && one) {
        e.preventDefault();
        const sib = one.parent ? doc.node(one.parent).children ?? [] : page.children;
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
  const leftTab = useEditor((s) => s.leftTab);
  const docTokens = useEditor((s) => s.doc?.data.tokens);
  const themes = docTokens ? themesOf(docTokens) : {};
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);
  const agentActive = now - agentActiveAt < 4000;
  const role = useEditor((s) => s.role);
  const hosted = useEditor((s) => s.hosted);
  const locked = useEditor((s) => s.locked);
  const skin = useEditor((s) => s.skin);
  const layoutGrid = useEditor((s) => s.layoutGrid);
  const presence = useEditor((s) => s.presence);
  const others = presence.filter((p) => p.clientId !== myClientId);
  const view = useEditor((s) => s.view);
  const editable = useEditor((s) => s.can.includes('design.edit') && !s.activePage) && view === 'design';
  useKeymap();

  return (
    <header className="toolbar" data-region="toolbar" aria-label="Tool bar" tabIndex={-1}>
      <div className="tb-left">
        {hosted ? <a className="btn" href={`/p/${hosted.projectId}/${hosted.stage}`}>← Journey</a> : <span className="brand" aria-hidden>◈</span>}
        <span className="doc-name">{name}</span>
        {!hosted && role !== 'owner' && <span className="role-badge" title="Your access in this session">{role}</span>}
        {locked && <span className="role-badge" title={locked}>Read only</span>}
        <div className="seg" role="radiogroup" aria-label="Workspace">
          <button role="radio" aria-checked={view === 'design'} className="seg-item" onClick={() => setView('design')}>Design</button>
          <button role="radio" aria-checked={view === 'icons'} className="seg-item" onClick={() => setView('icons')}>Icons</button>
          <button role="radio" aria-checked={view === 'images'} className="seg-item" onClick={() => setView('images')}>Images</button>
          <button role="radio" aria-checked={view === '3d'} className="seg-item" onClick={() => setView('3d')}>3D</button>
        </div>
        {editable && <AskAgent />}
        {editable && <button className="btn" aria-pressed={leftTab === 'add'} title={`Add components, patterns and 3D${shortcutLabel('add') ? ` (${shortcutLabel('add')}, on the canvas)` : ''}`} onClick={openAddPanel}>+ Add</button>}
        {editable && <button className="btn btn-icon" title="Undo (Ctrl+Z)" aria-label="Undo" onClick={() => void undo()}>↶</button>}
        {editable && <button className="btn btn-icon" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" onClick={() => void redo()}>↷</button>}
      </div>
      <div className="tb-right">
        {view === 'design' && <button className="btn" title="Run the page with its 3D and JavaScript" onClick={() => setState({ running: true })}>Run</button>}
        {view === 'design' && <button className="btn" title="Download one HTML file with CSS and JavaScript" onClick={exportHtml}>Export</button>}
        {view === 'design' && (
          <div className="seg" role="radiogroup" aria-label="Fidelity">
            {([['none', 'Hi-fi'], ['clean', 'Wireframe'], ['sketch', 'Sketch']] as const).map(([id, label]) => <button key={id} role="radio" aria-checked={skin === id} className="seg-item" onClick={() => setSkin(id)}>{label}</button>)}
          </div>
        )}
        {view === 'design' && <button className="btn" aria-pressed={layoutGrid} title="Show a 12-column grid on each frame" onClick={() => setState({ layoutGrid: !layoutGrid })}>Grid</button>}
        <button className="btn btn-play" title="Play the clickable prototype in a new tab" onClick={() => window.open(api(skin === 'none' ? '/play' : `/play?skin=${skin}`), '_blank', 'noopener')}>▶ Play</button>
        {agentActive && <span className="agent-pill" role="status">Agent editing…</span>}
        {others.length > 0 && (
          <div className="presence" aria-label="People in this session">
            {others.slice(0, 4).map((p) => (
              <span key={p.clientId} className={`who${p.role === 'agent' ? ' who-agent' : ''}`} title={`${p.name} · ${p.role}${p.selection.length ? ` · on #${p.selection[0]}` : ''}`}>
                {p.role === 'agent' ? 'Agent' : p.name || p.role}
              </span>
            ))}
            {others.length > 4 && <span className="who">+{others.length - 4}</span>}
          </div>
        )}
        <select className="input theme-select" aria-label="Theme" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
          {Object.entries(themes).map(([id, t]) => <option key={id} value={id}>{t.name}</option>)}
        </select>
        {view === 'design' && (
          <div className="zoom">
            <button className="btn btn-icon" aria-label="Zoom out" onClick={() => setZoom(zoom / 1.2)}>−</button>
            <button className="btn zoom-val" title="Reset zoom (Ctrl+0)" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
            <button className="btn btn-icon" aria-label="Zoom in" onClick={() => setZoom(zoom * 1.2)}>+</button>
            <button className="btn" title="Zoom to fit (Shift+1)" onClick={requestFit}>Fit</button>
            <button className="btn" title={`Keyboard shortcuts${shortcutLabel('shortcuts') ? ` (${shortcutLabel('shortcuts')})` : ''}`} onClick={() => window.dispatchEvent(new Event('rangoli:shortcuts'))}>Keys</button>
          </div>
        )}
        <span className={`conn ${connected ? 'is-on' : ''}`} title={connected ? 'Live: synced with server and agents' : 'Disconnected — retrying'} role="status" aria-label={connected ? 'Connected' : 'Disconnected'} />
      </div>
    </header>
  );
}

export function App() {
  useShortcuts();
  useEffect(connect, []);
  const toastMsg = useEditor((s) => s.toast);
  const lintCount = useEditor((s) => s.lint.filter((i) => i.severity !== 'P3').length);
  const reviewCount = useEditor((s) => s.reviews.threads.filter((t) => !t.resolved && t.kind !== 'annotation').length + s.reviews.changesets.filter((c) => c.status === 'pending').length);
  const leftTab = useEditor((s) => s.leftTab);
  const tab = useEditor((s) => s.rightTab);
  const setTab = (t: typeof tab) => setRightTab(t);

  const view = useEditor((s) => s.view);
  if (view !== 'design') {
    return (
      <div className="app">
        <Toolbar />
        {view === 'icons' ? <IconStudio /> : view === '3d' ? <SceneStudio /> : <ImageStudio />}
        {toastMsg && <div className={`toast toast-${toastMsg.kind}`} role="alert">{toastMsg.text}</div>}
      </div>
    );
  }

  return (
    <div className="app">
      <Toolbar />
      <aside className="left" data-region="layers" aria-label="Layers" tabIndex={-1}>
        <div className="tabs tabs-top" role="tablist">
          <button role="tab" aria-selected={leftTab === 'layers'} className="tab" onClick={() => setState({ leftTab: 'layers' })}>Layers</button>
          <button role="tab" aria-selected={leftTab === 'add'} className="tab" onClick={openAddPanel}>Add</button>
        </div>
        {leftTab === 'add' ? <AddPanel /> : (
          <>
            <div className="panel-body"><Layers /></div>
            <div className="panel-head">Activity</div>
            <div className="panel-body activity-body"><Activity /></div>
          </>
        )}
      </aside>
      <main className="center"><Canvas /><DrawTools /><SelectionTools /><PageBar /></main>
      <RunOverlay />
      <aside className="right" data-region="inspector" aria-label="Inspector" tabIndex={-1}>
        <div className="tabs tabs-top" role="tablist">
          <button role="tab" aria-selected={tab === 'inspect'} className="tab" onClick={() => setTab('inspect')}>Inspect</button>
          <button role="tab" aria-selected={tab === 'review'} className="tab" onClick={() => setTab('review')}>
            Review{reviewCount > 0 && <span className="count count-info">{reviewCount}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'notes'} className="tab" onClick={() => setTab('notes')}>Notes</button>
          <button role="tab" aria-selected={tab === 'tokens'} className="tab" onClick={() => setTab('tokens')}>Tokens</button>
          <button role="tab" aria-selected={tab === 'lint'} className="tab" onClick={() => setTab('lint')}>
            Lint{lintCount > 0 && <span className="count">{lintCount}</span>}
          </button>
        </div>
        <div className="panel-body">
          {tab === 'inspect' && <Inspector />}
          {tab === 'review' && <ReviewPanel />}
          {tab === 'notes' && <NotesPanel />}
          {tab === 'tokens' && <TokensPanel />}
          {tab === 'lint' && <LintPanel />}
        </div>
      </aside>
      {toastMsg && <div className={`toast toast-${toastMsg.kind}`} role="alert">{toastMsg.text}</div>}
    </div>
  );
}
