import { useEffect, useId, useRef, useState } from 'react';
import { Button, IconButton } from './Button';
import { Segmented, Textarea } from './forms';
import { GlyphClose, GlyphNote, GlyphPin, GlyphTask, GlyphWaiting } from './glyphs';
import { canLeave, composerCopy, cx, isLeaveChord, type EntryKind } from './logic';

const KINDS: { value: EntryKind; label: string; icon: React.ReactNode }[] = [
  { value: 'note', label: 'Note', icon: <GlyphNote /> },
  { value: 'task', label: 'Task', icon: <GlyphTask /> },
];

export interface NoteComposerProps {
  /** The frame or layer it pins to, such as "Button / Primary". */
  targetName: string;
  /** Where that sits, such as "Payment, desktop". Omit when pinned to a frame. */
  targetContext?: string;
  /** The connected agent's name, if any. It is only reported, never summoned. */
  connectedAgent?: string | null;
  defaultKind?: EntryKind;
  /** Restores a draft handed back by onClose. */
  initialText?: string;
  /** Unmount the composer on success; the text stays put if this fails. */
  onLeave: (entry: { kind: EntryKind; text: string }) => void;
  /** Receives the unsent text, so the host can keep the draft. */
  onClose: (draft: string) => void;
  busy?: boolean;
  error?: string;
  className?: string;
}

/**
 * Leaves a note or task pinned to the design. It is a form, not a conversation:
 * nothing comes back here, and agents collect entries through the MCP server.
 */
export function NoteComposer({ targetName, targetContext, connectedAgent, defaultKind = 'task', initialText = '', onLeave, onClose, busy, error, className }: NoteComposerProps) {
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [kind, setKind] = useState<EntryKind>(defaultKind);
  const [text, setText] = useState(initialText);
  const copy = composerCopy(kind, connectedAgent);
  const ready = canLeave(text, busy);

  useEffect(() => field.current?.focus({ preventScroll: true }), []);

  const leave = () => { if (ready) onLeave({ kind, text: text.trim() }); };

  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    e.stopPropagation();
    if (isLeaveChord(e)) { e.preventDefault(); leave(); }
    if (e.key === 'Escape') { e.preventDefault(); onClose(text); }
  };

  return (
    <div role="dialog" aria-label="Leave a note or task" className={cx('rg-composer', className)} onKeyDown={onKeyDown}>
      <div className="rg-composer-head">
        <Segmented label="Note or task" value={kind} options={KINDS} onChange={setKind} />
        <IconButton label="Close" icon={<GlyphClose />} onClick={() => onClose(text)} />
      </div>
      <p className="rg-composer-target">
        <span className="rg-btn-icon" aria-hidden><GlyphPin /></span>
        <span>On <strong>{targetName}</strong>{targetContext && <> in {targetContext}</>}</span>
      </p>
      <Textarea ref={field} aria-label={copy.field} aria-describedby={`${id}-hint`} placeholder={copy.placeholder} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} />
      {error && <p role="alert" className="rg-field-error">{error}</p>}
      <p id={`${id}-hint`} className="rg-composer-hint">
        <span className="rg-btn-icon" aria-hidden><GlyphWaiting /></span>
        <span>{copy.hint}</span>
      </p>
      <div className="rg-composer-foot">
        {kind === 'task' && <span className="rg-composer-scope">Any agent</span>}
        <kbd className="rg-kbd">Ctrl+Enter</kbd>
        <Button variant="primary" onClick={leave} disabled={!text.trim()} busy={busy}>{copy.leave}</Button>
      </div>
    </div>
  );
}
