import { useState } from 'react';
import { annotationsOf } from '@rangoli/engine';
import { addAnnotation, canEdit, resolveThread, select, useEditor } from './store';

/** Numbered notes that turn a wireframe into a spec. They sit beside the design, never inside it. */
export function NotesPanel() {
  const reviews = useEditor((s) => s.reviews);
  const selection = useEditor((s) => s.selection);
  const doc = useEditor((s) => s.doc);
  useEditor((s) => s.role);
  const [body, setBody] = useState('');
  const notes = annotationsOf(reviews);
  const target = selection.length === 1 ? doc?.findNode(selection[0]!)?.node : undefined;
  const nameOf = (id: string) => doc?.findNode(id)?.node.name;

  return (
    <div className="notes">
      {canEdit() && (
        <form className="notes-add" onSubmit={(e) => { e.preventDefault(); if (target && body.trim()) void addAnnotation(target.id, body.trim()).then(() => setBody('')); }}>
          <label className="hint" htmlFor="note-body">{target ? `Note on ${target.name}` : 'Select a layer to annotate it'}</label>
          <textarea id="note-body" rows={3} disabled={!target} placeholder="Behaviour, rules, or what happens on click" value={body} onChange={(e) => setBody(e.target.value)} />
          <button className="btn btn-primary" disabled={!target || !body.trim()}>Add note</button>
        </form>
      )}
      {notes.length === 0 && <p className="hint">No notes yet. Numbered notes appear on the canvas and in the printed spec.</p>}
      <ol className="notes-list">
        {notes.map((n) => (
          <li key={n.id}>
            <button className="note-n" aria-label={`Select the layer for note ${n.n}`} onClick={() => select([n.node])}>{n.n}</button>
            <div>
              <p>{n.body}</p>
              <p className="hint">{nameOf(n.node) ?? 'Layer was deleted'}</p>
              {canEdit() && <button className="chip-btn" onClick={() => void resolveThread(n.id)}>Remove</button>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
