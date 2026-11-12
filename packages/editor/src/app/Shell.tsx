import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import '../app.css';
import { App } from '../App';
import { openHosted } from '../store';
import { Admin } from './Admin';
import { ApiError, Failed, Field, ErrorLine, get, Link, Loading, Modal, navigate, post, del, useAction, useLoad, usePath, ago, type Me, type OrgSummary } from './core';
import { Journey } from './Journey';
import { Projects } from './Projects';

function safeNext(fallback = '/'): string {
  const next = new URLSearchParams(location.search).get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : fallback;
}

function AuthFrame({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-mark" aria-hidden>◈</div>
        <h1 className="a-h1">{title}</h1>
        {sub && <p className="auth-sub">{sub}</p>}
        {children}
      </div>
    </main>
  );
}

/** What /api/me says about how this account signs in. */
interface Security { emailVerified: boolean; mfaEnabled: boolean; mfaRequired: boolean; recoveryLeft: number; mailDelivers: boolean }
const securityOf = (me: Me): Security => (me as Me & { security?: Security }).security ?? { emailVerified: true, mfaEnabled: false, mfaRequired: false, recoveryLeft: 0, mailDelivers: true };

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [code, setCode] = useState('');
  const { busy, error, run, setError } = useAction();
  const finish = () => {
    onDone();
    navigate(safeNext(), true);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let mfa = false;
    if (await run(async () => { mfa = !!(await post<{ mfa?: boolean }>('/api/auth/login', { email, password })).mfa; })) {
      if (mfa) setNeedCode(true);
      else finish();
    }
  };
  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const r = await post<{ recoveryLeft?: number }>('/api/auth/mfa', { code });
      if (r.recoveryLeft !== undefined && r.recoveryLeft <= 3) alert(`You have ${r.recoveryLeft} recovery codes left. Make new ones in Security.`);
      finish();
    } catch (err) {
      // the challenge lasts five minutes: after that, start again from the password
      if (err instanceof ApiError && err.extra.restart) { setNeedCode(false); setCode(''); }
      setError(err instanceof Error ? err.message : 'That did not work. Try again.');
    }
  };
  if (needCode) {
    return (
      <AuthFrame title="Two-step sign-in" sub="Enter the 6-digit code from your authenticator app, or one of your recovery codes.">
        <form className="a-form" onSubmit={(e) => void submitCode(e)}>
          <Field label="Code"><input className="a-input" inputMode="text" autoComplete="one-time-code" required autoFocus maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
          <ErrorLine error={error} />
          <button className="a-btn a-btn-primary" disabled={busy}>Sign in</button>
        </form>
        <p className="auth-foot"><button className="a-link" onClick={() => { setNeedCode(false); setCode(''); setError(null); }}>Use a different account</button></p>
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Sign in to Rangoli">
      <form className="a-form" onSubmit={(e) => void submit(e)}>
        <Field label="Email"><input className="a-input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input className="a-input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <button className="a-btn a-btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <p className="auth-foot"><Link href="/forgot">Forgot your password?</Link></p>
      <p className="auth-foot">New here? <Link href={`/signup${location.search}`}>Create an account</Link></p>
    </AuthFrame>
  );
}

function VerifyEmail({ token, reload }: { token: string; reload: () => Promise<void> }) {
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');
  useEffect(() => {
    post('/api/auth/verify', { token })
      .then(async () => { setState('done'); await reload(); })
      .catch((e: unknown) => { setState('failed'); setMessage(e instanceof Error ? e.message : ''); });
    // a link is used once: run this only for the token in the address
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (state === 'working') return <Loading label="Confirming your email…" />;
  if (state === 'failed') return <AuthFrame title="This link did not work" sub={message}><Link className="a-btn" href="/">Go to Rangoli</Link></AuthFrame>;
  return <AuthFrame title="Email confirmed" sub="You can now invite people, create agent tokens and approve work."><Link className="a-btn a-btn-primary" href="/">Continue</Link></AuthFrame>;
}

function Forgot() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run } = useAction();
  if (sent) return <AuthFrame title="Check your email" sub={`If ${email} has an account, a reset link is on its way. It expires in an hour.`}><Link className="a-btn" href="/login">Back to sign in</Link></AuthFrame>;
  return (
    <AuthFrame title="Reset your password">
      <form className="a-form" onSubmit={(e) => { e.preventDefault(); void run(() => post('/api/auth/forgot', { email })).then((ok) => ok && setSent(true)); }}>
        <Field label="Email"><input className="a-input" type="email" autoComplete="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <button className="a-btn a-btn-primary" disabled={busy}>Send reset link</button>
      </form>
      <p className="auth-foot"><Link href="/login">Back to sign in</Link></p>
    </AuthFrame>
  );
}

function Reset({ token }: { token: string }) {
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  return (
    <AuthFrame title="Choose a new password" sub="You will be signed out everywhere else.">
      <form className="a-form" onSubmit={(e) => { e.preventDefault(); void run(() => post('/api/auth/reset', { token, password })).then((ok) => ok && navigate('/login', true)); }}>
        <Field label="New password" hint="At least 10 characters"><input className="a-input" type="password" autoComplete="new-password" required minLength={10} autoFocus value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <button className="a-btn a-btn-primary" disabled={busy}>Set new password</button>
      </form>
    </AuthFrame>
  );
}

function SignupForm({ onDone, email: fixed, invite }: { onDone: () => void | Promise<void>; email?: string; invite?: string }) {
  const [email, setEmail] = useState(fixed ?? '');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      await post('/api/auth/signup', { email, name, password, invite });
      await onDone();
    });
  };
  return (
    <form className="a-form" onSubmit={(e) => void submit(e)}>
      <Field label="Your name"><input className="a-input" required maxLength={80} autoFocus autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Email"><input className="a-input" type="email" required readOnly={!!fixed} autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
      <Field label="Password" hint="At least 10 characters"><input className="a-input" type="password" required minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
      <ErrorLine error={error} />
      <button className="a-btn a-btn-primary" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
    </form>
  );
}

function Signup({ onDone }: { onDone: () => void }) {
  return (
    <AuthFrame title="Create your account">
      <SignupForm onDone={() => { onDone(); navigate(safeNext(), true); }} />
      <p className="auth-foot">Already have an account? <Link href={`/login${location.search}`}>Sign in</Link></p>
    </AuthFrame>
  );
}

function CreateOrg({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const { busy, error, run } = useAction();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    let slug = '';
    if (await run(async () => { slug = (await post<{ slug: string }>('/api/orgs', { name })).slug; })) {
      onDone();
      navigate(`/o/${slug}`, true);
    }
  };
  return (
    <AuthFrame title="Name your organization" sub="Projects, people and permissions live here. You will be its admin.">
      <form className="a-form" onSubmit={(e) => void submit(e)}>
        <Field label="Organization name"><input className="a-input" required maxLength={80} autoFocus value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <ErrorLine error={error} />
        <button className="a-btn a-btn-primary" disabled={busy}>Create organization</button>
      </form>
    </AuthFrame>
  );
}

function Invite({ token, me, reload }: { token: string; me: Me | null; reload: () => Promise<void> }) {
  const preview = useLoad(() => post<{ org_name: string; email: string; role: string; status: string }>('/api/invites/preview', { token }), [token]);
  const { busy, error, run } = useAction();
  if (preview.error) return <AuthFrame title="This invite does not exist" sub="Ask an admin of your organization for a new link." ><Link className="a-btn" href="/">Go to Rangoli</Link></AuthFrame>;
  if (!preview.data) return <Loading label="Checking your invite…" />;
  const inv = preview.data;
  const accept = async () => {
    let slug = '';
    if (await run(async () => { slug = (await post<{ slug: string }>('/api/invites/accept', { token })).slug; })) {
      await reload();
      navigate(`/o/${slug}`, true);
    }
  };
  if (inv.status !== 'valid') return <AuthFrame title={`This invite has ${inv.status === 'accepted' ? 'already been used' : `been ${inv.status}`}`} sub="Ask an admin of your organization for a new link."><Link className="a-btn" href="/">Go to Rangoli</Link></AuthFrame>;
  const sub = <>You are invited to <strong>{inv.org_name}</strong> as a <strong>{inv.role}</strong>.</>;
  if (me) {
    const wrongAccount = me.user.email !== inv.email;
    return (
      <AuthFrame title="Join your team" sub={sub}>
        {wrongAccount
          ? <p className="form-error">This invite is for {inv.email}, but you are signed in as {me.user.email}. Sign out and use that address.</p>
          : <button className="a-btn a-btn-primary a-btn-block" disabled={busy} onClick={() => void accept()}>Join {inv.org_name}</button>}
        <ErrorLine error={error} />
      </AuthFrame>
    );
  }
  return (
    <AuthFrame title="Join your team" sub={sub}>
      <SignupForm email={inv.email} invite={token} onDone={async () => { await post('/api/invites/accept', { token }).then((r) => { navigate(`/o/${(r as { slug: string }).slug}`, true); }); await reload(); }} />
      <p className="auth-foot">Already have an account? <Link href={`/login?next=${encodeURIComponent(`/invite/${token}`)}`}>Sign in</Link></p>
    </AuthFrame>
  );
}

const SCOPES: { id: string; label: string }[] = [
  { id: 'read', label: 'Read the design, its history, lint and renders' },
  { id: 'propose', label: 'Comment and suggest changes for a person to accept' },
  { id: 'draft', label: 'Edit the design directly where the project allows it' },
  { id: 'items', label: 'Read and write lifecycle items' },
  { id: 'export', label: 'Export code, images and prototypes' },
  { id: 'jobs', label: 'Take requests queued for agents and mark them done' },
];

interface TokenRow { id: string; name: string; scopes: string[]; legacy: boolean; expires_at: string; revoked_at: string | null; last_used_at: string | null; created_at: string; projects: { id: string; name: string | null }[] }

function tokenStatus(t: TokenRow): string {
  if (t.revoked_at) return `Revoked ${ago(t.revoked_at)}`;
  const left = new Date(t.expires_at).getTime() - Date.now();
  if (left <= 0) return 'Expired';
  const days = Math.ceil(left / 86400000);
  return t.legacy ? `Old-style token: stops working in ${days}d. Replace it.` : `Expires in ${days}d`;
}

function Tokens({ me, onClose, projectHint }: { me: Me; onClose: () => void; projectHint?: string }) {
  const list = useLoad(() => get<TokenRow[]>('/api/tokens'), []);
  const projects = useLoad(async () => {
    const all = await Promise.all(me.orgs.map(async (o) => ((await get<{ projects: { id: string; name: string }[] }>(`/api/orgs/${o.id}/projects`)).projects ?? []).map((p) => ({ id: p.id, name: p.name, org: o.name }))));
    return all.flat();
  }, [me.orgs]);
  const verified = securityOf(me).emailVerified;
  const [name, setName] = useState('');
  const [project, setProject] = useState(projectHint ?? '');
  const [scopes, setScopes] = useState<string[]>(['read', 'propose', 'draft']);
  const [days, setDays] = useState(90);
  const [made, setMade] = useState<{ token: string; project: string } | null>(null);
  const { busy, error, run } = useAction();
  const chosen = project || projects.data?.[0]?.id || '';
  const create = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      const r = await post<{ token: string }>('/api/tokens', { name, projects: [chosen], scopes, days });
      setMade({ token: r.token, project: chosen });
      setName('');
      await list.reload();
    });
  };
  const toggle = (id: string) => setScopes((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const url = `${location.origin}/d/${made?.project ?? '<project-id>'}/mcp`;
  return (
    <Modal title="Agent access" onClose={onClose}>
      <p className="a-muted">A token lets an AI agent work in one project, doing only what you tick, and never more than you can do yourself. It stops working when it expires, when you revoke it, or when you lose access.</p>
      {!verified ? (
        <p className="form-error">Confirm your email address before creating tokens. Use the link in the email we sent you.</p>
      ) : (
        <form className="a-form" onSubmit={(e) => void create(e)}>
          <Field label="Name"><input className="a-input" placeholder="e.g. Claude Code" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Project">
            <select className="a-input" required value={chosen} onChange={(e) => setProject(e.target.value)}>
              {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{me.orgs.length > 1 ? `${p.org} · ${p.name}` : p.name}</option>)}
            </select>
          </Field>
          <fieldset className="a-fieldset">
            <legend className="a-label">The agent may</legend>
            {SCOPES.map((s) => (
              <label key={s.id} className="a-radio"><input type="checkbox" checked={scopes.includes(s.id)} onChange={() => toggle(s.id)} /><span>{s.label}</span></label>
            ))}
          </fieldset>
          <Field label="Expires after">
            <select className="a-input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
              {[7, 30, 90, 180, 365].map((d) => <option key={d} value={d}>{d} days{d === 90 ? ' (recommended)' : ''}</option>)}
            </select>
          </Field>
          <ErrorLine error={error} />
          <div className="a-actions"><button className="a-btn a-btn-primary" disabled={busy || !chosen || scopes.length === 0}>Create token</button></div>
        </form>
      )}
      {made && (
        <div className="a-reveal">
          <p><strong>Copy this now.</strong> It is not shown again.</p>
          <code className="a-code">{made.token}</code>
          <p className="a-muted">Connect an agent:</p>
          <code className="a-code">claude mcp add --transport http rangoli {url} --header "Authorization: Bearer {made.token}"</code>
        </div>
      )}
      {list.data && list.data.length > 0 && (
        <ul className="a-list">
          {list.data.map((t) => (
            <li key={t.id} className="a-row">
              <div className="a-row-main">
                <span className="a-row-title">{t.name}</span>
                <span className="a-muted">{t.legacy ? 'All your projects' : t.projects.map((p) => p.name ?? 'A project you can no longer open').join(', ')} · {t.scopes.join(', ')}</span>
                <span className="a-muted">{tokenStatus(t)} · {t.last_used_at ? `Used ${ago(t.last_used_at)}` : 'Never used'}</span>
              </div>
              {!t.revoked_at && new Date(t.expires_at).getTime() > Date.now() && (
                <button className="a-link a-danger" onClick={() => void run(async () => { await del(`/api/tokens/${t.id}`); await list.reload(); })}>Revoke</button>
              )}
            </li>
          ))}
        </ul>
      )}
      <div className="a-actions"><button className="a-btn" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

/** Asks for the password (or a code) again when the server wants a fresh proof, then retries. */
function StepUp({ kind, onDone, onCancel }: { kind: 'password' | 'mfa'; onDone: () => void; onCancel: () => void }) {
  const [value, setValue] = useState('');
  const { busy, error, run } = useAction();
  return (
    <form className="a-form" onSubmit={(e) => { e.preventDefault(); void run(() => post('/api/auth/step-up', kind === 'mfa' ? { code: value } : { password: value })).then((ok) => ok && onDone()); }}>
      <p className="a-muted">{kind === 'mfa' ? 'Confirm it is you: enter a code from your authenticator app.' : 'Confirm it is you: enter your password.'}</p>
      <Field label={kind === 'mfa' ? 'Code' : 'Password'}>
        <input className="a-input" type={kind === 'mfa' ? 'text' : 'password'} autoComplete={kind === 'mfa' ? 'one-time-code' : 'current-password'} required autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <ErrorLine error={error} />
      <div className="a-actions"><button type="button" className="a-btn" onClick={onCancel}>Cancel</button><button className="a-btn a-btn-primary" disabled={busy}>Continue</button></div>
    </form>
  );
}

function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div className="a-reveal">
      <p><strong>Save these recovery codes now.</strong> Each one signs you in once if you lose your phone. They are not shown again.</p>
      <code className="a-code">{codes.join('\n')}</code>
    </div>
  );
}

function SecurityPanel({ me: initial, onClose }: { me: Me; onClose: () => void }) {
  const fresh = useLoad(() => get<Me>('/api/me'), []);
  const me = fresh.data ?? initial;
  const reload = fresh.reload;
  const sec = securityOf(me);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [stepUp, setStepUp] = useState<'password' | 'mfa' | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const { busy, error, run, setError } = useAction();
  const start = async () => {
    setError(null);
    try {
      setSetup(await post<{ secret: string; uri: string }>('/api/me/mfa/setup'));
    } catch (e) {
      if (e instanceof ApiError && (e.extra.stepUp === 'password' || e.extra.stepUp === 'mfa')) setStepUp(e.extra.stepUp);
      else setError(e instanceof Error ? e.message : 'That did not work.');
    }
  };
  const act = (path: string, after?: (r: { recoveryCodes?: string[] }) => void) => void run(async () => {
    const r = await post<{ recoveryCodes?: string[] }>(path, { code });
    setCode('');
    after?.(r);
    await reload();
  });
  return (
    <Modal title="Security" onClose={onClose}>
      <h3 className="a-h">Email</h3>
      {sec.emailVerified ? <p className="a-muted">{me.user.email} is confirmed.</p> : (
        <>
          <p className="a-muted">{me.user.email} is not confirmed yet. Until it is, you cannot invite people, create agent tokens or approve work.</p>
          {sent ? <p className="a-muted">{sec.mailDelivers ? 'A new link is on its way.' : 'This server has no mail sender: the link is in the server log.'}</p>
            : <button className="a-btn" disabled={busy} onClick={() => void run(async () => { await post('/api/me/verify'); setSent(true); })}>Send the link again</button>}
        </>
      )}

      <h3 className="a-h">Two-step sign-in</h3>
      {stepUp ? <StepUp kind={stepUp} onCancel={() => setStepUp(null)} onDone={() => { setStepUp(null); void start(); }} />
        : sec.mfaEnabled ? (
          <>
            <p className="a-muted">On. Signing in asks for a code from your authenticator app. {sec.recoveryLeft} recovery codes left.{sec.mfaRequired ? ' You approve work, so it has to stay on.' : ''}</p>
            <Field label="Current code or recovery code"><input className="a-input" autoComplete="one-time-code" maxLength={20} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <div className="a-actions">
              <button className="a-btn" disabled={busy || !code} onClick={() => act('/api/me/mfa/recovery', (r) => setCodes(r.recoveryCodes ?? null))}>Make new recovery codes</button>
              {!sec.mfaRequired && <button className="a-btn a-btn-danger" disabled={busy || !code} onClick={() => act('/api/me/mfa/disable')}>Turn off</button>}
            </div>
          </>
        ) : setup ? (
          <form className="a-form" onSubmit={(e) => { e.preventDefault(); act('/api/me/mfa/enable', (r) => { setCodes(r.recoveryCodes ?? null); setSetup(null); }); }}>
            <p className="a-muted">Add this key to an authenticator app (1Password, Google Authenticator, Authy…), then enter the code it shows.</p>
            <code className="a-code">{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
            <p className="a-muted">Or open this setup link on the device with the app:</p>
            <code className="a-code">{setup.uri}</code>
            <Field label="Code from the app"><input className="a-input" inputMode="numeric" autoComplete="one-time-code" required autoFocus maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            <div className="a-actions"><button type="button" className="a-btn" onClick={() => setSetup(null)}>Cancel</button><button className="a-btn a-btn-primary" disabled={busy}>Turn on</button></div>
          </form>
        ) : (
          <>
            <p className="a-muted">{sec.mfaRequired ? 'You approve work, so two-step sign-in is required before you can approve.' : 'Off. Turn it on so a stolen password is not enough to get in.'}</p>
            <button className="a-btn a-btn-primary" disabled={busy} onClick={() => void start()}>Set up two-step sign-in</button>
          </>
        )}
      {codes && <RecoveryCodes codes={codes} />}
      <ErrorLine error={error} />
      <div className="a-actions"><button className="a-btn" onClick={onClose}>Done</button></div>
    </Modal>
  );
}

/** One line under the top bar while the account still owes a step. */
function AccountNotice({ me, onOpen }: { me: Me; onOpen: () => void }) {
  const sec = securityOf(me);
  const text = !sec.emailVerified ? `Confirm ${me.user.email}: check your inbox for the link. Until then you cannot invite people, create agent tokens or approve work.`
    : sec.mfaRequired && !sec.mfaEnabled ? 'You approve work: turn on two-step sign-in before your next approval.' : null;
  if (!text) return null;
  return <div className="a-reveal" role="status">{text} <button className="a-link" onClick={onOpen}>Open security settings</button></div>;
}

export function TopBar({ me, org, trail, children }: { me: Me; org?: OrgSummary; trail?: ReactNode; children?: ReactNode }) {
  const [menu, setMenu] = useState(false);
  const [tokens, setTokens] = useState(false);
  const [security, setSecurity] = useState(false);
  const signOut = async () => {
    await post('/api/auth/logout');
    location.href = '/login';
  };
  return (
    <header className="a-top">
      <div className="a-top-left">
        <Link href="/" className="a-logo" aria-label="Rangoli home">◈</Link>
        {org && me.orgs.length > 1
          ? <select className="a-orgs" aria-label="Organization" value={org.slug} onChange={(e) => navigate(`/o/${e.target.value}`)}>{me.orgs.map((o) => <option key={o.id} value={o.slug}>{o.name}</option>)}</select>
          : org && <Link className="a-crumb" href={`/o/${org.slug}`}>{org.name}</Link>}
        {trail}
      </div>
      <div className="a-top-right">
        {children}
        <div className="a-menu-wrap">
          <button className="a-avatar" aria-haspopup="menu" aria-expanded={menu} aria-label={`Account: ${me.user.name}`} onClick={() => setMenu(!menu)}>{me.user.name.slice(0, 1).toUpperCase()}</button>
          {menu && (
            <div className="a-menu" role="menu" onClick={() => setMenu(false)}>
              <div className="a-menu-head"><strong>{me.user.name}</strong><span className="a-muted">{me.user.email}</span></div>
              <button role="menuitem" onClick={() => setTokens(true)}>Agent access</button>
              <button role="menuitem" onClick={() => setSecurity(true)}>Security</button>
              <button role="menuitem" onClick={() => navigate('/new-org')}>New organization</button>
              <button role="menuitem" onClick={() => void signOut()}>Sign out</button>
            </div>
          )}
        </div>
      </div>
      <AccountNotice me={me} onOpen={() => setSecurity(true)} />
      {tokens && <Tokens me={me} onClose={() => setTokens(false)} projectHint={/^\/p\/([0-9a-f-]{36})/.exec(location.pathname)?.[1]} />}
      {security && <SecurityPanel me={me} onClose={() => setSecurity(false)} />}
    </header>
  );
}

function DesignPage({ projectId, me }: { projectId: string; me: Me }) {
  const j = useLoad(() => get<{ project: { name: string; stage: string } }>(`/api/projects/${projectId}/journey`), [projectId]);
  const [ready, setReady] = useState(false);
  const stage = j.data?.project.stage;
  const name = j.data?.project.name;
  useEffect(() => {
    if (!stage || !name) return;
    openHosted({ projectId, projectName: name, stage }, me.user.name);
    setReady(true);
    return () => openHosted(null, '');
  }, [projectId, name, stage, me.user.name]);
  if (j.error) return <Failed error={j.error} retry={() => void j.reload()} />;
  if (!ready) return <Loading label="Opening the canvas…" />;
  return <App key={projectId} />;
}

export function Shell() {
  const path = usePath();
  const me = useLoad(() => get<Me>('/api/me'), []);
  const pathname = path.split('?')[0]!;
  const invite = /^\/invite\/([\w-]+)$/.exec(pathname);
  const reset = /^\/reset\/([\w-]+)$/.exec(pathname);
  const verify = /^\/verify\/([\w-]+)$/.exec(pathname);
  const reload = me.reload;
  const signedOut = me.error?.status === 401;

  useEffect(() => {
    if (signedOut && !invite && !/^\/(login|signup|forgot|reset|verify)/.test(pathname)) navigate(`/login?next=${encodeURIComponent(pathname)}`, true);
    if (me.data && ['/login', '/signup'].includes(pathname)) navigate(safeNext(), true);
  }, [signedOut, invite, pathname, me.data]);

  if (reset) return <Reset token={reset[1]!} />;
  if (verify) return <VerifyEmail token={verify[1]!} reload={reload} />;
  if (pathname === '/forgot') return <Forgot />;
  if (invite && (me.data || signedOut)) return <Invite token={invite[1]!} me={me.data} reload={reload} />;
  if (pathname === '/login') return signedOut ? <Login onDone={() => void reload()} /> : <Loading label="Loading…" />;
  if (pathname === '/signup') return signedOut ? <Signup onDone={() => void reload()} /> : <Loading label="Loading…" />;
  if (me.error && !signedOut) return <Failed error={me.error} retry={() => void reload()} />;
  if (!me.data) return <Loading label="Loading…" />;
  const data = me.data;

  if (pathname === '/new-org' || data.orgs.length === 0) return <CreateOrg onDone={() => void reload()} />;
  if (pathname === '/') {
    const last = (() => { try { return localStorage.getItem('rangoli.org'); } catch { return null; } })();
    const org = data.orgs.find((o) => o.slug === last) ?? data.orgs[0]!;
    navigate(`/o/${org.slug}`, true);
    return null;
  }
  const o = /^\/o\/([\w-]+)(\/admin(?:\/(\w+))?)?$/.exec(pathname);
  if (o) {
    const org = data.orgs.find((x) => x.slug === o[1]);
    if (!org) return <Failed error={{ status: 404, message: '' } as never} />;
    try { localStorage.setItem('rangoli.org', org.slug); } catch { /* private mode */ }
    if (!o[2]) return <Projects me={data} org={org} />;
    if (!org.can.includes('org.members.manage')) return <Failed error={{ status: 404, message: '' } as never} />;
    return <Admin me={data} org={org} tab={o[3] ?? 'members'} />;
  }
  const p = /^\/p\/([0-9a-f-]{36})(?:\/([a-z]+))?$/.exec(pathname);
  if (p) {
    if (p[2] === 'design') return <DesignPage projectId={p[1]!} me={data} />;
    return <Journey me={data} projectId={p[1]!} stage={p[2]} />;
  }
  return <Failed error={{ status: 404, message: '' } as never} />;
}
