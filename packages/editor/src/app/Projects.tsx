import { useState, type FormEvent } from 'react';
import { DEFAULT_WORK_TYPE, STAGES, stageDef, stageIndex, WORK_TYPE_IDS, WORK_TYPES, type WorkType } from '@rangoli/engine';
import { TopBar } from './Shell';
import { ago, ErrorLine, Failed, Field, get, Link, Modal, navigate, patch, post, useAction, useLoad, type Me, type OrgRole, type OrgSummary } from './core';

interface ProjectRow { id: string; name: string; description: string; stage: string; cycle: number; updated_at: string; review: string; attention: 'review' | 'fix' | 'advance' | null; work_type: WorkType; strict: boolean }

const ATTENTION = { review: 'Waiting for your review', fix: 'Changes requested', advance: 'Approved, ready to move on' };
const REVIEW_LABEL: Record<string, { label: string; tone?: string }> = { in_review: { label: 'In review', tone: 'warn' }, changes_requested: { label: 'Changes requested', tone: 'bad' }, approved: { label: 'Approved', tone: 'ok' } };

/** Nine ticks: how far around the cycle a project is, readable at a glance in a table. */
export function StageTicks({ stage }: { stage: string }) {
  const at = stageIndex(stage);
  return (
    <span className="ticks" role="img" aria-label={`Stage ${at + 1} of ${STAGES.length}`}>
      {STAGES.map((s, i) => <span key={s.id} className={`tick${i < at ? ' is-done' : i === at ? ' is-now' : ''}`} />)}
    </span>
  );
}

function NewProject({ orgId, onClose }: { orgId: string; onClose: () => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [workType, setWorkType] = useState<WorkType>(DEFAULT_WORK_TYPE);
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let id = '';
    if (await run(async () => { id = (await post<{ id: string }>(`/api/orgs/${orgId}/projects`, { name, description, workType })).id; })) navigate(`/p/${id}`);
  };
  return (
    <Modal title="New project" onClose={onClose}>
      <form className="a-form" onSubmit={(e) => void submit(e)}>
        <Field label="Name"><input className="a-input" required maxLength={120} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Description" hint="Optional. One line on what this is."><textarea className="a-input" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <Field label="Work type" hint={WORK_TYPES[workType].description}><select className="a-input" value={workType} onChange={(e) => setWorkType(e.target.value as WorkType)}>{WORK_TYPE_IDS.map((id) => <option key={id} value={id}>{WORK_TYPES[id].name}</option>)}</select></Field>
        <ErrorLine error={error} />
        <div className="a-actions">
          <button type="button" className="a-btn" onClick={onClose}>Cancel</button>
          <button className="a-btn a-btn-primary" disabled={busy}>Create project</button>
        </div>
      </form>
    </Modal>
  );
}

/** Strict mode, an organization setting: approval and release need passing checks or a second person's override. */
function StrictToggle({ orgId, on, reload }: { orgId: string; on: boolean; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  return (
    <label className="a-radio" title="Blocks approval and release while checks fail. An override needs a reason and a second person.">
      <input type="checkbox" checked={on} disabled={busy} onChange={(e) => void run(async () => { await patch(`/api/orgs/${orgId}/settings`, { strictMode: e.target.checked }); await reload(); })} />
      <span>Strict mode</span>
      <ErrorLine error={error} />
    </label>
  );
}

export function Projects({ me, org }: { me: Me; org: OrgSummary }) {
  const list = useLoad(() => get<{ role: OrgRole; strictMode: boolean; projects: ProjectRow[] }>(`/api/orgs/${org.id}/projects`), [org.id]);
  const [creating, setCreating] = useState(false);
  const canCreate = org.can.includes('org.projects.create');
  return (
    <div className="a-page">
      <TopBar me={me} org={org}>
        {org.can.includes('org.settings.manage') && list.data && <StrictToggle orgId={org.id} on={list.data.strictMode} reload={list.reload} />}
        {org.can.includes('org.members.manage') && <Link className="a-btn" href={`/o/${org.slug}/admin`}>Admin</Link>}
      </TopBar>
      <main className="a-main a-narrow">
        <div className="a-head">
          <h1 className="a-h1">Projects</h1>
          {canCreate && <button className="a-btn a-btn-primary" onClick={() => setCreating(true)}>New project</button>}
        </div>
        {list.error && <Failed error={list.error} retry={() => void list.reload()} />}
        {!list.data && !list.error && <div className="a-skeleton" role="status" aria-label="Loading projects" />}
        {list.data && list.data.projects.length === 0 && (
          <div className="a-empty">
            <h2 className="a-h2">{canCreate ? 'No projects yet' : 'Nothing assigned to you yet'}</h2>
            <p className="a-muted">{canCreate ? 'A project takes one product idea from research through launch.' : 'An admin assigns reviewers to projects. Ask yours to add you.'}</p>
            {canCreate && <button className="a-btn a-btn-primary" onClick={() => setCreating(true)}>Start your first project</button>}
          </div>
        )}
        {list.data && list.data.projects.some((x) => x.attention) && (
          <section className="needs-you" aria-label="Needs you">
            <h2 className="a-h2">Needs you</h2>
            <ul className="a-list">
              {list.data.projects.filter((x) => x.attention).map((x) => (
                <li key={x.id} className="a-row">
                  <div className="a-row-main"><Link className="a-row-link" href={`/p/${x.id}/${x.stage}`}>{x.name}</Link><span className="a-muted">{ATTENTION[x.attention!]} · {stageDef(x.stage)?.name}</span></div>
                  <Link className="a-btn" href={`/p/${x.id}/${x.stage}`}>Open</Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {list.data && list.data.projects.length > 0 && (
          <table className="a-table">
            <thead><tr><th>Project</th><th>Work type</th><th>Stage</th><th className="a-num">Cycle</th><th className="a-num">Updated</th></tr></thead>
            <tbody>
              {list.data.projects.map((p) => (
                <tr key={p.id}>
                  <td className="a-cell-main">
                    <Link href={`/p/${p.id}`} className="a-row-link">{p.name}</Link>
                    {p.description && <span className="a-muted a-truncate">{p.description}</span>}
                  </td>
                  <td><span className="tag">{WORK_TYPES[p.work_type]?.name ?? p.work_type}</span>{p.strict && <span className="tag tag-warn" title="Strict mode" style={{ marginLeft: 4 }}>Strict</span>}</td>
                  <td><div className="a-stage-cell"><StageTicks stage={p.stage} /><span>{stageDef(p.stage)?.name}</span>{REVIEW_LABEL[p.review] && <span className={`tag tag-${REVIEW_LABEL[p.review]!.tone}`}>{REVIEW_LABEL[p.review]!.label}</span>}</div></td>
                  <td className="a-num">{p.cycle}</td>
                  <td className="a-num a-muted">{ago(p.updated_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
      {creating && <NewProject orgId={org.id} onClose={() => setCreating(false)} />}
    </div>
  );
}
