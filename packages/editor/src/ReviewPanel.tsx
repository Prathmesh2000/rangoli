import { useEffect, useRef, useState } from 'react';
import type { Thread } from '@rangoli/engine';
import {
  addThread,
  authorLabel,
  canEdit,
  canReview,
  compareChangeset,
  compareVersion,
  decide,
  getState,
  rdl,
  replyThread,
  resolveThread,
  saveVersion,
  select,
  setAgentMode,
  setMyName,
  suggest,
  useEditor,
} from './store';

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
};

export function ReviewPanel() {
  const role = useEditor((s) => s.role);
  const manage = useEditor((s) => s.can.includes('members.manage'));
  const accept = useEditor((s) => s.can.includes('suggestion.accept'));
  const agentMode = useEditor((s) => s.agentMode);
  const reviews = useEditor((s) => s.reviews);
  const selection = useEditor((s) => s.selection);
  const myName = useEditor((s) => s.myName);
  const compare = useEditor((s) => s.compare);
  const [filter, setFilter] = useState<'open' | 'layer' | 'resolved'>('open');
  const [versionName, setVersionName] = useState('');
  const pending = reviews.changesets.filter((c) => c.status === 'pending');
  const decided = reviews.changesets.filter((c) => c.status !== 'pending').slice(-5).reverse();
  const sel = selection.length === 1 ? selection[0]! : null;
  const threads = reviews.threads
    .filter((t) => t.kind !== 'annotation')
    .filter((t) => (filter === 'resolved' ? t.resolved : !t.resolved))
    .filter((t) => filter !== 'layer' || (sel && t.node === sel))
    .slice()
    .reverse();

  return (
    <div className="review">
      <section className="section">
        <div className="row">
          <span className="row-label">Your name</span>
          <div className="row-control">
            <input className="input" placeholder={role === 'owner' ? 'You (owner)' : 'Add your name'} defaultValue={myName}
              onBlur={(e) => e.currentTarget.value.trim() !== myName && setMyName(e.currentTarget.value.trim())}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation(); }} />
          </div>
        </div>
        <div className="row">
          <span className="row-label">Agent edits</span>
          <div className="row-control">
            <div className="seg" role="radiogroup" aria-label="Agent edit mode">
              {(['direct', 'suggest'] as const).map((m) => (
                <button key={m} role="radio" aria-checked={agentMode === m} className="seg-item" disabled={!manage} onClick={() => agentMode !== m && void setAgentMode(m)}>
                  {m === 'direct' ? 'Apply directly' : 'Ask first'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <p className="hint">{agentMode === 'suggest' ? 'Agent changes arrive below as suggestions for you to accept.' : 'Agent changes apply immediately (undo anytime).'}</p>
      </section>

      <section className="section">
        <h3 className="section-title">Suggestions{pending.length ? ` · ${pending.length}` : ''}</h3>
        {!pending.length && <p className="hint">No pending suggestions.</p>}
        {pending.map((c) => (
          <div key={c.id} className={`cs${compare?.changeset === c.id ? ' is-active' : ''}`}>
            <div className="cs-head">
              <span className="cs-label">{c.label}</span>
              <span className="hint">{authorLabel(c.author)} · {ago(c.time)}</span>
            </div>
            {c.conflict && <p className="cs-conflict">Doesn't apply cleanly anymore: {c.conflict.split('\n')[0]}</p>}
            <details className="cs-script"><summary>RDL</summary><pre className="code code-ro code-sm">{c.script}</pre></details>
            <div className="cs-actions">
              <button className="btn" onClick={() => compareChangeset(c.id)}>Compare</button>
              {accept && <button className="btn" onClick={() => void decide(c.id, 'reject')}>Reject</button>}
              {accept && <button className="btn btn-primary" onClick={() => void decide(c.id, 'accept')}>Accept</button>}
            </div>
          </div>
        ))}
        {decided.length > 0 && (
          <details className="cs-history">
            <summary className="hint">Recent decisions</summary>
            {decided.map((c) => (
              <div key={c.id} className="cs-done"><span className={`badge ${c.status === 'accepted' ? 'badge-ok' : 'badge-bad'}`}>{c.status}</span> {c.label}</div>
            ))}
          </details>
        )}
      </section>

      <section className="section">
        <h3 className="section-title">Comments</h3>
        {canReview() && <Composer node={sel} />}
        <div className="seg seg-sm" role="radiogroup" aria-label="Filter comments">
          <button role="radio" aria-checked={filter === 'open'} className="seg-item" onClick={() => setFilter('open')}>Open</button>
          <button role="radio" aria-checked={filter === 'layer'} className="seg-item" onClick={() => setFilter('layer')} disabled={!sel}>This layer</button>
          <button role="radio" aria-checked={filter === 'resolved'} className="seg-item" onClick={() => setFilter('resolved')}>Resolved</button>
        </div>
        {!threads.length && <p className="hint" style={{ marginTop: 8 }}>{filter === 'resolved' ? 'Nothing resolved yet.' : 'No open comments.'}</p>}
        {threads.map((t) => <ThreadView key={t.id} t={t} />)}
      </section>

      <section className="section">
        <h3 className="section-title">Versions</h3>
        {canEdit() && (
          <form className="brand-row" onSubmit={(e) => { e.preventDefault(); void saveVersion(versionName); setVersionName(''); }}>
            <input className="input" placeholder="Name this version" value={versionName} onChange={(e) => setVersionName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
            <button className="btn" type="submit">Save</button>
          </form>
        )}
        {!reviews.versions.length && <p className="hint">Save a version before big changes to compare later.</p>}
        {reviews.versions.slice().reverse().map((v) => (
          <div key={v.id} className="version">
            <span className="version-name">{v.name}</span>
            <span className="hint">{ago(v.time)}</span>
            <button className="btn btn-sm-inline" onClick={() => void compareVersion(v.id)}>Compare</button>
          </div>
        ))}
      </section>
    </div>
  );
}

function Composer({ node }: { node: string | null }) {
  const [body, setBody] = useState('');
  const submit = () => {
    if (!body.trim()) return;
    void addThread(node, body.trim());
    setBody('');
  };
  return (
    <div className="composer">
      <textarea className="input textarea" rows={2} value={body} placeholder={node ? `Comment on #${node}… (@agent to ask your agent)` : 'Comment on the page… (select a layer to pin it)'}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') submit();
          e.stopPropagation();
        }} />
      <div className="code-actions">
        <span className="hint" style={{ flex: 1 }}>Ctrl+Enter to post</span>
        <button className="btn btn-primary" disabled={!body.trim()} onClick={submit}>Comment</button>
      </div>
    </div>
  );
}

function ThreadView({ t }: { t: Thread }) {
  const focus = useEditor((s) => s.focusThread === t.id);
  const ref = useRef<HTMLDivElement>(null);
  const [reply, setReply] = useState('');
  useEffect(() => {
    if (focus) ref.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focus]);
  const orphan = t.node && !getState().doc?.findNode(t.node);
  return (
    <div ref={ref} className={`thread${focus ? ' is-focus' : ''}${t.kind === 'review' ? ' is-review' : ''}`}>
      <div className="thread-head">
        {t.kind === 'review' && <span className={`sev sev-${t.severity ?? 'P2'}`}>{t.severity ?? 'P2'}</span>}
        {t.node ? (
          <button className="lint-node" disabled={!!orphan} onClick={() => select([t.node!])}>#{t.node}{orphan ? ' (deleted)' : ''}</button>
        ) : (
          <span className="hint">page</span>
        )}
        {t.title && <span className="hint">{t.title}</span>}
      </div>
      {t.comments.map((c) => (
        <div key={c.id} className="comment">
          <span className={`act-who ${c.author.startsWith('agent') ? 'is-agent' : ''}`}>{authorLabel(c.author)}</span>
          <p className="comment-body">{c.body}</p>
          <span className="act-time">{ago(c.time)}</span>
        </div>
      ))}
      {t.fix && (
        <div className="thread-fix">
          <code>{t.fix.split('\n')[0]}{t.fix.includes('\n') ? ' …' : ''}</code>
          {canEdit() ? (
            <button className="btn btn-sm" onClick={() => void rdl(t.fix!, `fix ${t.id}`).then((r) => r && resolveThread(t.id))}>Apply fix</button>
          ) : canReview() ? (
            <button className="btn btn-sm" onClick={() => void suggest(t.fix!, `fix from ${t.id}`)}>Suggest fix</button>
          ) : null}
        </div>
      )}
      {canReview() && (
        <div className="thread-reply">
          <input className="input" placeholder="Reply…" value={reply} onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && reply.trim()) { void replyThread(t.id, reply.trim()); setReply(''); }
              e.stopPropagation();
            }} />
          <button className="btn" onClick={() => void resolveThread(t.id, !t.resolved)}>{t.resolved ? 'Reopen' : 'Resolve'}</button>
        </div>
      )}
    </div>
  );
}
