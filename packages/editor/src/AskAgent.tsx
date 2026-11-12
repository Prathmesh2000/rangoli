import { useState, type FormEvent } from 'react';
import { WF_DEVICES, type WfDevice } from '@rangoli/engine';
import { ErrorLine, Field, Modal, useAction } from './app/core';
import { askAgent, cancelAgentRequest, select, useEditor } from './store';

const STATUS = { pending: 'Waiting for agent', working: 'Agent is working', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const AGENT_LINE = 'Use the Rangoli agent_requests tool and work through every request.';
const MAX_BYTES = 5 * 1024 * 1024;

/** Rangoli has no model of its own: this queues work for whichever agent is connected over MCP. */
export function AskAgent() {
  const requests = useEditor((s) => s.reviews.requests);
  const online = useEditor((s) => s.presence.some((p) => p.role === 'agent'));
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [device, setDevice] = useState<WfDevice>('desktop');
  const [copied, setCopied] = useState(false);
  const { busy, error, run, setError } = useAction();
  const waiting = requests.filter((r) => r.status === 'pending' || r.status === 'working').length;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (file && file.size > MAX_BYTES) return setError('Use an image under 5 MB.');
    if (await run(() => askAgent(prompt.trim(), file, device))) {
      setPrompt('');
      setFile(null);
    }
  };

  return (
    <>
      <button className="btn" title="Have your connected AI agent build a screen from a description, screenshot or sketch" onClick={() => setOpen(true)}>
        Ask agent{waiting > 0 && <span className="count count-info">{waiting}</span>}
      </button>
      {open && (
        <Modal title="Ask your agent" onClose={() => setOpen(false)}>
          <form className="a-form" onSubmit={(e) => void submit(e)}>
            <Field label="What should it build?"><textarea className="a-input" rows={3} autoFocus placeholder="A settings page with team members and billing" value={prompt} onChange={(e) => setPrompt(e.target.value)} /></Field>
            <Field label="Screenshot or sketch" hint="Optional. PNG, JPEG, WebP or GIF, up to 5 MB."><input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
            <Field label="Device"><select className="a-input" value={device} onChange={(e) => setDevice(e.target.value as WfDevice)}>{Object.entries(WF_DEVICES).map(([id, d]) => <option key={id} value={id}>{d.name}</option>)}</select></Field>
            <ErrorLine error={error} />
            <div className="a-actions" style={{ marginTop: 0 }}>
              <button type="button" className="a-btn" onClick={() => setOpen(false)}>Close</button>
              <button className="a-btn a-btn-primary" disabled={busy || (!prompt.trim() && !file)}>{busy ? 'Sending…' : 'Send to agent'}</button>
            </div>
          </form>
          <p className={online ? 'a-muted' : 'form-error'} role="status">{online ? 'An agent is connected.' : 'No agent is connected. Requests wait here until one is.'}</p>
          {waiting > 0 && (
            <div className="a-reveal">
              <p>Agents act when asked, so tell yours:</p>
              <code className="a-code">{AGENT_LINE}</code>
              <button className="a-btn" onClick={() => void navigator.clipboard.writeText(AGENT_LINE).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
            </div>
          )}
          {requests.length > 0 && (
            <ul className="a-list">
              {requests.slice(-6).reverse().map((r) => (
                <li key={r.id} className="a-row">
                  <div className="a-row-main">
                    <span className="a-truncate">{r.prompt || 'From an image'}</span>
                    <span className="a-muted">{STATUS[r.status]}{r.note ? ` · ${r.note}` : ''}</span>
                  </div>
                  {r.frame && <button className="a-link" onClick={() => { select([r.frame!]); setOpen(false); }}>Show</button>}
                  {(r.status === 'pending' || r.status === 'working') && <button className="a-link a-danger" onClick={() => void cancelAgentRequest(r.id)}>Cancel</button>}
                </li>
              ))}
            </ul>
          )}
        </Modal>
      )}
    </>
  );
}
