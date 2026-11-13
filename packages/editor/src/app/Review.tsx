/**
 * Review and release: approvals bound to snapshots, "Changed since approved", share links, releases and fixes.
 * A minimal page in the existing look; the new interface replaces it later.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { kolam, type Check, type SignoffState } from '@rangoli/engine';
import { TopBar, StepUp } from './Shell';
import { ago, ApiError, del, ErrorLine, Failed, Field, get, Link, Loading, Modal, post, useAction, useLoad, type Me } from './core';

interface Decision { id: string; approver: string; approver_name: string; decision: 'approved' | 'changes_requested'; note: string; exceptions: { check: string; label: string; note: string }[]; mfa_at: string | null; via: 'app' | 'link'; created_at: string }
interface Approval { id: string; snapshot_id: string; snapshot_name: string; content_hash: string; cycle: number; stage: string; rule: 'any' | 'all'; approvers: string[]; approverNames: string[]; note: string; requested_by: string | null; requested_by_name: string; withdrawn_at: string | null; created_at: string; status: 'open' | 'approved' | 'changes_requested' | 'withdrawn'; decisions: Decision[] }
interface Snapshot { id: string; name: string; kind: string; cycle: number; stage: string; content_hash: string; canon_version: string; engine_version: string; created_by_name: string; created_at: string; status: string | null }
interface ScreenChange { key: string; screenId: string | null; name: string; device: string | null; hash: string; approvedHash: string | null; changed: boolean; added: boolean }
interface ShareLink { id: string; snapshot_id: string; kind: 'stakeholder' | 'developer'; label: string; expires_at: string; revoked_at: string | null; created_at: string; live: boolean }
interface Release { id: string; snapshot_id: string; snapshot_name: string; content_hash: string; basis: 'approval' | 'exception' | 'solo' | 'unapproved'; notes: string; checklist: { label: string; done: boolean }[]; released_by_name: string; fix_id: string | null; created_at: string }
interface Fix { id: string; release_id: string; snapshot_id: string; frame_node: string; before_hash: string; note: string; created_by_name: string; created_at: string; released: boolean }

export interface ReviewData {
  me: string;
  can: string[];
  solo: boolean;
  strict: boolean;
  project: { id: string; name: string; stage: string; cycle: number };
  stage: { id: string; name: string; checks: Check[]; signoff: SignoffState };
  handoffChecks: Check[];
  latestApproved: (Snapshot & { approvedBy: { name: string; at: string }[] }) | null;
  changes: { screens: ScreenChange[]; removed: { key: string; name: string }[] };
  current: { contentHash: string; warnings: string[] };
  approvals: Approval[];
  snapshots: Snapshot[];
  shareLinks: ShareLink[];
  releases: Release[];
  fixes: Fix[];
  approvers: { id: string; name: string }[];
}

const short = (h: string) => h.slice(0, 12);
const Tag = ({ children, tone }: { children: ReactNode; tone?: string }) => <span className={`tag${tone ? ` tag-${tone}` : ''}`}>{children}</span>;
const STATUS: Record<Approval['status'], [string, string | undefined]> = { open: ['Waiting', 'warn'], approved: ['Approved', 'ok'], changes_requested: ['Changes requested', 'bad'], withdrawn: ['Withdrawn', undefined] };
const BASIS: Record<Release['basis'], string> = { approval: 'Approved and released', exception: 'Released on an accepted exception', solo: 'Released by', unapproved: 'Released without approval' };

/** The kolam seal of a content hash. Decorative: the hash beside it is the proof. */
export function Seal({ hash, size = 40 }: { hash: string; size?: number }) {
  const k = useMemo(() => kolam(hash), [hash]);
  return (
    <svg width={size} height={size} viewBox={k.viewBox} role="img" aria-label={`Seal of ${short(hash)}`} style={{ color: 'var(--accent, #7a3e9d)', flex: 'none' }}>
      <g fill="currentColor" opacity={0.45}>{k.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={1.6} />)}</g>
      <path d={k.path} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" />
    </svg>
  );
}

/** Runs a decision, asking for a fresh second factor (or pointing to MFA setup) when the server wants one. */
function useStepUp() {
  const [kind, setKind] = useState<'password' | 'mfa' | null>(null);
  const [retry, setRetry] = useState<(() => Promise<void>) | null>(null);
  const { busy, error, run, setError } = useAction();
  const attempt = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      if (e instanceof ApiError && (e.extra.stepUp === 'mfa' || e.extra.stepUp === 'password')) {
        setKind(e.extra.stepUp);
        setRetry(() => async () => { await run(fn); });
      } else if (e instanceof ApiError && e.extra.mfaSetup) {
        setError('Approvers need two-step sign-in. Turn it on in Security (your account menu), then decide again.');
      } else setError(e instanceof Error ? e.message : 'That did not work.');
      return false;
    }
  };
  const prompt = kind ? <StepUp kind={kind} onCancel={() => setKind(null)} onDone={() => { setKind(null); void retry?.(); }} /> : null;
  return { attempt, prompt, busy, error };
}

function Decide({ r, a, reload }: { r: ReviewData; a: Approval; reload: () => Promise<void> }) {
  const open = r.stage.checks.filter((c) => !c.ok);
  const [mode, setMode] = useState<'approved' | 'changes_requested' | null>(null);
  const [note, setNote] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const s = useStepUp();
  const via = new URLSearchParams(location.search).get('approval') === a.id ? 'link' : 'app';
  const send = () => s.attempt(async () => {
    await post(`/api/projects/${r.project.id}/approvals/${a.id}/decisions`, { decision: mode, note, via, exceptions: open.map((c) => ({ check: c.id, note: notes[c.id] ?? '' })) });
    setMode(null);
    await reload();
  });
  if (!mode) return (
    <div className="a-inline">
      <button className="a-btn a-btn-primary" onClick={() => setMode('approved')}>Approve this version</button>
      <button className="a-btn" onClick={() => setMode('changes_requested')}>Request changes</button>
    </div>
  );
  return (
    <form className="a-form" onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <p className="a-muted">You are deciding on snapshot <code>{short(a.content_hash)}</code>, not on later edits. You will confirm it is you with your authenticator.</p>
      {mode === 'approved' && open.length > 0 && (
        <fieldset className="a-fieldset">
          <legend className="a-label">Open checks become exceptions. Accept each with a note.</legend>
          {open.map((c) => <Field key={c.id} label={c.label}><input className="a-input" value={notes[c.id] ?? ''} placeholder="Why it is acceptable (or leave it to the note below)" onChange={(e) => setNotes({ ...notes, [c.id]: e.target.value })} /></Field>)}
        </fieldset>
      )}
      <Field label={mode === 'approved' ? 'Note' : 'What needs to change?'}><textarea className="a-input" rows={3} required={mode === 'changes_requested'} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      {s.prompt}
      <ErrorLine error={s.error} />
      <div className="a-actions">
        <button type="button" className="a-btn" onClick={() => setMode(null)}>Cancel</button>
        <button className="a-btn a-btn-primary" disabled={s.busy}>{mode === 'approved' ? 'Approve' : 'Send to designer'}</button>
      </div>
    </form>
  );
}

function Approvals({ r, reload }: { r: ReviewData; reload: () => Promise<void> }) {
  const highlight = new URLSearchParams(location.search).get('approval');
  const current = r.approvals.find((a) => a.stage === r.project.stage && a.cycle === r.project.cycle && (a.status === 'open' || a.status === 'changes_requested'));
  const canDecide = (a: Approval) => a === current && a.requested_by !== r.me && r.can.includes('approve') && (!a.approvers.length || a.approvers.includes(r.me)) && !r.solo;
  return (
    <section className="work-section">
      <div className="work-head"><div><h2 className="a-h2">Approvals</h2><p className="a-muted">Each decision is on one saved version. Nobody approves their own review, whatever their role.</p></div></div>
      {r.approvals.length === 0 && <p className="work-empty">{r.solo ? 'A one-person organization releases instead of approving.' : 'No reviews yet. Request one from the stage view, or below.'}</p>}
      <ul className="work-list">
        {r.approvals.map((a) => (
          <li key={a.id} className="work-item" style={a.id === highlight ? { outline: '2px solid var(--accent, #7a3e9d)' } : undefined}>
            <Seal hash={a.content_hash} />
            <div className="work-main">
              <span className="a-row-title">{a.snapshot_name} <Tag tone={STATUS[a.status][1]}>{STATUS[a.status][0]}</Tag></span>
              <p className="a-muted a-small">Asked by {a.requested_by_name || 'a former member'} {ago(a.created_at)} · {a.approvers.length ? `${a.rule === 'all' ? 'all of' : 'any of'} ${a.approverNames.join(', ')}` : 'any approver'} · <code>{short(a.content_hash)}</code></p>
              {a.note && <p className="work-body">{a.note}</p>}
              <ul className="gate-signoffs">
                {a.decisions.map((d) => (
                  <li key={d.id} className={d.decision === 'approved' ? 'is-ok' : 'is-bad'}>
                    <strong>{d.approver_name}</strong> {d.decision === 'approved' ? 'approved' : 'requested changes'} <span className="a-muted">{ago(d.created_at)}{d.mfa_at ? ' · confirmed with MFA' : ''}{d.via === 'link' ? ' · from a shared link' : ''}</span>
                    {d.note && <p>{d.note}</p>}
                    {d.exceptions.length > 0 && <ul className="a-small">{d.exceptions.map((e) => <li key={e.check}>Exception: {e.label}. {e.note}</li>)}</ul>}
                  </li>
                ))}
              </ul>
              {canDecide(a) && <Decide r={r} a={a} reload={reload} />}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RequestReview({ r, reload }: { r: ReviewData; reload: () => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [rule, setRule] = useState<'any' | 'all'>('any');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const s = r.stage.signoff;
  if (!r.can.includes('design.edit') || !s.required || s.status === 'in_review' || s.status === 'approved' || r.solo) return null;
  return (
    <section className="work-section">
      <h2 className="a-h2">Request review of {r.stage.name}</h2>
      <p className="a-muted">The design is saved as a snapshot now and the decision is on that version. You can keep editing.</p>
      <form className="a-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`/api/projects/${r.project.id}/review/request`, { note, approvers: picked, rule: picked.length ? rule : 'any' }); setNote(''); setPicked([]); await reload(); }); }}>
        <fieldset className="a-fieldset">
          <legend className="a-label">Approvers (none picked: any approver on the project)</legend>
          {r.approvers.map((p) => <label key={p.id} className="a-radio"><input type="checkbox" checked={picked.includes(p.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.id] : picked.filter((x) => x !== p.id))} /><span>{p.name}</span></label>)}
        </fieldset>
        {picked.length > 1 && <Field label="Needs"><select className="a-input" value={rule} onChange={(e) => setRule(e.target.value as 'any' | 'all')}><option value="any">Any one of them</option><option value="all">All of them</option></select></Field>}
        <Field label="Note for the reviewers"><textarea className="a-input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <div className="a-actions"><button className="a-btn a-btn-primary" disabled={busy}>Request review</button></div>
      </form>
    </section>
  );
}

function Changes({ r }: { r: ReviewData }) {
  const a = r.latestApproved;
  const changed = r.changes.screens.filter((s) => s.changed);
  return (
    <section className="work-section">
      <div className="work-head">
        <div>
          <h2 className="a-h2">Approved version</h2>
          {a ? <p className="a-muted">{a.name}, approved by {a.approvedBy.map((x) => x.name).join(', ') || 'a former member'}. Handoff, developer links and exports use it unless you pick another.</p>
            : <p className="a-muted">Nothing is approved yet. Handoff and exports from the working copy are marked Unapproved.</p>}
        </div>
        {a && <Seal hash={a.content_hash} size={56} />}
      </div>
      {a && <p className="a-small">Content hash <code>{a.content_hash}</code> · {a.canon_version} · {a.engine_version}</p>}
      {a && <Verify projectId={r.project.id} snapshotId={a.id} />}
      {a && (
        <ul className="work-list">
          {r.changes.screens.map((s) => (
            <li key={s.key} className="work-item">
              <div className="work-main"><span className="a-row-title">{s.name}</span>{s.device && <span className="a-muted a-small"> · {s.device}</span>}</div>
              <div className="work-meta">{s.added ? <Tag tone="warn">New since approved</Tag> : s.changed ? <Tag tone="warn">Changed since approved</Tag> : <Tag tone="ok">As approved</Tag>}</div>
            </li>
          ))}
          {r.changes.removed.map((s) => <li key={s.key} className="work-item"><div className="work-main"><span className="a-row-title">{s.name}</span></div><div className="work-meta"><Tag tone="bad">Removed since approved</Tag></div></li>)}
        </ul>
      )}
      {a && changed.length === 0 && r.changes.removed.length === 0 && <p className="a-muted">Every screen is as approved.</p>}
      {r.current.warnings.map((w) => <p key={w} className="gate-note">{w}</p>)}
    </section>
  );
}

function Verify({ projectId, snapshotId }: { projectId: string; snapshotId: string }) {
  const [result, setResult] = useState<{ intact: boolean; signed: boolean } | null>(null);
  const { busy, error, run } = useAction();
  return (
    <div className="a-inline">
      <button className="a-link" disabled={busy} onClick={() => void run(async () => setResult(await get(`/api/projects/${projectId}/snapshots/${snapshotId}/verify`)))}>Verify hashes and signature</button>
      {result && <span className={result.intact && result.signed ? 'perm-yes' : 'perm-no'}>{result.intact ? 'Hashes match' : 'Hashes do not match'} · {result.signed ? 'signature valid' : 'signature not valid'}</span>}
      <ErrorLine error={error} />
    </div>
  );
}

function Snapshots({ r, reload }: { r: ReviewData; reload: () => Promise<void> }) {
  const [shared, setShared] = useState<string | null>(null);
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  const base = `/api/projects/${r.project.id}`;
  const share = (id: string, kind: 'stakeholder' | 'developer') => run(async () => setShared((await post<{ url: string }>(`${base}/share-links`, { snapshot: id, kind })).url));
  return (
    <section className="work-section">
      <div className="work-head"><div><h2 className="a-h2">Snapshots</h2><p className="a-muted">Saved, unchangeable versions. Share links open one of these, never the working copy.</p></div></div>
      {r.can.includes('design.edit') && (
        <form className="a-inline" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`${base}/snapshots`, { name }); setName(''); await reload(); }); }}>
          <input className="a-input" aria-label="Snapshot name" placeholder="Name a snapshot" required value={name} onChange={(e) => setName(e.target.value)} />
          <button className="a-btn" disabled={busy}>Save snapshot</button>
        </form>
      )}
      <ErrorLine error={error} />
      <ul className="work-list">
        {r.snapshots.map((s) => (
          <li key={s.id} className="work-item">
            <Seal hash={s.content_hash} />
            <div className="work-main">
              <span className="a-row-title">{s.name} {s.status === 'approved' && <Tag tone="ok">Approved</Tag>}</span>
              <p className="a-muted a-small">{s.kind} · by {s.created_by_name || 'a former member'} {ago(s.created_at)} · <code>{short(s.content_hash)}</code></p>
              <div className="a-inline a-small">
                <a className="a-link" href={`${base}/snapshots/${s.id}/render`} target="_blank" rel="noopener">View</a>
                {r.can.includes('export.view') && <a className="a-link" href={`${base}/handoff?snapshot=${s.id}`} download>Handoff bundle</a>}
                {r.can.includes('export.run') && <a className="a-link" href={`${base}/export.html?snapshot=${s.id}`} download>Export HTML</a>}
                {r.can.includes('design.edit') && <button className="a-link" onClick={() => void share(s.id, 'stakeholder')}>Share with a stakeholder</button>}
                {r.can.includes('export.run') && <button className="a-link" onClick={() => void share(s.id, 'developer')}>Developer link</button>}
              </div>
            </div>
          </li>
        ))}
      </ul>
      {r.shareLinks.length > 0 && (
        <>
          <h3 className="a-h3">Share links</h3>
          <ul className="work-list">
            {r.shareLinks.map((l) => (
              <li key={l.id} className="work-item">
                <div className="work-main"><span>{l.kind === 'developer' ? 'Developer' : 'Stakeholder'} link to {r.snapshots.find((s) => s.id === l.snapshot_id)?.name ?? 'a snapshot'}</span>
                  <p className="a-muted a-small">{l.live ? `Expires ${new Date(l.expires_at).toLocaleDateString()}` : l.revoked_at ? 'Revoked' : 'Expired'} · made {ago(l.created_at)}</p></div>
                {l.live && <div className="work-actions"><button className="a-link a-danger" onClick={() => void run(async () => { await del(`${base}/share-links/${l.id}`); await reload(); })}>Revoke</button></div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {shared && (
        <Modal title="Share link" onClose={() => { setShared(null); void reload(); }}>
          <p className="a-muted">Copy it now: it is shown once. It opens this saved version only, view only, for 30 days unless you revoke it. Approving through it needs the person to sign in and confirm it is them.</p>
          <code className="a-code">{shared}</code>
          <div className="a-actions"><button className="a-btn" onClick={() => { setShared(null); void reload(); }}>Done</button></div>
        </Modal>
      )}
    </section>
  );
}

function Releases({ r, reload }: { r: ReviewData; reload: () => Promise<void> }) {
  const [notes, setNotes] = useState('');
  const [extra, setExtra] = useState('');
  const [fixFor, setFixFor] = useState<Release | null>(null);
  const [compare, setCompare] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const base = `/api/projects/${r.project.id}`;
  const openFix = r.fixes.find((f) => !f.released);
  const canRelease = r.can.includes('release');
  const basis = r.solo ? 'You work alone here, so this is recorded as released by you, not approved.'
    : r.latestApproved ? `Releases the approved version (${r.latestApproved.name}).`
    : r.strict ? 'Strict mode is on: release needs an approved version or an exception someone else accepted.'
    : 'Nothing is approved, so this will be recorded as released without approval.';
  return (
    <section className="work-section">
      <div className="work-head"><div><h2 className="a-h2">Releases</h2><p className="a-muted">What shipped: a saved version, a checklist and notes.</p></div></div>
      {canRelease && (
        <form className="a-form work-card" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`${base}/releases`, { notes, checklist: extra.trim() ? [{ label: extra.trim(), done: true }] : [], fix: openFix?.id }); setNotes(''); setExtra(''); await reload(); }); }}>
          <p className="a-muted">{basis}{openFix ? ` It also closes the fix "${openFix.note}".` : ''}</p>
          <ul className="gate-checks">{r.handoffChecks.map((c) => <li key={c.id} className={c.ok ? 'is-ok' : 'is-open'}><span className="gate-icon" aria-hidden>{c.ok ? '✓' : '○'}</span><span>{c.label}</span></li>)}</ul>
          <Field label="Another checklist item (done)"><input className="a-input" value={extra} onChange={(e) => setExtra(e.target.value)} /></Field>
          <Field label="Release notes"><textarea className="a-input" rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          <ErrorLine error={error} />
          <div className="a-actions"><button className="a-btn a-btn-primary" disabled={busy}>Release</button></div>
        </form>
      )}
      <ul className="work-list">
        {r.releases.map((x) => (
          <li key={x.id} className="work-item">
            <Seal hash={x.content_hash} />
            <div className="work-main">
              <span className="a-row-title">{x.basis === 'solo' ? `Released by ${x.released_by_name}` : BASIS[x.basis]}</span>
              <p className="a-muted a-small">{x.snapshot_name} · {x.basis === 'solo' ? '' : `by ${x.released_by_name || 'a former member'} · `}{ago(x.created_at)}{x.fix_id ? ' · fix' : ''}</p>
              {x.notes && <p className="work-body">{x.notes}</p>}
            </div>
            {r.can.includes('design.edit') && <div className="work-actions"><button className="a-link" onClick={() => setFixFor(x)}>Start a fix</button></div>}
          </li>
        ))}
      </ul>
      {r.fixes.length > 0 && (
        <>
          <h3 className="a-h3">Fixes</h3>
          <ul className="work-list">
            {r.fixes.map((f) => (
              <li key={f.id} className="work-item">
                <div className="work-main"><span className="a-row-title">{f.note}</span><p className="a-muted a-small">by {f.created_by_name} {ago(f.created_at)} · {f.released ? 'released' : 'open'}</p></div>
                <div className="work-actions"><button className="a-link" onClick={() => setCompare(f.id)}>Before and after</button></div>
              </li>
            ))}
          </ul>
        </>
      )}
      {fixFor && <StartFix r={r} release={fixFor} onClose={() => setFixFor(null)} reload={reload} />}
      {compare && <Compare r={r} fixId={compare} onClose={() => setCompare(null)} />}
    </section>
  );
}

function StartFix({ r, release, onClose, reload }: { r: ReviewData; release: Release; onClose: () => void; reload: () => Promise<void> }) {
  const screens = useLoad(() => get<{ screens: { screen_key: string; name: string }[] }>(`/api/projects/${r.project.id}/snapshots/${release.snapshot_id}`), [release.snapshot_id]);
  const [frame, setFrame] = useState('');
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title="Start a fix" onClose={onClose}>
      <p className="a-muted">Pick the released frame to change and say what changes. The released version stays as the "before".</p>
      <form className="a-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`/api/projects/${r.project.id}/releases/${release.id}/fixes`, { frame, note }); await reload(); }).then((ok) => ok && onClose()); }}>
        <Field label="Frame"><select className="a-input" required value={frame} onChange={(e) => setFrame(e.target.value)}><option value="">Choose…</option>{(screens.data?.screens ?? []).map((s) => <option key={s.screen_key} value={s.screen_key}>{s.name}</option>)}</select></Field>
        <Field label="What does the fix change?"><textarea className="a-input" rows={3} required value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <div className="a-actions"><button type="button" className="a-btn" onClick={onClose}>Cancel</button><button className="a-btn a-btn-primary" disabled={busy}>Start fix</button></div>
      </form>
    </Modal>
  );
}

function Compare({ r, fixId, onClose }: { r: ReviewData; fixId: string; onClose: () => void }) {
  const f = useLoad(() => get<{ note: string; before: { hash: string; url: string }; after: { hash: string; changed: boolean; url: string } | null }>(`/api/projects/${r.project.id}/fixes/${fixId}`), [fixId]);
  return (
    <Modal title="Before and after" onClose={onClose}>
      {!f.data ? <Loading label="Loading…" /> : (
        <>
          <p className="work-body">{f.data.note}</p>
          <div className="a-inline" style={{ alignItems: 'flex-start' }}>
            <figure style={{ margin: 0 }}><figcaption className="a-label">Released</figcaption><iframe title="Before" src={f.data.before.url} sandbox="" style={{ width: 320, height: 240, border: '1px solid #ddd' }} /></figure>
            {f.data.after && <figure style={{ margin: 0 }}><figcaption className="a-label">Now {f.data.after.changed ? '(changed)' : '(unchanged)'}</figcaption><iframe title="After" src={f.data.after.url} sandbox="" style={{ width: 320, height: 240, border: '1px solid #ddd' }} /></figure>}
          </div>
          {!f.data.after && <p className="gate-note">The frame is no longer on the canvas.</p>}
        </>
      )}
      <div className="a-actions"><button className="a-btn" onClick={onClose}>Close</button></div>
    </Modal>
  );
}

export function ReviewPage({ me, projectId }: { me: Me; projectId: string }) {
  const res = useLoad(() => get<ReviewData>(`/api/projects/${projectId}/review`), [projectId]);
  const reload = res.reload;
  if (res.error) return <Failed error={res.error} retry={() => void reload()} />;
  if (!res.data) return <Loading label="Loading reviews and releases…" />;
  const r = res.data;
  return (
    <div className="a-page">
      <TopBar me={me} trail={<><Link className="a-crumb" href={`/p/${projectId}`}>{r.project.name}</Link><span className="a-crumb-now">Review and release</span></>} />
      <main className="a-main a-narrow">
        <h1 className="a-h1">Review and release</h1>
        <Changes r={r} />
        <RequestReview r={r} reload={reload} />
        <Approvals r={r} reload={reload} />
        <Releases r={r} reload={reload} />
        <Snapshots r={r} reload={reload} />
      </main>
    </div>
  );
}
