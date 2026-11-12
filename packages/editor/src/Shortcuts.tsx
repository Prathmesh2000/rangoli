import { useEffect, useRef, useState } from 'react';
import { ACTIONS, clearKeys, conflictFor, keyLabel, keysFor, normalizeKey, remap, RESERVED_KEYS, resetKeys, useKeymap, type Action } from './keymap';

/** Fixed shortcuts, shown for reference: they use a modifier or are navigation keys. */
const FIXED: [string, string][] = [
  ['F6 / Shift+F6', 'Move to the next or previous region'],
  ['Arrow keys', 'Move the selected frame or free layer by 1 (Shift: 10); with nothing selected, pan'],
  ['Ctrl+A', 'Select every frame on the page, or every layer beside the selected one'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
  ['Ctrl+D', 'Duplicate'],
  ['Ctrl+G', 'Group'],
  ['Ctrl + / Ctrl − / Ctrl+0', 'Zoom in, out, 100%'],
  ['Shift+1', 'Zoom to fit'],
  ['Shift+Enter', 'Select the parent layer'],
  ['Escape', 'Clear the selection, or leave text editing'],
];

/** Keyboard shortcuts: every single-key shortcut can be changed or turned off (WCAG 2.1.4). */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  useKeymap();
  const ref = useRef<HTMLDialogElement>(null);
  const [listening, setListening] = useState<Action | null>(null);
  const [note, setNote] = useState('');
  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  useEffect(() => {
    if (!listening) return;
    const key = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setListening(null); setNote('Kept the old key.'); return; }
      if (e.ctrlKey || e.metaKey || e.altKey) { setNote('Use a single key without Ctrl, Cmd or Alt.'); return; }
      const k = normalizeKey(e.key);
      if (RESERVED_KEYS.has(k)) { setNote(`${keyLabel(k)} is kept for moving around. Pick another key.`); return; }
      const taken = conflictFor(k, listening);
      remap(listening, k);
      setNote(`${ACTIONS.find((a) => a.id === listening)!.label}: ${keyLabel(k)}.${taken ? ` Removed it from ${ACTIONS.find((a) => a.id === taken)!.label.toLowerCase()}.` : ''}`);
      setListening(null);
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [listening]);
  return (
    <dialog ref={ref} className="keys-dialog" aria-labelledby="keys-title" onClose={onClose} onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <div className="keys-head">
        <h2 id="keys-title">Keyboard shortcuts</h2>
        <button className="btn" onClick={onClose}>Close</button>
      </div>
      <p className="hint">Single keys work only while the canvas has focus. Change or turn off any of them.</p>
      <table className="keys-table">
        <thead><tr><th scope="col">Action</th><th scope="col">Key</th><th scope="col"><span className="sr-only">Change</span></th></tr></thead>
        <tbody>
          {ACTIONS.map((a) => {
            const ks = keysFor(a.id);
            return (
              <tr key={a.id}>
                <th scope="row">{a.label}</th>
                <td>{listening === a.id ? <em>Press a key…</em> : ks.length ? ks.map((k) => <kbd key={k}>{keyLabel(k)}</kbd>) : <span className="hint">Off</span>}</td>
                <td className="keys-actions">
                  <button className="btn" aria-label={`Change the key for ${a.label}`} onClick={() => { setNote(''); setListening(a.id); }}>Change</button>
                  <button className="btn" aria-label={`Turn off the key for ${a.label}`} disabled={!ks.length} onClick={() => { clearKeys(a.id); setNote(`${a.label}: off.`); }}>Off</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint" role="status" aria-live="polite">{note}</p>
      <button className="btn" onClick={() => { resetKeys(); setNote('All keys reset.'); }}>Reset to defaults</button>
      <h3 className="keys-sub">Always available</h3>
      <dl className="keys-fixed">
        {FIXED.map(([k, v]) => <div key={k}><dt><kbd>{k}</kbd></dt><dd>{v}</dd></div>)}
      </dl>
    </dialog>
  );
}
