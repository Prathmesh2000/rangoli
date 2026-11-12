import { useEffect, useMemo, useRef, useState } from 'react';
import { fontHead, renderCss, renderDocument, renderFragment, type RNode } from '@rangoli/engine';
import { Area, Select, Segmented, setFlags as set } from './controls';
import { SNIPPETS } from './snippets';
import { api, getState, setState, useEditor } from './store';

const assetUrl = (m: { file: string }) => `${location.origin}${api(`/assets/${m.file}`)}`;
const pageHtml = () => renderDocument(getState().doc!, { mode: getState().mode, assetUrl, scripts: true });
/** Reports script messages and errors to the Run view (the frame cannot reach anything else). */
const CONSOLE = `<script>(function(){var send=function(l,a){try{parent.postMessage({rangoliLog:l,text:Array.prototype.map.call(a,function(x){try{return x&&x.stack?String(x.stack):typeof x==='object'?JSON.stringify(x):String(x)}catch(e){return String(x)}}).join(' ').slice(0,2000)},'*')}catch(e){}};['log','warn','error'].forEach(function(l){var o=console[l];console[l]=function(){send(l,arguments);o.apply(console,arguments)}});addEventListener('error',function(e){send('error',[e.message])});addEventListener('unhandledrejection',function(e){send('error',[e.reason])})})();</script>`;

function download(name: string, text: string, type: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

export function exportHtml() {
  const doc = getState().doc!;
  download(`${doc.data.manifest.name.replace(/[^\w-]+/g, '-') || 'page'}.html`, pageHtml(), 'text/html');
}

/**
 * Runs the page with its 3D and JavaScript. The iframe is sandboxed without same-origin, so a script
 * in a shared document can never reach the editor, the server or anyone's session.
 */
export function RunOverlay() {
  const running = useEditor((s) => s.running);
  const [width, setWidth] = useState('100%');
  const version = useEditor((s) => s.version);
  const html = useMemo(() => (running ? pageHtml().replace('<head>', `<head>${CONSOLE}`) : ''), [running, version]);
  const frame = useRef<HTMLIFrameElement>(null);
  const [logs, setLogs] = useState<{ level: string; text: string }[]>([]);
  const [showLog, setShowLog] = useState(false);
  useEffect(() => { setLogs([]); }, [html]);
  useEffect(() => {
    const on = (e: MessageEvent) => { if (e.source === frame.current?.contentWindow && e.data?.rangoliLog) setLogs((l) => [...l.slice(-199), { level: String(e.data.rangoliLog), text: String(e.data.text) }]); };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);
  const errors = logs.filter((l) => l.level === 'error').length;
  if (!running) return null;
  return (
    <div className="run-overlay" role="dialog" aria-label="Running page">
      <div className="run-bar">
        <strong>{getState().doc?.data.manifest.name}</strong>
        <span className="hint">Live page with 3D and JavaScript, isolated from the editor</span>
        <Segmented value={width} options={['100%', '768px', '390px']} labels={{ '100%': 'Desktop', '768px': 'Tablet', '390px': 'Phone' }} onChange={setWidth} />
        <button className="btn" aria-expanded={showLog} onClick={() => setShowLog(!showLog)}>Console{logs.length ? ` (${logs.length}${errors ? `, ${errors} error${errors > 1 ? 's' : ''}` : ''})` : ''}</button>
        <button className="btn btn-primary" onClick={() => setState({ running: false })}>Close</button>
      </div>
      <iframe ref={frame} className="run-frame" style={{ maxWidth: width }} title="Running page" sandbox="allow-scripts" srcDoc={html} />
      {showLog && <pre className="run-log" role="log" aria-label="Console">{logs.length ? logs.map((l, i) => <div key={i} className={`log-${l.level}`}>{l.text}</div>) : 'Nothing logged yet.'}</pre>}
    </div>
  );
}

export function CodeTab({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const doc = getState().doc!;
  const [lang, setLang] = useState<'html' | 'css' | 'js'>('html');
  const code = useMemo(() => {
    const frag = renderFragment(doc, { roots: [node.id] });
    const css = [...fontHead(doc).links.map((l) => `@import url("${l}");`), frag.css.split('\n').map((r) => r.replace(/\{/, ' {\n  ').replace(/;/g, ';\n  ').replace(/\}$/, '\n}')).join('\n\n')].join('\n');
    return { html: frag.html.replace(/></g, '>\n<'), css, full: renderCss(doc, frag.css, frag.usedComponents), js: frag.js ?? '' };
  }, [doc, node.id, version]);
  const text = lang === 'html' ? code.html : lang === 'css' ? code.css : code.js;
  return (
    <div className="code-tab">
      <div className="code-actions">
        <Segmented value={lang} options={['html', 'css', 'js']} labels={{ html: 'HTML', css: 'CSS', js: 'JavaScript' }} onChange={(v) => setLang(v as typeof lang)} />
      </div>
      {lang === 'js' ? (
        <div className="code-pane">
          <Select value="" placeholder="Start from a snippet…" options={SNIPPETS.map((s) => ({ value: s.name, label: `${s.name}: ${s.hint}` }))} onChange={(v) => void set(node.id, `script:${JSON.stringify(SNIPPETS.find((s) => s.name === v)!.code)}`, `script: ${v}`)} />
          <Area key={`${node.id}-${node.script?.length ?? 0}`} value={node.script ?? ''} code rows={14} label="JavaScript for this layer" placeholder={'// `el` is this layer\nel.addEventListener("click", () => {\n  el.style.opacity = 0.5;\n});'}
            onCommit={(v) => set(node.id, v ? `script:${JSON.stringify(v)}` : 'unset:script', 'JavaScript')} />
          <div className="code-actions">
            <span className="hint">Runs on exported pages and in Run, never in the editor.</span>
            <button className="btn btn-primary" onClick={() => setState({ running: true })}>Run</button>
          </div>
        </div>
      ) : <pre className="code code-ro">{text || `/* no ${lang} */`}</pre>}
      <div className="code-actions">
        <span className="hint">Generated from your design</span>
        <button className="btn" onClick={() => void navigator.clipboard?.writeText(lang === 'js' ? code.js : text)}>Copy</button>
        <button className="btn" onClick={() => download(`${node.name.replace(/[^\w-]+/g, '-') || 'layer'}.${lang}`, lang === 'css' ? code.full : lang === 'js' ? code.js : code.html, 'text/plain')}>Download</button>
      </div>
    </div>
  );
}
