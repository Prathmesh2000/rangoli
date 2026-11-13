import { useEffect, useMemo, useState } from 'react';
import { nextStage, STAGES, stageDef, stageIndex, WORK_TYPE_IDS, WORK_TYPES, type AgentRequest, type Check, type DesignFacts, type LifecycleItem, type ScreenFrameLink, type Signoff, type SignoffState, type StageDef, type StageEvent, type StageId, type WorkType, type WorkTypeDef } from '@rangoli/engine';
import { TopBar } from './Shell';
import { ago, ErrorLine, Failed, Field, get, Link, Loading, Modal, navigate, patch, post, useAction, useLoad, type Me, type ProjectRole } from './core';
import { StageWork, type WorkProps } from './stages';

export interface StageView extends Omit<StageDef, 'signoff'> {
  current: boolean;
  state: 'done' | 'current' | 'upcoming';
  checks: Check[];
  signoff: SignoffState;
  checksOk: boolean;
  ready: boolean;
  /** the work type checks this stage; outside it the checks are shown but stay quiet */
  inType: boolean;
  /** open checks on a stage the project has reached: shown as warnings, never a lock */
  warnings: { stage: StageId; check: string; message: string }[];
}

export interface StrictOverride { id: string; cycle: number; stage: StageId; action: 'approve' | 'release'; reason: string; actor: string; actor_name: string; created_at: string }

export interface JourneyData {
  project: { id: string; org_id: string; name: string; description: string; stage: StageId; cycle: number; org_name: string; org_slug: string; strict: boolean };
  role: ProjectRole;
  /** what the caller may do in this project (has_capability) */
  can: string[];
  workstream: { id: string; name: string; work_type: WorkType; cycle: number } | null;
  workType: WorkTypeDef;
  /** strict mode: approval and release need passing checks or someone else's override */
  strict: boolean;
  warnings: StageView['warnings'];
  overrides: StrictOverride[];
  /** device frames per screen */
  screenFrames: ScreenFrameLink[];
  /** the signed-in user, for "only your own" rules */
  me: string;
  stages: StageView[];
  items: LifecycleItem[];
  events: StageEvent[];
  signoffs: Signoff[];
  people: { id: string; name: string }[];
  agent: { online: boolean; requests: AgentRequest[] };
  frames: DesignFacts['frames'];
  links: DesignFacts['links'];
  blocking: DesignFacts['blocking'];
}

/** The lifecycle as what it is: a loop. The return line carries launch feedback back into research. */
function Rail({ j, viewing }: { j: JourneyData; viewing: StageId }) {
  return (
    <nav className="rail" aria-label="Design lifecycle">
      <ol className="rail-steps">
        {j.stages.map((s, i) => (
          <li key={s.id} className={`rail-step is-${s.state}${s.id === viewing ? ' is-viewing' : ''}`}>
            <Link href={`/p/${j.project.id}/${s.id}`} aria-current={s.id === viewing ? 'step' : undefined}>
              <span className="rail-mark" aria-hidden>{s.state === 'done' ? '✓' : i + 1}</span>
              <span className="rail-name">{s.name}{s.warnings.length > 0 && <span className="a-muted" title={`${s.warnings.length} open check${s.warnings.length === 1 ? '' : 's'}`}> ·</span>}</span>
              {s.current && <span className="sr-only">(current stage)</span>}
              {s.warnings.length > 0 && <span className="sr-only">({s.warnings.length} open checks)</span>}
            </Link>
          </li>
        ))}
      </ol>
      <div className="rail-loop" aria-hidden><span>Cycle {j.project.cycle}{j.project.cycle > 1 ? '' : ' · launch feedback starts the next one'}</span></div>
    </nav>
  );
}

function NextStep({ step }: { step: ReturnType<typeof nextStep> }) {
  return <p className="stage-next" role="status"><span className={`tag${step.tone ? ` tag-${step.tone}` : ''}`}>{step.label}</span><span>{step.text}</span></p>;
}

function CheckList({ checks }: { checks: Check[] }) {
  return (
    <ul className="gate-checks">
      {checks.map((c) => (
        <li key={c.id} className={c.ok ? 'is-ok' : 'is-open'}>
          <span className="gate-icon" aria-hidden>{c.ok ? '✓' : '○'}</span>
          <div>
            <span>{c.label}<span className="sr-only">{c.ok ? ' (done)' : ' (not done)'}</span></span>
            {!c.ok && c.detail && <span className="gate-detail">{c.detail}</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** One sentence: what happens next on this stage, and whether it is you. */
function nextStep(j: JourneyData, stage: StageView, name: (id: string | null) => string): { label: string; tone?: string; text: string } {
  const writer = j.can.includes('design.edit');
  const next = stageDef(nextStage(stage.id) ?? '')?.name;
  if (stage.state === 'upcoming') return { label: 'Open', text: `The project is in ${stageDef(j.project.stage)!.name}, but you can work here now. This is what it will ask for.` };
  if (stage.state === 'done') return stage.warnings.length
    ? { label: 'Moved on', tone: 'warn', text: `Left with ${stage.warnings.length} open check${stage.warnings.length === 1 ? '' : 's'}. It stays open to finish.` }
    : { label: 'Done', tone: 'ok', text: 'Completed earlier in this cycle. It stays open.' };
  const open = stage.checks.filter((c) => !c.ok).length;
  const s = stage.signoff;
  if (s.status === 'in_review') {
    if (s.requestedBy === j.me) return { label: 'In review', tone: 'warn', text: 'You asked for this review, so someone else needs to decide. You can keep working meanwhile.' };
    return { label: 'In review', tone: 'warn', text: `${name(s.requestedBy)} asked for a review. Approve it or request changes.` };
  }
  if (s.status === 'changes_requested') return { label: 'Changes requested', tone: 'bad', text: writer ? 'Make the changes below, then request review again.' : 'Waiting for the designers to make the changes.' };
  if (s.status === 'approved') return { label: 'Approved', tone: 'ok', text: writer ? `Ready to move to ${next}.` : `Approved. A designer moves it to ${next}.` };
  if (open > 0) return { label: 'In progress', tone: stage.inType ? 'warn' : undefined, text: writer ? `${open} open check${open === 1 ? '' : 's'}. ${stage.inType ? 'They are warnings: you can still move on.' : `${j.workType.name} work does not check this stage.`}` : 'The designers are still working on this stage.' };
  if (s.required) return { label: 'Ready for review', tone: 'ok', text: writer ? 'Everything is in place. Ask a teammate to review it.' : 'Waiting for a designer to request review.' };
  return { label: 'Ready', tone: 'ok', text: writer ? (next ? `Ready to move to ${next}.` : `Ready to start cycle ${j.project.cycle + 1}.`) : 'A designer moves this stage forward.' };
}

function SignoffPanel({ j, stage, name, reload }: { j: JourneyData; stage: StageView; name: (id: string | null) => string; reload: () => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  const s = stage.signoff;
  const canDecide = stage.current && ['in_review', 'approved'].includes(s.status) && s.requestedBy !== j.me;
  const send = (decision: 'approved' | 'changes_requested') => run(async () => {
    await post(`/api/projects/${j.project.id}/signoff`, { decision, note });
    setNote('');
    setAsking(false);
    await reload();
  });
  if (!s.decisions.length && !canDecide) return null;
  return (
    <div className="gate-block">
      <h3 className="gate-title">Review{s.needed > 1 ? ` · ${s.needed} approvals needed` : ''}</h3>
      <ul className="gate-signoffs">
        {s.decisions.map((d) => (
          <li key={d.id} className={d.decision === 'approved' ? 'is-ok' : 'is-bad'}>
            <strong>{name(d.reviewer)}</strong> {d.decision === 'approved' ? 'approved' : 'requested changes'} <span className="a-muted">{ago(d.created_at)}</span>
            {d.note && <p>{d.note}</p>}
          </li>
        ))}
      </ul>
      {canDecide && !asking && (
        <div className="a-inline">
          <button className="a-btn" disabled={busy} onClick={() => void send('approved')}>Approve</button>
          <button className="a-btn" disabled={busy} onClick={() => setAsking(true)}>Request changes</button>
        </div>
      )}
      {canDecide && asking && (
        <form className="a-form" onSubmit={(e) => { e.preventDefault(); void send('changes_requested'); }}>
          <Field label="What needs to change?"><textarea className="a-input" rows={3} required autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="a-inline">
            <button type="button" className="a-btn" onClick={() => setAsking(false)}>Cancel</button>
            <button className="a-btn a-btn-primary" disabled={busy}>Send to designer</button>
          </div>
        </form>
      )}
      <ErrorLine error={error} />
    </div>
  );
}

function SendBack({ j, onClose, reload }: { j: JourneyData; onClose: () => void; reload: () => Promise<void> }) {
  const earlier = STAGES.slice(0, stageIndex(j.project.stage));
  const [to, setTo] = useState<StageId>([...earlier].reverse().find((s) => s.designOpen)?.id ?? earlier[earlier.length - 1]!.id);
  const [note, setNote] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title="Send back" onClose={onClose}>
      <p className="a-muted">Iteration is part of the cycle. Sign-offs from that stage onward are cleared, so the rework gets reviewed again.</p>
      <form className="a-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`/api/projects/${j.project.id}/send-back`, { to, note }); await reload(); navigate(`/p/${j.project.id}/${to}`); }).then((ok) => ok && onClose()); }}>
        <Field label="Back to"><select className="a-input" value={to} onChange={(e) => setTo(e.target.value as StageId)}>{earlier.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field>
        <Field label="What needs another pass?"><textarea className="a-input" rows={3} required autoFocus value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <div className="a-actions">
          <button type="button" className="a-btn" onClick={onClose}>Cancel</button>
          <button className="a-btn a-btn-primary" disabled={busy}>Send back</button>
        </div>
      </form>
    </Modal>
  );
}

/** Strict mode only: an admin's recorded reason lets someone else's approval or release through with failing checks. */
function Override({ j, action, onClose, reload }: { j: JourneyData; action: 'approve' | 'release'; onClose: () => void; reload: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  const { busy, error, run } = useAction();
  return (
    <Modal title={action === 'approve' ? 'Override for approval' : 'Override for release'} onClose={onClose}>
      <p className="a-muted">Strict mode is on and checks are failing. Your name and reason go on the record. It only counts for someone else: you cannot override a review you asked for, or a release you make yourself.</p>
      <form className="a-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await post(`/api/projects/${j.project.id}/overrides`, { action, reason }); await reload(); }).then((ok) => ok && onClose()); }}>
        <Field label="Why is it safe to go ahead?"><textarea className="a-input" rows={3} required autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <div className="a-actions">
          <button type="button" className="a-btn" onClick={onClose}>Cancel</button>
          <button className="a-btn a-btn-danger" disabled={busy}>Record override</button>
        </div>
      </form>
    </Modal>
  );
}

/** Full, Feature, Fix or Regulated: sets which stages are checked and which need approval. */
function WorkTypePicker({ j, reload }: { j: JourneyData; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  const writer = j.can.includes('design.edit');
  return (
    <div className="gate-block">
      <h3 className="gate-title">Work type</h3>
      {writer
        ? <select className="a-input" aria-label="Work type" disabled={busy} value={j.workType.id} onChange={(e) => void run(async () => { await patch(`/api/projects/${j.project.id}`, { workType: e.target.value }); await reload(); })}>{WORK_TYPE_IDS.map((id) => <option key={id} value={id}>{WORK_TYPES[id].name}</option>)}</select>
        : <span className="tag">{j.workType.name}</span>}
      <p className="a-muted a-small">{j.workType.description}{j.strict ? ' Strict mode is on: approval and release need passing checks or an override.' : ''}</p>
      <ErrorLine error={error} />
    </div>
  );
}

function NextCycle({ j, onClose, reload }: { j: JourneyData; onClose: () => void; reload: () => Promise<void> }) {
  const feedback = j.items.filter((i) => i.kind === 'feedback' && i.cycle === j.project.cycle && i.status === 'open');
  const [picked, setPicked] = useState<string[]>(feedback.map((f) => f.id));
  const stage = j.stages.find((s) => s.current)!;
  const { busy, error, run } = useAction();
  return (
    <Modal title={`Start cycle ${j.project.cycle + 1}`} onClose={onClose}>
      <p className="a-muted">The project returns to Discovery. Personas, stories and screens carry over. Feedback you tick becomes research to act on.</p>
      {stage.warnings.length > 0 && <p className="gate-note">{stage.warnings.length} check{stage.warnings.length === 1 ? ' is' : 's are'} still open here. They stay on the record.</p>}
      {feedback.length === 0 && <p className="a-muted">No open feedback from this cycle to carry over.</p>}
      {feedback.map((f) => (
        <label key={f.id} className="a-radio">
          <input type="checkbox" checked={picked.includes(f.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, f.id] : picked.filter((x) => x !== f.id))} />
          <span>{f.title}</span>
        </label>
      ))}
      <ErrorLine error={error} />
      <div className="a-actions">
        <button className="a-btn" onClick={onClose}>Cancel</button>
        <button className="a-btn a-btn-primary" disabled={busy} onClick={() => void run(async () => { await post(`/api/projects/${j.project.id}/next-cycle`, { promote: picked }); await reload(); navigate(`/p/${j.project.id}/discovery`); }).then((ok) => ok && onClose())}>Start cycle {j.project.cycle + 1}</button>
      </div>
    </Modal>
  );
}

function Gate({ j, stage, reload, name }: { j: JourneyData; stage: StageView; reload: () => Promise<void>; name: (id: string | null) => string }) {
  const [dialog, setDialog] = useState<'back' | 'cycle' | 'approve' | 'release' | null>(null);
  const { busy, error, run } = useAction();
  const next = nextStage(stage.id);
  const canMove = j.can.includes('design.edit') && stage.current;
  const status = stage.signoff.status;
  const inReview = status === 'in_review' || status === 'approved';
  const review = (action: 'request' | 'withdraw') => run(async () => {
    await post(`/api/projects/${j.project.id}/review/${action}`);
    await reload();
  });
  const advance = () => run(async () => {
    const r = await post<{ stage: string }>(`/api/projects/${j.project.id}/advance`);
    await reload();
    navigate(`/p/${j.project.id}/${r.stage}`);
  });
  const needsReview = stage.signoff.required && (status === 'working' || status === 'changes_requested');
  const open = stage.checks.filter((c) => !c.ok).length;
  // strict mode blocks only approval and release; an admin who is not the person acting can override
  const hasOverride = (action: 'approve' | 'release') => j.overrides.some((o) => o.action === action && o.stage === (action === 'release' ? 'handoff' : stage.id));
  const canOverride = j.strict && j.can.includes('override.strict') && open > 0 && stage.current;
  const overrideFor = canOverride && status === 'in_review' && stage.signoff.requestedBy !== j.me && !hasOverride('approve') ? 'approve' : canOverride && stage.id === 'handoff' && !hasOverride('release') ? 'release' : null;
  const primary = needsReview
    ? <button className="a-btn a-btn-primary a-btn-block" disabled={busy} onClick={() => void review('request')}>{status === 'changes_requested' ? 'Request review again' : 'Request review'}</button>
    : status === 'in_review'
      ? null
      : next
        ? <button className="a-btn a-btn-primary a-btn-block" disabled={busy} onClick={() => void advance()}>Move to {stageDef(next)!.name}</button>
        : <button className="a-btn a-btn-primary a-btn-block" onClick={() => setDialog('cycle')}>Start cycle {j.project.cycle + 1}</button>;
  return (
    <aside className="gate" aria-label="What this stage checks">
      <div className="gate-block">
        <h3 className="gate-title">Checks{j.strict && <span className="tag tag-warn" style={{ marginLeft: 8 }}>Strict</span>}</h3>
        <CheckList checks={stage.checks} />
        {open > 0 && <p className="gate-note">{!stage.inType ? `${j.workType.name} work does not check this stage.` : j.strict ? 'Open checks are warnings, but strict mode blocks approval and release until they pass or are overridden.' : 'Open checks are warnings. They never block moving on.'}</p>}
      </div>
      <WorkTypePicker j={j} reload={reload} />
      {stage.signoff.required && stage.state === 'current' && <SignoffPanel j={j} stage={stage} name={name} reload={reload} />}
      {canMove && (
        <div className="gate-actions">
          {primary}
          <ErrorLine error={error} />
          <div className="gate-secondary">
            {inReview && <button className="a-link" disabled={busy} onClick={() => void review('withdraw')}>{stage.signoff.status === 'approved' ? 'Reopen to edit' : 'Withdraw review'}</button>}
            {stageIndex(stage.id) > 0 && <button className="a-link" onClick={() => setDialog('back')}>Send back</button>}
          </div>
        </div>
      )}
      {overrideFor && <div className="gate-actions"><button className="a-link" onClick={() => setDialog(overrideFor)}>{overrideFor === 'approve' ? 'Override strict mode for this approval' : 'Override strict mode for release'}</button></div>}
      {j.overrides.length > 0 && (
        <div className="gate-block">
          <h3 className="gate-title">Overrides</h3>
          <ul className="gate-history">{j.overrides.map((o) => <li key={o.id}><span><strong>{name(o.actor)}</strong> overrode {o.action === 'approve' ? 'approval' : 'release'} of {stageDef(o.stage)?.name}</span><span className="gate-detail">{o.reason}</span><span className="a-muted a-small">{ago(o.created_at)}</span></li>)}</ul>
        </div>
      )}
      <History j={j} name={name} />
      {dialog === 'back' && <SendBack j={j} onClose={() => setDialog(null)} reload={reload} />}
      {(dialog === 'approve' || dialog === 'release') && <Override j={j} action={dialog} onClose={() => setDialog(null)} reload={reload} />}
      {dialog === 'cycle' && <NextCycle j={j} onClose={() => setDialog(null)} reload={reload} />}
    </aside>
  );
}

function History({ j, name }: { j: JourneyData; name: (id: string | null) => string }) {
  const text = (e: StageEvent) => {
    const to = stageDef(e.to_stage)?.name;
    if (e.kind === 'created') return 'started the project';
    if (e.kind === 'review_requested') return `asked for a review of ${to}`;
    if (e.kind === 'review_withdrawn') return `withdrew the review of ${to}`;
    if (e.kind === 'advance') return `moved it to ${to}`;
    if (e.kind === 'send_back') return `sent it back to ${to}`;
    if (e.kind === 'override') return `moved it to ${to}, skipping open checks`;
    return `started cycle ${e.cycle}`;
  };
  const events = [...j.events].reverse().slice(0, 12);
  return (
    <div className="gate-block">
      <h3 className="gate-title">History</h3>
      <ol className="gate-history">
        {events.map((e) => (
          <li key={e.id}>
            <span><strong>{name(e.actor)}</strong> {text(e)}</span>
            {e.note && <span className="gate-detail">{e.note}</span>}
            <span className="a-muted a-small">{ago(e.created_at)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function Journey({ me, projectId, stage: requested }: { me: Me; projectId: string; stage?: string }) {
  const res = useLoad(() => get<JourneyData>(`/api/projects/${projectId}/journey`), [projectId]);
  const reload = res.reload;

  // gates recompute as teammates and agents work
  useEffect(() => {
    let timer: number | undefined;
    const es = new EventSource(`/d/${projectId}/events`);
    const later = () => { window.clearTimeout(timer); timer = window.setTimeout(() => void reload(), 300); };
    es.addEventListener('journey', later);
    es.addEventListener('doc', later);
    return () => { window.clearTimeout(timer); es.close(); };
  }, [projectId, reload]);

  const people = useMemo(() => new Map((res.data?.people ?? []).map((p) => [p.id, p.name])), [res.data]);
  const name = (id: string | null) => (id === me.user.id ? 'You' : (id && people.get(id)) || 'Someone');

  if (res.error) return <Failed error={res.error} retry={() => void reload()} />;
  if (!res.data) return <Loading label="Loading the project…" />;
  const j = { ...res.data, me: me.user.id };
  const org = me.orgs.find((o) => o.id === j.project.org_id);
  const viewing = j.stages.find((s) => s.id === requested) ?? j.stages.find((s) => s.current)!;
  const work: WorkProps = { j, stage: viewing, reload, name };

  return (
    <div className="a-page">
      <TopBar me={me} org={org} trail={<span className="a-crumb-now a-truncate">{j.project.name}</span>}>
        <span className="a-role" title="Your role in this project">{j.role.replace('_', ' ')}</span>
        <Link className="a-btn" href={`/p/${j.project.id}/review`}>Review and release</Link>
        <Link className="a-btn" href={`/p/${j.project.id}/design`}>Open canvas</Link>
      </TopBar>
      <Rail j={j} viewing={viewing.id} />
      <div className="journey">
        <main className="journey-work">
          <header className="stage-head">
            <h1 className="a-h1">{viewing.name}</h1>
            <p className="stage-q">{viewing.question}</p>
            <NextStep step={nextStep(j, viewing, name)} />
          </header>
          <StageWork {...work} />
        </main>
        <Gate j={j} stage={viewing} reload={reload} name={name} />
      </div>
    </div>
  );
}
