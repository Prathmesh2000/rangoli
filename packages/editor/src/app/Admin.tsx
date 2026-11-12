import { useState, type FormEvent } from 'react';
import { ASSIGNABLE_PROJECT_ROLES, hasCapability, PERMISSIONS, stageDef, type OrganizationRole, type ProjectRole as EngineProjectRole } from '@rangoli/engine';
import { TopBar } from './Shell';
import { ago, del, ErrorLine, Failed, Field, get, Link, Loading, Modal, patch, post, put, useAction, useLoad, type Me, type OrgRole, type OrgSummary } from './core';

type ProjectRole = (typeof ASSIGNABLE_PROJECT_ROLES)[number];

interface AdminData {
  org: { id: string; name: string; slug: string };
  members: { id: string; name: string; email: string; role: OrgRole; created_at: string }[];
  invites: { id: string; email: string; role: OrgRole; project_role: ProjectRole; is_approver: boolean; project_ids: string[]; expires_at: string }[];
  projects: { id: string; name: string; stage: string }[];
  assignments: { project_id: string; user_id: string; role: ProjectRole; is_approver: boolean }[];
  audit: { id: string; action: string; detail: Record<string, unknown>; created_at: string; actor_name: string | null; project_name: string | null }[];
  /** the caller's organization role and capabilities */
  me: { role: OrgRole; can: string[] };
}

const ORG_ROLE_LABEL: Record<OrgRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', guest: 'Guest' };
/** Owner is not offered: an organization has one, and it changes hands only by transfer. */
const ORG_ROLES: { id: Exclude<OrgRole, 'owner'>; hint: string }[] = [
  { id: 'member', hint: 'Creates projects and works in the ones they are added to' },
  { id: 'admin', hint: 'Manages people, invites and who works on which project' },
  { id: 'guest', hint: 'Someone from outside, in one project only' },
];
const PROJECT_ROLE_LABEL: Record<ProjectRole, string> = {
  lead: 'Lead', designer: 'Designer', researcher: 'Researcher', product_manager: 'Product manager', developer: 'Developer', reviewer: 'Reviewer', viewer: 'Viewer',
};
const PROJECT_ROLE_HINT: Record<ProjectRole, string> = {
  lead: 'Everything a designer does, plus managing the project',
  designer: 'Edits the design and the plan',
  researcher: 'Adds research and reads transcripts; does not edit the design',
  product_manager: 'Records decisions and adds evidence',
  developer: 'Comments, exports and maps code',
  reviewer: 'Comments, suggests and adds findings',
  viewer: 'Looks, without commenting',
};
const TABS = [['members', 'People'], ['access', 'Project access'], ['permissions', 'Permissions'], ['activity', 'Activity'], ['settings', 'Settings']] as const;

function InviteModal({ data, onClose, onDone }: { data: AdminData; onClose: () => void; onDone: () => Promise<void> }) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Exclude<OrgRole, 'owner'>>('member');
  const [projectRole, setProjectRole] = useState<ProjectRole>('designer');
  const [approver, setApprover] = useState(false);
  const [projects, setProjects] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [emailed, setEmailed] = useState(false);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const guest = role === 'guest';
  const canApprove = hasCapability({ projectRole, isApprover: true }, 'approve');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const r = await post<{ url: string; emailed: boolean }>(`/api/orgs/${data.org.id}/invites`, { email, role, projects, projectRole, approver: approver && canApprove });
      setEmailed(r.emailed);
      setLink(r.url);
      await onDone();
    });
  };
  if (link) {
    return (
      <Modal title={emailed ? 'Invite sent' : 'Send this link'} onClose={onClose}>
        <p className="a-muted">{emailed ? `We emailed ${email}. You can also share this link yourself.` : 'Email is not set up on this server, so share this yourself.'} It only works for {email} and expires in 7 days.</p>
        <code className="a-code">{link}</code>
        <div className="a-actions">
          <button className="a-btn" onClick={() => void navigator.clipboard.writeText(link).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy link'}</button>
          <button className="a-btn a-btn-primary" onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Invite someone" onClose={onClose}>
      <form className="a-form" onSubmit={(e) => void submit(e)}>
        <Field label="Email"><input className="a-input" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <fieldset className="a-fieldset">
          <legend className="a-label">In the organization</legend>
          {ORG_ROLES.map((r) => (
            <label key={r.id} className="a-radio">
              <input type="radio" name="role" checked={role === r.id} onChange={() => { setRole(r.id); if (r.id === 'guest') setProjects(projects.slice(0, 1)); }} />
              <span><strong>{ORG_ROLE_LABEL[r.id]}</strong><span className="a-muted"> {r.hint}</span></span>
            </label>
          ))}
        </fieldset>
        {data.projects.length > 0 && (
          <fieldset className="a-fieldset">
            <legend className="a-label">{guest ? 'Their project' : 'Projects'}</legend>
            {data.projects.map((p) => (
              <label key={p.id} className="a-radio">
                <input type={guest ? 'radio' : 'checkbox'} name="projects" checked={projects.includes(p.id)} onChange={(e) => setProjects(guest ? [p.id] : e.target.checked ? [...projects, p.id] : projects.filter((x) => x !== p.id))} />
                <span>{p.name}</span>
              </label>
            ))}
          </fieldset>
        )}
        {projects.length > 0 && (
          <>
            <Field label="Role in those projects" hint={PROJECT_ROLE_HINT[projectRole]}>
              <select className="a-select" value={projectRole} onChange={(e) => setProjectRole(e.target.value as ProjectRole)}>
                {ASSIGNABLE_PROJECT_ROLES.map((r) => <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}</option>)}
              </select>
            </Field>
            {canApprove && (
              <label className="a-radio">
                <input type="checkbox" checked={approver || projectRole === 'reviewer'} disabled={projectRole === 'reviewer'} onChange={(e) => setApprover(e.target.checked)} />
                <span><strong>Approver</strong><span className="a-muted"> Can approve stages, never their own request</span></span>
              </label>
            )}
          </>
        )}
        {guest && projects.length !== 1 && <p className="a-muted">Choose the one project this guest works in.</p>}
        <ErrorLine error={error} />
        <div className="a-actions">
          <button type="button" className="a-btn" onClick={onClose}>Cancel</button>
          <button className="a-btn a-btn-primary" disabled={busy || (guest && projects.length !== 1)}>Create invite</button>
        </div>
      </form>
    </Modal>
  );
}

function People({ me, data, reload }: { me: Me; data: AdminData; reload: () => Promise<void> }) {
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<AdminData['members'][number] | null>(null);
  const [handing, setHanding] = useState<AdminData['members'][number] | null>(null);
  const { busy, error, run } = useAction();
  const base = `/api/orgs/${data.org.id}`;
  const canTransfer = data.me.can.includes('org.transfer');
  const projectName = (id: string) => data.projects.find((p) => p.id === id)?.name ?? 'a project';
  return (
    <section>
      <div className="a-head">
        <h2 className="a-h2">{data.members.length} {data.members.length === 1 ? 'person' : 'people'}</h2>
        <button className="a-btn a-btn-primary" onClick={() => setInviting(true)}>Invite someone</button>
      </div>
      <ErrorLine error={error} />
      <table className="a-table">
        <thead><tr><th>Name</th><th>Role</th><th className="a-num"><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {data.members.map((m) => (
            <tr key={m.id}>
              <td className="a-cell-main"><span className="a-row-title">{m.name}{m.id === me.user.id && <span className="a-muted"> (you)</span>}</span><span className="a-muted a-truncate">{m.email}</span></td>
              <td>
                {m.role === 'owner' ? <span>Owner</span> : (
                  <select className="a-select" aria-label={`Role for ${m.name}`} value={m.role} disabled={busy} onChange={(e) => void run(async () => { await patch(`${base}/members/${m.id}`, { role: e.target.value }); await reload(); })}>
                    {ORG_ROLES.map((r) => <option key={r.id} value={r.id}>{ORG_ROLE_LABEL[r.id]}</option>)}
                  </select>
                )}
              </td>
              <td className="a-num">
                {m.role !== 'owner' && canTransfer && m.role !== 'guest' && <button className="a-link" onClick={() => setHanding(m)}>Make owner</button>}
                {m.role !== 'owner' && <> <button className="a-link a-danger" onClick={() => setRemoving(m)}>Remove</button></>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.invites.length > 0 && (
        <>
          <h3 className="a-h3">Pending invites</h3>
          <ul className="a-list">
            {data.invites.map((i) => (
              <li key={i.id} className="a-row">
                <div className="a-row-main">
                  <span className="a-row-title">{i.email}</span>
                  <span className="a-muted">
                    {ORG_ROLE_LABEL[i.role]}
                    {i.project_ids.length > 0 && <> · {PROJECT_ROLE_LABEL[i.project_role]}{i.is_approver ? ' and approver' : ''} on {i.project_ids.length === 1 ? projectName(i.project_ids[0]!) : `${i.project_ids.length} projects`}</>}
                    {' '}· expires {new Date(i.expires_at).toLocaleDateString()}
                  </span>
                </div>
                <button className="a-link a-danger" onClick={() => void run(async () => { await del(`${base}/invites/${i.id}`); await reload(); })}>Revoke</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {inviting && <InviteModal data={data} onClose={() => setInviting(false)} onDone={reload} />}
      {removing && (
        <Modal title={`Remove ${removing.name}?`} onClose={() => setRemoving(null)}>
          <p className="a-muted">They lose access to every project in {data.org.name} right away. Their past work stays.</p>
          <ErrorLine error={error} />
          <div className="a-actions">
            <button className="a-btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="a-btn a-btn-danger" disabled={busy} onClick={() => void run(async () => { await del(`${base}/members/${removing.id}`); await reload(); }).then((ok) => ok && setRemoving(null))}>Remove from organization</button>
          </div>
        </Modal>
      )}
      {handing && (
        <Modal title={`Make ${handing.name} the owner?`} onClose={() => setHanding(null)}>
          <p className="a-muted">An organization has one owner. You become an admin, and only {handing.name} can hand it back. An account can own one organization.</p>
          <ErrorLine error={error} />
          <div className="a-actions">
            <button className="a-btn" onClick={() => setHanding(null)}>Cancel</button>
            <button className="a-btn a-btn-danger" disabled={busy} onClick={() => void run(async () => { await post(`${base}/transfer`, { user: handing.id }); await reload(); }).then((ok) => ok && setHanding(null))}>Hand over</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** One project role per person per project, and the Approver designation. */
function Access({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const { busy, error, run } = useAction();
  const people = data.members;
  const of = (p: string, u: string) => data.assignments.find((a) => a.project_id === p && a.user_id === u);
  const save = (p: string, u: string, body: { role?: ProjectRole; approver?: boolean } | null) =>
    void run(async () => { await (body ? put(`/api/projects/${p}/members/${u}`, body) : del(`/api/projects/${p}/members/${u}`)); await reload(); });
  if (!data.projects.length) return <div className="a-empty"><h2 className="a-h2">No projects yet</h2><p className="a-muted">Once a project exists, choose who works on it here.</p></div>;
  return (
    <section>
      <p className="a-muted a-lead">Nobody sees a project until they have a role in it, owners and admins included. Approvers can decide reviews, never their own. A guest works in one project.</p>
      <ErrorLine error={error} />
      <div className="a-scroll">
        <table className="a-table a-matrix">
          <thead><tr><th>Project</th>{people.map((m) => <th key={m.id}><span>{m.name}</span><span className="a-muted a-small">{ORG_ROLE_LABEL[m.role]}</span></th>)}</tr></thead>
          <tbody>
            {data.projects.map((p) => (
              <tr key={p.id}>
                <td className="a-cell-main"><span className="a-row-title">{p.name}</span><span className="a-muted">{stageDef(p.stage)?.name}</span></td>
                {people.map((m) => {
                  const a = of(p.id, m.id);
                  const approves = !!a && hasCapability({ projectRole: a.role as EngineProjectRole, isApprover: true }, 'approve');
                  return (
                    <td key={m.id}>
                      <select className="a-select" aria-label={`${m.name} on ${p.name}`} disabled={busy} value={a?.role ?? ''} onChange={(e) => save(p.id, m.id, e.target.value ? { role: e.target.value as ProjectRole } : null)}>
                        <option value="">No access</option>
                        {ASSIGNABLE_PROJECT_ROLES.map((r) => <option key={r} value={r}>{PROJECT_ROLE_LABEL[r]}</option>)}
                      </select>
                      {approves && (
                        <label className="a-radio a-small">
                          <input type="checkbox" aria-label={`${m.name} approves on ${p.name}`} disabled={busy} checked={a.is_approver} onChange={(e) => save(p.id, m.id, { approver: e.target.checked })} />
                          <span>Approver</span>
                        </label>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const ORG_COLUMNS: OrganizationRole[] = ['owner', 'admin', 'member', 'guest'];

function Permissions() {
  const mark = (on: boolean) => <span className={on ? 'perm-yes' : 'perm-no'}>{on ? '✓' : '–'}<span className="sr-only">{on ? 'Allowed' : 'Not allowed'}</span></span>;
  const orgRows = PERMISSIONS.filter((p) => p.level === 'organization');
  const projectRows = PERMISSIONS.filter((p) => p.level === 'project');
  return (
    <section>
      <p className="a-muted a-lead">Roles are fixed and enforced by the database itself, so no screen or agent can get around them. An organization role gives nothing inside a project: that takes a project role.</p>
      <h3 className="a-h3">In the organization</h3>
      <table className="a-table a-matrix">
        <thead><tr><th>Permission</th>{ORG_COLUMNS.map((r) => <th key={r}>{ORG_ROLE_LABEL[r as OrgRole]}</th>)}</tr></thead>
        <tbody>
          {orgRows.map((p) => <tr key={p.capability}><td>{p.action}</td>{ORG_COLUMNS.map((orgRole) => <td key={orgRole}>{mark(hasCapability({ orgRole }, p.capability))}</td>)}</tr>)}
        </tbody>
      </table>
      <h3 className="a-h3">In a project</h3>
      <div className="a-scroll">
        <table className="a-table a-matrix">
          <thead><tr><th>Permission</th>{ASSIGNABLE_PROJECT_ROLES.map((r) => <th key={r}>{PROJECT_ROLE_LABEL[r]}</th>)}</tr></thead>
          <tbody>
            {projectRows.map((p) => (
              <tr key={p.capability}>
                <td>{p.action}{p.note && <span className="a-muted a-small"> · {p.note}</span>}</td>
                {ASSIGNABLE_PROJECT_ROLES.map((projectRole) => <td key={projectRole}>{mark(hasCapability({ projectRole, isApprover: true }, p.capability))}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const ACTION_LABEL: Record<string, string> = {
  'org.create': 'created the organization', 'org.rename': 'renamed the organization', 'org.transfer': 'handed the organization over', 'project.create': 'created a project', 'project.delete': 'deleted a project',
  'project.assign': 'changed who works on a project', 'project.unassign': 'removed someone from a project', 'member.role': 'changed a role', 'member.remove': 'removed a member',
  'invite.create': 'sent an invite', 'invite.revoke': 'revoked an invite', 'stage.advance': 'moved a project forward', 'stage.send_back': 'sent a project back', 'stage.override': 'skipped a gate',
  'stage.new_cycle': 'started a new cycle', 'review.review_requested': 'asked for a review', 'review.review_withdrawn': 'withdrew a review', 'signoff.approved': 'approved a stage', 'signoff.changes_requested': 'requested changes',
};

function Activity({ data }: { data: AdminData }) {
  if (!data.me.can.includes('org.audit.read')) return <div className="a-empty"><p className="a-muted">Only the owner reads the activity log.</p></div>;
  if (!data.audit.length) return <div className="a-empty"><p className="a-muted">Nothing has happened yet.</p></div>;
  return (
    <ul className="a-list">
      {data.audit.map((a) => (
        <li key={a.id} className="a-row">
          <div className="a-row-main">
            <span><strong>{a.actor_name ?? 'Someone'}</strong> {ACTION_LABEL[a.action] ?? a.action}{a.project_name && <> on <strong>{a.project_name}</strong></>}</span>
            {typeof a.detail.note === 'string' && a.detail.note && <span className="a-muted">{a.detail.note}</span>}
          </div>
          <span className="a-muted a-nowrap">{ago(a.created_at)}</span>
        </li>
      ))}
    </ul>
  );
}

function Settings({ data, reload }: { data: AdminData; reload: () => Promise<void> }) {
  const [name, setName] = useState(data.org.name);
  const { busy, error, run } = useAction();
  const allowed = data.me.can.includes('org.settings.manage');
  return (
    <form className="a-form a-w-form" onSubmit={(e) => { e.preventDefault(); void run(async () => { await patch(`/api/orgs/${data.org.id}`, { name }); await reload(); }); }}>
      <Field label="Organization name"><input className="a-input" required maxLength={80} value={name} disabled={!allowed} onChange={(e) => setName(e.target.value)} /></Field>
      <ErrorLine error={error} />
      <div><button className="a-btn a-btn-primary" disabled={busy || !allowed || name === data.org.name}>Save name</button></div>
    </form>
  );
}

export function Admin({ me, org, tab }: { me: Me; org: OrgSummary; tab: string }) {
  const res = useLoad(() => get<AdminData>(`/api/orgs/${org.id}/admin`), [org.id]);
  const reload = res.reload;
  return (
    <div className="a-page">
      <TopBar me={me} org={org} trail={<span className="a-crumb-now">Admin</span>} />
      <main className="a-main a-narrow">
        <nav className="a-tabs" aria-label="Admin sections">
          {TABS.map(([id, label]) => <Link key={id} href={`/o/${org.slug}/admin/${id}`} className="a-tab" aria-current={tab === id ? 'page' : undefined}>{label}</Link>)}
        </nav>
        {res.error && <Failed error={res.error} retry={() => void reload()} />}
        {!res.data && !res.error && <Loading label="Loading…" />}
        {res.data && tab === 'members' && <People me={me} data={res.data} reload={reload} />}
        {res.data && tab === 'access' && <Access data={res.data} reload={reload} />}
        {res.data && tab === 'permissions' && <Permissions />}
        {res.data && tab === 'activity' && <Activity data={res.data} />}
        {res.data && tab === 'settings' && <Settings data={res.data} reload={reload} />}
      </main>
    </div>
  );
}
