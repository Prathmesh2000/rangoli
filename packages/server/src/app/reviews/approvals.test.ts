import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, withUser, type Database } from '../db.js';
import { fromBase32, stepAt, totpAt } from '../identity/totp.js';
import type { MailMessage } from '../infra.js';
import { startApp, type AppServer } from '../server.js';

/**
 * Version-bound approvals over HTTP (work packages 11 and 17), including ARCHITECTURE §9's approval invariants:
 * a token change alters every screen using it, a used asset cannot be deleted, an approver's name survives their
 * account, nobody approves their own review (admins included), and a token session never approves.
 */

type Res = { status: number; body: any; text: string; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

const mailbox: MailMessage[] = [];

class Person {
  cookie = '';
  id = '';
  constructor(public base: string, readonly email: string, readonly name: string) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(this.base + path, {
      method,
      redirect: 'manual',
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? (method === 'GET' || method === 'HEAD' ? undefined : '{}') : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b?: unknown) => this.call('POST', p, b);
  patch = (p: string, b?: unknown) => this.call('PATCH', p, b);
  put = (p: string, b?: unknown) => this.call('PUT', p, b);
  del = (p: string) => this.call('DELETE', p);
  async signup() {
    expect((await this.post('/api/auth/signup', { email: this.email, name: this.name, password: 'correct horse battery' })).status).toBe(200);
    const mail = [...mailbox].reverse().find((m) => m.to.includes(this.email) && /\/verify\//.test(m.text));
    expect((await this.post('/api/auth/verify', { token: /\/verify\/([\w-]+)/.exec(mail!.text)![1] })).status).toBe(200);
    this.id = (await this.get('/api/me')).body.user.id;
    return this;
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

describe('version-bound approvals', () => {
  let db: Database;
  let owner: Database;
  let app: AppServer;
  let base = '';
  const mail = { delivers: true, send: async (m: MailMessage) => void mailbox.push(m) };
  let asha: Person, dee: Person, rae: Person, ada: Person, vic: Person, eve: Person;
  let org = '';
  let project = '';
  let raeSecret = '';
  let firstSnapshot = '';
  let firstApproval = '';
  let shareUrl = '';

  const P = () => `/api/projects/${project}`;
  const design = (script: string, who: Person = dee, p = project) => who.post(`/d/${p}/api/rdl`, { script });
  const review = async (who: Person = dee, p = project) => {
    const r = await who.get(`/api/projects/${p}/review`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body;
  };
  const screen = (r: { changes: { screens: { name: string }[] } }, name: string) => r.changes.screens.find((s) => s.name === name) as { key: string; changed: boolean; approvedHash: string | null; hash: string };
  /** A second factor proved now, as the step-up route would record it (for people without an authenticator here). */
  const withMfa = async <T,>(p: Person, fn: () => Promise<T>): Promise<T> => {
    await owner.tx(async (q) => {
      await q(`UPDATE users SET mfa_secret_enc = 'v1.test', mfa_enabled_at = now() WHERE id = $1 AND mfa_enabled_at IS NULL`, [p.id]);
      await q(`UPDATE auth_sessions SET mfa_at = now() WHERE user_id = $1`, [p.id]);
    });
    return fn();
  };
  const invite = async (p: Person, projectRole: string, projects: string[], role = 'member') => {
    const r = await asha.post(`/api/orgs/${org}/invites`, { email: p.email, role, projects, projectRole });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    await p.signup();
    expect((await p.post('/api/invites/accept', { token: (r.body.url as string).split('/invite/')[1] })).status).toBe(200);
  };

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    owner = await openDatabase({ url });
    db = process.env.TEST_APP_DATABASE_URL ? await openDatabase({ url, appUrl: process.env.TEST_APP_DATABASE_URL }) : owner;
    app = await startApp({ db, port: 0, mail });
    base = app.url.replace(/\/$/, '');
    asha = await new Person(base, 'asha@snap.io', 'Asha').signup();
    org = (await asha.post('/api/orgs', { name: 'Snap Co' })).body.id;
    project = (await asha.post(`/api/orgs/${org}/projects`, { name: 'Checkout', workType: 'feature' })).body.id;
    dee = new Person(base, 'dee@snap.io', 'Dee');
    rae = new Person(base, 'rae@snap.io', 'Rae');
    ada = new Person(base, 'ada@snap.io', 'Ada');
    vic = new Person(base, 'vic@snap.io', 'Vic');
    await invite(dee, 'designer', [project]);
    await invite(rae, 'reviewer', [project]);
    await invite(ada, 'lead', [project], 'admin');
    await invite(vic, 'viewer', [project]);
    expect((await asha.put(`${P()}/members/${ada.id}`, { role: 'lead', approver: true })).status).toBe(200);
    eve = await new Person(base, 'eve@evil.io', 'Eve').signup();
    await eve.post('/api/orgs', { name: 'Evil' });
    await owner.tx((q) => q(`UPDATE projects SET stage = 'visual' WHERE id = $1`, [project]));
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (owner !== db) await owner?.close();
  });

  it('asking for review takes a hashed, signed snapshot and binds the approval to it', async () => {
    expect((await design('token color.test.one #112233')).status).toBe(200);
    expect((await design('Frame name:Tokened w100 h100 fill:color.test.one')).status).toBe(200);
    expect((await design('Frame name:Plain w100 h100 fill:#ff0000')).status).toBe(200);
    // the snapshot freezes the plan too
    expect((await dee.post(`${P()}/items`, { kind: 'screen', title: 'Pay' })).status).toBe(200);
    expect((await dee.post(`${P()}/review/request`, { approvers: [dee.id] })).status).toBe(400); // not yourself
    expect((await dee.post(`${P()}/review/request`, { approvers: [vic.id] })).status).toBe(400); // not an approver
    expect((await dee.post(`${P()}/review/request`, { rule: 'all' })).status).toBe(400); // all of whom?
    const r = await dee.post(`${P()}/review/request`, { note: 'Visual pass', approvers: [rae.id, ada.id], rule: 'any' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.snapshot.contentHash).toMatch(HEX64);
    firstSnapshot = r.body.snapshot.id;
    firstApproval = r.body.approval.id;
    const snap = (await vic.get(`${P()}/snapshots/${firstSnapshot}`)).body;
    expect(snap).toMatchObject({ kind: 'review', canon_version: 'rangoli-canon@1', created_by_name: 'Dee' });
    expect(snap.engine_version).toMatch(/^@rangoli\/engine@\d/);
    expect(snap.signature).toMatch(HEX64);
    expect(snap.screens.map((s: { name: string }) => s.name).sort()).toEqual(['Plain', 'Tokened']);
    for (const s of snap.screens) expect(s.screen_hash).toMatch(HEX64);
    expect((await vic.get(`${P()}/snapshots/${firstSnapshot}/verify`)).body).toMatchObject({ intact: true, signed: true });
    // a snapshot is immutable, even to its maker's own SQL
    await expect(withUser(db, dee.id, (q) => q(`UPDATE snapshots SET name = 'x' WHERE id = $1`, [firstSnapshot]))).rejects.toBeTruthy();
    expect((await eve.get(`${P()}/snapshots/${firstSnapshot}`)).status).toBe(404);
  });

  it('editing continues while the review is open', async () => {
    const before = await review();
    const plain = screen(before, 'Plain');
    expect((await design(`insert #${plain.key} end\n  Frame w10 h10`)).status).toBe(200);
    const r = await review();
    expect(r.approvals[0]).toMatchObject({ id: firstApproval, status: 'open', rule: 'any', approverNames: ['Rae', 'Ada'] });
    expect(r.latestApproved).toBeNull();
    expect(screen(r, 'Plain').changed).toBe(false); // nothing approved to compare with yet
  });

  it('approving needs MFA proved within five minutes, recorded with the decision', async () => {
    const decide = (who: Person, body: object = { decision: 'approved', note: 'Looks right' }) => who.post(`${P()}/approvals/${firstApproval}/decisions`, body);
    const noMfa = await decide(rae);
    expect(noMfa.status).toBe(403);
    expect(noMfa.body.mfaSetup).toBe(true);
    // turn on two-step sign-in the way a person does
    raeSecret = (await rae.post('/api/me/mfa/setup')).body.secret;
    expect((await rae.post('/api/me/mfa/enable', { code: totpAt(fromBase32(raeSecret), stepAt(Date.now())) })).status).toBe(200);
    // an old proof is not enough
    await owner.tx((q) => q(`UPDATE auth_sessions SET mfa_at = now() - interval '6 minutes' WHERE user_id = $1`, [rae.id]));
    const stale = await decide(rae);
    expect(stale.status).toBe(403);
    expect(stale.body.stepUp).toBe('mfa');
    expect((await rae.post('/api/auth/step-up', { code: totpAt(fromBase32(raeSecret), stepAt(Date.now()) + 1) })).status).toBe(200);
    // open checks are exceptions, accepted with a note
    const bare = await decide(rae, { decision: 'approved' });
    if (bare.status === 400) expect(bare.body.exceptions.length).toBeGreaterThan(0);
    const ok = await decide(rae);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.status).toBe('approved');
    expect(ok.body.mfaAt).toBeTruthy();
    expect(ok.body.decision).toMatchObject({ snapshot_id: firstSnapshot });
    const r = await review();
    const d = r.approvals[0].decisions[0];
    expect(d).toMatchObject({ approver: rae.id, approver_name: 'Rae', decision: 'approved', via: 'app', snapshot_id: firstSnapshot });
    expect(d.mfa_at).toBeTruthy();
    for (const e of d.exceptions) expect(e.note).toBeTruthy();
    expect(r.latestApproved).toMatchObject({ id: firstSnapshot });
    expect(r.latestApproved.approvedBy.map((x: { name: string }) => x.name)).toEqual(['Rae']);
  });

  it('screens show "Changed since approved", and a token change alters every screen using it', async () => {
    // Plain was edited after the review was asked for, so the approved version is the one without that edit
    let r = await review();
    expect(screen(r, 'Plain').changed).toBe(true);
    expect(screen(r, 'Plain').approvedHash).toMatch(HEX64);
    expect(screen(r, 'Tokened').changed).toBe(false);
    expect((await design('token color.test.one #445566')).status).toBe(200);
    r = await review();
    expect(screen(r, 'Tokened').changed).toBe(true);
    // the approved version itself never moved
    expect((await vic.get(`${P()}/snapshots/${firstSnapshot}/verify`)).body.intact).toBe(true);
  });

  it('handoff and exports read the latest approved snapshot; the working copy says Unapproved', async () => {
    const approved = await dee.get(`${P()}/handoff`);
    expect(approved.status).toBe(200);
    expect(approved.headers.get('x-rangoli-approval')).toBe('Approved');
    expect(approved.body).toMatchObject({ approval: 'Approved', unapproved: false, snapshot: { id: firstSnapshot } });
    expect(approved.body.approvedBy.map((x: { name: string }) => x.name)).toEqual(['Rae']);
    expect(approved.body.tokens.color.test.one.$value ?? JSON.stringify(approved.body.tokens)).toContain('112233');
    const working = await dee.get(`${P()}/handoff?snapshot=working`);
    expect(working.headers.get('x-rangoli-approval')).toBe('Unapproved');
    expect(working.body).toMatchObject({ approval: 'Unapproved', unapproved: true, snapshot: null });
    expect(JSON.stringify(working.body.tokens)).toContain('445566');
    expect((await dee.get(`${P()}/handoff?snapshot=nope`)).status).toBe(400);
    expect((await rae.get(`${P()}/handoff`)).status).toBe(403); // reviewers do not take handoff
    expect((await eve.get(`${P()}/handoff`)).status).toBe(404);

    const html = await dee.get(`${P()}/export.html`);
    expect(html.status).toBe(200);
    expect(html.headers.get('x-rangoli-approval')).toBe('Approved');
    expect(html.text).not.toMatch(/<script/i);
    expect(html.headers.get('content-security-policy')).toMatch(/sandbox$/);
    const wip = await dee.get(`${P()}/export.html?snapshot=working`);
    expect(wip.headers.get('x-rangoli-approval')).toBe('Unapproved');
    expect(wip.text).toContain('Unapproved');
    expect(wip.headers.get('content-disposition')).toMatch(/unapproved/);
  });

  it('nobody approves their own review, admins and leads included, and only named approvers decide', async () => {
    // moving on is never blocked: Visual, Prototype, Testing, then Handoff
    while ((await review()).project.stage !== 'handoff') expect((await dee.post(`${P()}/advance`)).status).toBe(200);
    const r = await ada.post(`${P()}/review/request`, { approvers: [rae.id] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const id = r.body.approval.id as string;
    const own = await withMfa(ada, () => ada.post(`${P()}/approvals/${id}/decisions`, { decision: 'approved', note: 'mine' }));
    expect(own.status).toBe(403);
    expect(own.body.error).toMatch(/someone else/);
    // the owner is a lead and an approver, but the review names Rae
    const notNamed = await withMfa(asha, () => asha.post(`${P()}/approvals/${id}/decisions`, { decision: 'approved', note: 'ok' }));
    expect(notNamed.status).toBe(403);
    expect(notNamed.body.error).toMatch(/names its approvers/);
    expect((await dee.post(`${P()}/approvals/${id}/decisions`, { decision: 'approved', note: 'ok' })).status).toBe(403); // not an approver
    expect((await vic.post(`${P()}/approvals/${id}/decisions`, { decision: 'approved', note: 'ok' })).status).toBe(403);
    // withdrawing closes it; deciding a withdrawn review is refused
    expect((await ada.post(`${P()}/review/withdraw`)).status).toBe(200);
    expect((await withMfa(rae, () => rae.post(`${P()}/approvals/${id}/decisions`, { decision: 'approved', note: 'ok' }))).status).toBe(409);
    expect((await review()).approvals.find((a: { id: string }) => a.id === id).status).toBe('withdrawn');
  });

  it('an API token never approves, whatever its scopes', async () => {
    const t = await rae.post('/api/tokens', { name: 'agent', projects: [project], scopes: ['read', 'propose', 'draft', 'items', 'export', 'jobs'] });
    expect(t.status).toBe(200);
    const anon = new Person(base, '', '');
    const bearer = { authorization: `Bearer ${t.body.token}` };
    expect((await anon.call('POST', `${P()}/approvals/${firstApproval}/decisions`, { decision: 'approved', note: 'x' }, bearer)).status).toBe(401);
    expect((await anon.call('POST', `${P()}/signoff`, { decision: 'approved', note: 'x' }, bearer)).status).toBe(401);
  });

  it('share links are snapshot-only, static, hashed, expiring and revocable', async () => {
    expect((await vic.post(`${P()}/share-links`, { snapshot: firstSnapshot })).status).toBe(403);
    const made = await dee.post(`${P()}/share-links`, { snapshot: firstSnapshot, kind: 'stakeholder' });
    expect(made.status).toBe(200);
    shareUrl = made.body.url;
    const token = shareUrl.split('/s/')[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 256 bits
    expect(new Date(made.body.expires_at).getTime() - Date.now()).toBeGreaterThan(29 * 86400_000);
    expect(new Date(made.body.expires_at).getTime() - Date.now()).toBeLessThan(31 * 86400_000);
    const stored = await owner.tx((q) => q<{ token_hash: string }>(`SELECT token_hash FROM share_links WHERE id = $1`, [made.body.id]));
    expect(stored[0]!.token_hash).toMatch(HEX64);
    expect(stored[0]!.token_hash).not.toContain(token);
    await expect(withUser(db, dee.id, (q) => q(`SELECT token_hash FROM share_links`))).rejects.toMatchObject({ code: '42501' });

    const anon = new Person(base, '', '');
    const page = await anon.get(`/s/${token}`);
    expect(page.status).toBe(200);
    expect(page.text).toMatch(/review · cycle 1/);
    expect(page.text).not.toMatch(/<script/i);
    const csp = page.headers.get('content-security-policy')!;
    expect(csp).toMatch(/sandbox$/);
    expect(csp).not.toMatch(/allow-scripts/);
    expect(csp).toMatch(/default-src 'none'/);
    expect(page.headers.get('x-robots-tag')).toMatch(/noindex/);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.text).toContain('<meta name="robots" content="noindex');
    // the frozen version, not the working copy
    expect(page.text).toContain('#112233');
    expect(page.text).not.toContain('#445566');
    expect((await anon.post(`/s/${token}`, {})).status).toBe(405);
    expect((await anon.get(`/s/${token}/handoff.json`)).status).toBe(404); // stakeholder links are view-only pages
    expect((await anon.get(`/s/${'A'.repeat(43)}`)).status).toBe(404);

    const dev = await dee.post(`${P()}/share-links`, { snapshot: firstSnapshot, kind: 'developer', days: 7 });
    expect(dev.status).toBe(200);
    const bundle = await anon.get(`/s/${dev.body.url.split('/s/')[1]}/handoff.json`);
    expect(bundle.status).toBe(200);
    expect(bundle.body).toMatchObject({ approval: 'Approved', snapshot: { id: firstSnapshot } });

    expect((await dee.del(`${P()}/share-links/${made.body.id}`)).status).toBe(200);
    expect((await anon.get(`/s/${token}`)).status).toBe(404);
    await owner.tx((q) => q(`UPDATE share_links SET expires_at = created_at + interval '1 millisecond' WHERE id = $1`, [dev.body.id]));
    expect((await anon.get(`/s/${dev.body.url.split('/s/')[1]}`)).status).toBe(404);
  });

  it('a stakeholder link to an open review leads to signing in to approve', async () => {
    // a fresh review on Handoff, then a link to its snapshot
    const r = await dee.post(`${P()}/review/request`, {});
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const link = await dee.post(`${P()}/share-links`, { snapshot: r.body.snapshot.id });
    const page = await new Person(base, '', '').get(`/s/${link.body.url.split('/s/')[1]}`);
    expect(page.text).toContain(`/p/${project}/review?approval=${r.body.approval.id}`);
    // approving from it is the app's decision route: signed in, verified, MFA
    const ok = await withMfa(asha, () => asha.post(`${P()}/approvals/${r.body.approval.id}/decisions`, { decision: 'approved', note: 'Seen on the link', via: 'link' }));
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await review()).approvals[0].decisions[0]).toMatchObject({ via: 'link', approver_name: 'Asha' });
  });

  it('a used asset cannot be deleted, an unused one can', async () => {
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const up = await dee.post(`/d/${project}/api/assets`, { name: 'hero', dataUrl: png });
    expect(up.status).toBe(200);
    expect((await design(`Frame name:Pic w100 h100 fill:image(${up.body.id})`)).status).toBe(200);
    const snap = await dee.post(`${P()}/snapshots`, { name: 'With picture' });
    expect(snap.status, JSON.stringify(snap.body)).toBe(200);
    const used = await owner.tx((q) => q<{ sha256: string }>(`SELECT sha256 FROM snapshot_assets WHERE snapshot_id = $1`, [snap.body.id]));
    expect(used).toHaveLength(1);
    expect(used[0]!.sha256).toMatch(HEX64);
    expect(up.body.id).toBe(used[0]!.sha256.slice(0, 12));
    await expect(withUser(db, dee.id, (q) => q(`DELETE FROM design_assets WHERE project_id = $1 AND file = $2`, [project, up.body.file]))).rejects.toThrow(/part of a saved snapshot/);
    await expect(owner.tx((q) => q(`DELETE FROM design_assets WHERE project_id = $1 AND file = $2`, [project, up.body.file]))).rejects.toThrow(/part of a saved snapshot/);
    const other = await dee.post(`/d/${project}/api/assets`, { name: 'spare', dataUrl: png.replace('ASUVORK5CYII', 'ASUVORK5CYIJ') });
    if (other.status === 200 && other.body.file !== up.body.file) {
      expect(await withUser(db, dee.id, (q) => q(`DELETE FROM design_assets WHERE project_id = $1 AND file = $2 RETURNING 1`, [project, other.body.file]))).toHaveLength(1);
    }
    // a static render of the snapshot carries the image inline
    const page = await dee.get(`${P()}/snapshots/${snap.body.id}/render`);
    expect(page.text).toContain('data:image/png;base64,');
  });

  it('a team release references an approved snapshot; strict mode refuses one without', async () => {
    expect((await rae.post(`${P()}/releases`, {})).status).toBe(403); // reviewers do not release
    const rel = await dee.post(`${P()}/releases`, { notes: 'First ship', checklist: [{ label: 'QA signed', done: true }] });
    expect(rel.status, JSON.stringify(rel.body)).toBe(200);
    expect(rel.body).toMatchObject({ basis: 'approval', releasedBy: 'Dee', label: 'Approved and released' });
    expect(rel.body.checklist.some((x: { label: string }) => x.label === 'QA signed')).toBe(true);

    // a project with nothing approved
    const bare = (await asha.post(`/api/orgs/${org}/projects`, { name: 'Bare' })).body.id as string;
    expect((await design('Frame name:Lone w50 h50', asha, bare)).status).toBe(200);
    const loose = await asha.post(`/api/projects/${bare}/releases`, {});
    expect(loose.status).toBe(200);
    expect(loose.body).toMatchObject({ basis: 'unapproved', label: 'Released without approval' });
    expect(loose.body.warnings.length).toBeGreaterThan(0);
    expect((await asha.patch(`/api/orgs/${org}/settings`, { strictMode: true })).status).toBe(200);
    const strict = await asha.post(`/api/projects/${bare}/releases`, {});
    expect(strict.status).toBe(409);
    expect(strict.body.strict).toBe(true);
    // the database holds the same line, whatever the app says
    const [snap] = await owner.tx((q) => q<{ id: string }>(`SELECT id FROM snapshots WHERE project_id = $1 LIMIT 1`, [bare]));
    await expect(withUser(db, asha.id, (q) => q(`INSERT INTO releases (project_id, org_id, cycle, snapshot_id, basis, released_by) VALUES ($1, $2, 1, $3, 'unapproved', app_uid())`, [bare, org, snap!.id]))).rejects.toThrow(/Strict mode/);
    await expect(withUser(db, asha.id, (q) => q(`INSERT INTO releases (project_id, org_id, cycle, snapshot_id, basis, released_by) VALUES ($1, $2, 1, $3, 'solo', app_uid())`, [bare, org, snap!.id]))).rejects.toThrow(/one-person/);
    expect((await asha.patch(`/api/orgs/${org}/settings`, { strictMode: false })).status).toBe(200);
  });

  it('a fix starts from a released frame with a note, and shows before and after', async () => {
    const r = await review();
    const release = r.releases.find((x: { basis: string }) => x.basis === 'approval');
    const snap = (await dee.get(`${P()}/snapshots/${release.snapshot_id}`)).body;
    const frame = snap.screens.find((s: { name: string }) => s.name === 'Plain').screen_key as string;
    expect((await dee.post(`${P()}/releases/${release.id}/fixes`, { frame, note: '' })).status).toBe(400);
    expect((await dee.post(`${P()}/releases/${release.id}/fixes`, { frame: 'nope', note: 'x' })).status).toBe(400);
    const fix = await dee.post(`${P()}/releases/${release.id}/fixes`, { frame, note: 'Tighten the padding' });
    expect(fix.status, JSON.stringify(fix.body)).toBe(200);
    let f = (await dee.get(`${P()}/fixes/${fix.body.id}`)).body;
    expect(f.note).toBe('Tighten the padding');
    expect((await design(`insert #${frame} end\n  Frame w5 h5`)).status).toBe(200);
    f = (await dee.get(`${P()}/fixes/${fix.body.id}`)).body;
    expect(f.before.hash).toMatch(HEX64);
    expect(f.after.changed).toBe(true);
    expect(f.after.hash).not.toBe(f.before.hash);
    const before = await dee.get(f.before.url);
    expect(before.status).toBe(200);
    expect(before.headers.get('content-security-policy')).toMatch(/frame-ancestors 'self'/);
    const after = await dee.get(f.after.url);
    expect(after.headers.get('x-rangoli-approval')).toBe('Unapproved');
    const ws = (await dee.get(`${P()}/journey`)).body.workstreams;
    expect(ws.some((w: { name: string; work_type: string }) => w.work_type === 'fix' && w.name.startsWith('Fix: Plain'))).toBe(true);
  });

  it('a solo organization releases as "released by", never approved', async () => {
    const sol = await new Person(base, 'sol@solo.io', 'Sol').signup();
    const o = (await sol.post('/api/orgs', { name: 'Solo' })).body.id;
    const p = (await sol.post(`/api/orgs/${o}/projects`, { name: 'Side' })).body.id;
    expect((await design('Frame name:Only w50 h50', sol, p)).status).toBe(200);
    const r = await sol.post(`/api/projects/${p}/releases`, { notes: 'v1' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ basis: 'solo', label: 'Released by Sol' });
    const view = (await sol.get(`/api/projects/${p}/review`)).body;
    expect(view.solo).toBe(true);
    expect(view.releases[0]).toMatchObject({ basis: 'solo', released_by_name: 'Sol' });
  });

  it("an approver's name survives the deletion of their account", async () => {
    await owner.tx((q) => q(`DELETE FROM users WHERE id = $1`, [rae.id]));
    const r = await review();
    const first = r.approvals.find((a: { id: string }) => a.id === firstApproval);
    expect(first.status).toBe('approved');
    expect(first.decisions[0].approver_name).toBe('Rae');
    expect(first.decisions[0].approver).toMatch(/^former:/);
    expect((await vic.get(`${P()}/snapshots/${firstSnapshot}/verify`)).body).toMatchObject({ intact: true, signed: true });
  });

  it('deleting the project still works with snapshots holding its images', async () => {
    expect((await asha.del(P())).status).toBe(200);
    expect(await owner.tx((q) => q(`SELECT 1 FROM snapshots WHERE project_id = $1`, [project]))).toHaveLength(0);
    expect((await new Person(base, '', '').get(`/s/${shareUrl.split('/s/')[1]}`)).status).toBe(404);
  });
});
