import type { IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, withUser, type Database } from '../db.js';
import { addressKey, clientIp } from '../http/client-ip.js';
import { cookies } from '../http/headers.js';
import { isInside } from '../http/static.js';
import type { As } from '../http/context.js';
import { logMailer, type MailMessage } from '../infra.js';
import { startApp, type AppServer } from '../server.js';
import { parseKey, resolveIdentityConfig } from './config.js';
import { scopeForTool, toolRefusal } from './scopes.js';
import { secretBox } from './secret-box.js';
import { createSessions, createStepUp } from './sessions.js';
import { base32, fromBase32, looksLikeRecovery, newRecoveryCodes, stepAt, totpAt, verifyTotp } from './totp.js';

type Res = { status: number; body: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

const fakeReq = (headers: Record<string, string | string[]>, remoteAddress = '10.0.0.9') => ({ headers, socket: { remoteAddress } }) as unknown as IncomingMessage;

// ---------------------------------------------------------------- units

describe('http helpers', () => {
  it('a malformed cookie is kept raw instead of throwing', () => {
    expect(() => cookies(fakeReq({ cookie: 'a=%E0%A4%A; b=ok%20x' }))).not.toThrow();
    expect(cookies(fakeReq({ cookie: 'a=%E0%A4%A; b=ok%20x; =x; c' }))).toEqual({ a: '%E0%A4%A', b: 'ok x' });
    // the first of two same-named cookies wins, and prototype keys are plain keys
    expect(cookies(fakeReq({ cookie: 'k=1; k=2; __proto__=x' })).k).toBe('1');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('a static file must sit below the editor directory, past a separator', () => {
    expect(isInside('/srv/editor/dist', '/srv/editor/dist/assets/a.js')).toBe(true);
    expect(isInside('/srv/editor/dist', '/srv/editor/dist-private/secret.txt')).toBe(false);
    expect(isInside('/srv/editor/dist', '/srv/editor/distx')).toBe(false);
    expect(isInside('/srv/editor/dist', '/srv/editor/dist')).toBe(false);
    expect(isInside('/srv/editor/dist', '/srv/editor/dist/')).toBe(false);
    expect(isInside('/srv/editor/dist', '/srv/editor/dist/../dist-private/x')).toBe(false);
  });

  it('x-forwarded-for is read only as far back as the trusted proxies', () => {
    const req = (xff?: string) => fakeReq(xff ? { 'x-forwarded-for': xff } : {}, '10.0.0.9');
    expect(clientIp(req('6.6.6.6'), 0)).toBe('10.0.0.9'); // no proxy: the header is the client's to forge
    expect(clientIp(req('6.6.6.6, 1.2.3.4'), 1)).toBe('1.2.3.4'); // the ALB appended 1.2.3.4
    expect(clientIp(req('6.6.6.6, 1.2.3.4, 10.1.1.1'), 2)).toBe('1.2.3.4'); // CDN then ALB
    expect(clientIp(req('1.2.3.4'), 3)).toBe('1.2.3.4'); // fewer hops than configured: the furthest known
    expect(clientIp(req('not-an-ip'), 1)).toBe('10.0.0.9');
    expect(clientIp(req(), 1)).toBe('10.0.0.9');
    expect(clientIp(fakeReq({ 'x-forwarded-for': '1.2.3.4' }, '::ffff:10.0.0.9'), 0)).toBe('10.0.0.9');
    expect(addressKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressKey('1.2.3.4')).toBe('1.2.3.4');
  });
});

describe('TOTP and recovery codes', () => {
  const rfc = Buffer.from('12345678901234567890'); // RFC 6238 appendix B, SHA-1
  it('matches the RFC test vectors', () => {
    expect(totpAt(rfc, stepAt(59_000))).toBe('287082');
    expect(totpAt(rfc, stepAt(1111111109_000))).toBe('081804');
    expect(totpAt(rfc, stepAt(20000000000_000))).toBe('353130');
  });
  it('allows one step of drift, and never the same step twice', () => {
    const now = 1_700_000_000_000;
    const step = stepAt(now);
    expect(verifyTotp(rfc, totpAt(rfc, step), now)).toBe(step);
    expect(verifyTotp(rfc, totpAt(rfc, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(rfc, totpAt(rfc, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(rfc, totpAt(rfc, step - 2), now)).toBeNull();
    expect(verifyTotp(rfc, totpAt(rfc, step), now, step)).toBeNull();
    expect(verifyTotp(rfc, '12345', now)).toBeNull();
    expect(verifyTotp(rfc, 'abcdef', now)).toBeNull();
  });
  it('base32 round-trips, and recovery codes are distinct and recognisable', () => {
    const b = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 9]);
    expect(fromBase32(base32(b))).toEqual(b);
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    const codes = newRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(looksLikeRecovery(c)).toBe(true);
    expect(looksLikeRecovery('123456')).toBe(false);
  });
});

describe('secrets at rest', () => {
  const k1 = parseKey('a'.repeat(64));
  const k2 = parseKey('b'.repeat(64));
  it('decrypts only for its owner and with a key it was sealed by', () => {
    const sealed = secretBox(k1).seal(Buffer.from('seed'), 'user-1');
    expect(sealed).not.toContain('seed');
    expect(secretBox(k1).open(sealed, 'user-1')?.toString()).toBe('seed');
    expect(secretBox(k1).open(sealed, 'user-2')).toBeNull();
    expect(secretBox(k2).open(sealed, 'user-1')).toBeNull();
    expect(secretBox(k2, k1).open(sealed, 'user-1')?.toString()).toBe('seed'); // rotation: the old key still opens
    const parts = sealed.split('.');
    parts[4] = (parts[4]![0] === 'A' ? 'B' : 'A') + parts[4]!.slice(1); // one flipped ciphertext bit
    expect(secretBox(k1).open(parts.join('.'), 'user-1')).toBeNull();
  });
  it('a hosted deployment needs its own key and a real mail sender', () => {
    const delivering = { delivers: true, send: async () => undefined };
    const env = {};
    expect(() => resolveIdentityConfig({ hosted: true, driver: 'postgres', mail: delivering }, env)).toThrow(/RANGOLI_MFA_KEY/);
    expect(() => resolveIdentityConfig({ hosted: true, driver: 'postgres', mail: logMailer, mfaKey: 'c'.repeat(64) }, env)).toThrow(/mail sender/);
    expect(() => resolveIdentityConfig({ hosted: true, driver: 'postgres', mail: delivering, mfaKey: 'short' }, env)).toThrow(/too short/);
    expect(resolveIdentityConfig({ hosted: true, driver: 'postgres', mail: delivering, mfaKey: 'c'.repeat(64) }, env).hosted).toBe(true);
    // production on a Postgres server counts as hosted without being told
    expect(() => resolveIdentityConfig({ driver: 'postgres', mail: delivering }, { NODE_ENV: 'production' })).toThrow(/RANGOLI_MFA_KEY/);
    // embedded and local use may run on the default key and the log mailer
    expect(resolveIdentityConfig({ driver: 'pglite', mail: logMailer }, { NODE_ENV: 'production' }).hosted).toBe(false);
    expect(resolveIdentityConfig({ driver: 'pglite', mail: logMailer, publicUrl: 'https://x.io' }, {}).trustedProxies).toBe(1);
    expect(resolveIdentityConfig({ driver: 'pglite', mail: logMailer }, { RANGOLI_TRUSTED_PROXIES: '2' }).trustedProxies).toBe(2);
    expect(() => resolveIdentityConfig({ driver: 'pglite', mail: logMailer }, { RANGOLI_TRUSTED_PROXIES: 'x' })).toThrow(/TRUSTED_PROXIES/);
  });
});

describe('token scopes', () => {
  it('names a scope for every tool, and refuses tools it does not know', () => {
    expect(scopeForTool('rdl_apply')).toBe('draft');
    expect(scopeForTool('doc_outline')).toBe('read');
    expect(scopeForTool('suggest')).toBe('propose');
    expect(scopeForTool('job_claim')).toBe('jobs');
    expect(scopeForTool('agent_requests')).toBeUndefined();
    expect(toolRefusal('rdl_apply', ['read'])).toMatch(/"draft" scope/);
    expect(toolRefusal('some_new_tool', ['read', 'propose', 'draft', 'items', 'export', 'jobs'])).toMatch(/not available/);
    expect(toolRefusal('doc_outline', ['read'])).toBeNull();
  });
});

// ---------------------------------------------------------------- the app

class Person {
  cookie = '';
  id = '';
  constructor(readonly base: string, readonly email: string, readonly name = 'P', readonly headers: Record<string, string> = {}) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...this.headers, ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    // the session cookie, if this response set one; the MFA challenge cookie is kept alongside it
    const set = res.headers.getSetCookie();
    const jar = new Map(this.cookie ? this.cookie.split('; ').map((c) => c.split('=') as [string, string]) : []);
    for (const c of set) {
      const [pair] = c.split(';');
      const [k, v = ''] = pair!.split('=');
      if (v) jar.set(k!, v);
      else jar.delete(k!);
    }
    this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b?: unknown) => this.call('POST', p, b);
  del = (p: string) => this.call('DELETE', p);
}

describe('identity over HTTP', () => {
  let db: Database;
  let owner: Database;
  let app: AppServer;
  let base = '';
  const mailbox: MailMessage[] = [];
  const mail = { delivers: true, send: async (m: MailMessage) => void mailbox.push(m) };
  const linkFor = (email: string, kind: 'verify' | 'reset') => {
    const m = [...mailbox].reverse().find((x) => x.to.includes(email) && x.text.includes(`/${kind}/`));
    return new RegExp(`/${kind}/([\\w-]+)`).exec(m!.text)![1]!;
  };
  const signup = async (email: string, opts: { verify?: boolean; base?: string } = {}) => {
    const p = new Person(opts.base ?? base, email);
    const r = await p.post('/api/auth/signup', { email, name: 'P', password: 'correct horse battery' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    if (opts.verify !== false) expect((await p.post('/api/auth/verify', { token: linkFor(email, 'verify') })).status).toBe(200);
    p.id = (await p.get('/api/me')).body.user.id;
    return p;
  };
  const codeFor = (secret: string, drift = 0) => totpAt(fromBase32(secret), stepAt(Date.now()) + drift);
  const sessionAge = (p: Person, minutes: number) => owner.tx((q) => q(`UPDATE auth_sessions SET auth_at = now() - make_interval(mins => $2), mfa_at = CASE WHEN mfa_at IS NULL THEN NULL ELSE now() - make_interval(mins => $2) END WHERE user_id = $1`, [p.id, minutes]));

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    owner = await openDatabase({ url });
    db = process.env.TEST_APP_DATABASE_URL ? await openDatabase({ url, appUrl: process.env.TEST_APP_DATABASE_URL }) : owner;
    app = await startApp({ db, port: 0, mail });
    base = app.url.replace(/\/$/, '');
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (owner !== db) await owner?.close();
  });

  it('a malformed session cookie is a sign-in prompt, not a server error', async () => {
    const r = await new Person(base, '').call('GET', '/api/me', undefined, { cookie: 'rangoli_session=%E0%A4%A' });
    expect(r.status).toBe(401);
  });

  it('signing up sends a verification link; until it is used, no tokens', async () => {
    const before = mailbox.length;
    const p = await signup('vera@x.io', { verify: false });
    expect(mailbox.length).toBe(before + 1);
    expect(mailbox.at(-1)!.subject).toMatch(/Confirm your email/);
    const me = (await p.get('/api/me')).body;
    expect(me.security).toMatchObject({ emailVerified: false, mfaEnabled: false });
    const org = (await p.post('/api/orgs', { name: 'Vera Co' })).body.id;
    const project = (await p.post(`/api/orgs/${org}/projects`, { name: 'V' })).body.id;
    const refused = await p.post('/api/tokens', { name: 't', projects: [project], scopes: ['read'] });
    expect(refused.status).toBe(403);
    expect(refused.body.verifyEmail).toBe(true);
    // a fresh link replaces the old one
    const first = linkFor('vera@x.io', 'verify');
    expect((await p.post('/api/me/verify')).status).toBe(200);
    const second = linkFor('vera@x.io', 'verify');
    expect(second).not.toBe(first);
    expect((await p.post('/api/auth/verify', { token: first })).status).toBe(400);
    const oldCookie = p.cookie;
    // the link works from any browser, and once
    expect((await new Person(base, '').post('/api/auth/verify', { token: second })).status).toBe(200);
    expect((await p.post('/api/auth/verify', { token: second })).status).toBe(400);
    expect(p.cookie).toBe(oldCookie);
    expect((await p.get('/api/me')).body.security.emailVerified).toBe(true);
    expect((await p.post('/api/tokens', { name: 't', projects: [project], scopes: ['read'] })).status).toBe(200);
    expect((await p.post('/api/me/verify')).status).toBe(409);
  });

  it('verifying in the same browser rotates its session', async () => {
    const p = await signup('rota@x.io', { verify: false });
    const old = p.cookie;
    expect((await p.post('/api/auth/verify', { token: linkFor('rota@x.io', 'verify') })).status).toBe(200);
    expect(p.cookie).not.toBe(old);
    expect((await new Person(base, '').call('GET', '/api/me', undefined, { cookie: old })).status).toBe(401);
    expect((await p.get('/api/me')).status).toBe(200);
  });

  describe('two-step sign-in', () => {
    let p: Person;
    let secret = '';
    let recovery: string[] = [];

    it('setting up needs a recent password, and the first code proves the app works', async () => {
      p = await signup('mfa@x.io');
      await sessionAge(p, 10);
      const stale = await p.post('/api/me/mfa/setup');
      expect(stale.status).toBe(403);
      expect(stale.body.stepUp).toBe('password');
      expect((await p.post('/api/auth/step-up', { password: 'wrong wrong wrong' })).status).toBe(400);
      expect((await p.post('/api/auth/step-up', { password: 'correct horse battery' })).status).toBe(200);
      const setup = await p.post('/api/me/mfa/setup');
      expect(setup.status).toBe(200);
      secret = setup.body.secret;
      expect(setup.body.uri).toMatch(/^otpauth:\/\/totp\/Rangoli:mfa%40x\.io\?secret=/);
      // only ciphertext reaches the database
      const [row] = await owner.tx((q) => q<{ pending: string }>(`SELECT mfa_pending_enc AS pending FROM users WHERE id = $1`, [p.id]));
      expect(row!.pending).toMatch(/^v1\./);
      expect(row!.pending).not.toContain(secret);
      expect((await p.post('/api/me/mfa/enable', { code: '000000' === codeFor(secret) ? '111111' : '000000' })).status).toBe(400);
      const other = await new Person(base, 'mfa@x.io').post('/api/auth/login', { email: 'mfa@x.io', password: 'correct horse battery' });
      expect(other.status).toBe(200);
      const before = p.cookie;
      const on = await p.post('/api/me/mfa/enable', { code: codeFor(secret) });
      expect(on.status).toBe(200);
      recovery = on.body.recoveryCodes;
      expect(recovery).toHaveLength(10);
      // a privilege change: this browser gets a new token, and the old one is dead
      expect(p.cookie).not.toBe(before);
      expect((await new Person(base, '').call('GET', '/api/me', undefined, { cookie: before })).status).toBe(401);
      expect((await p.get('/api/me')).body.security).toMatchObject({ mfaEnabled: true, recoveryLeft: 10 });
      const [enc] = await owner.tx((q) => q<{ s: string; r: string[] }>(`SELECT mfa_secret_enc AS s, mfa_recovery AS r FROM users WHERE id = $1`, [p.id]));
      expect(enc!.s).toMatch(/^v1\./);
      expect(enc!.r.join()).not.toContain(recovery[0]!.replace('-', ''));
    });

    it('signing in then asks for a code, and a code works once', async () => {
      const b = new Person(base, 'mfa@x.io');
      const first = await b.post('/api/auth/login', { email: 'mfa@x.io', password: 'correct horse battery' });
      expect(first.body).toEqual({ mfa: true });
      expect((await b.get('/api/me')).status).toBe(401); // no session yet
      expect((await b.post('/api/auth/mfa', { code: '000000' === codeFor(secret, 1) ? '111111' : '000000' })).status).toBe(401);
      const code = codeFor(secret, 1); // the current step was spent turning MFA on
      expect((await b.post('/api/auth/mfa', { code })).status).toBe(200);
      expect((await b.get('/api/me')).status).toBe(200);
      // the challenge is single use, and the same code cannot be replayed through a new one
      const c = new Person(base, 'mfa@x.io');
      await c.post('/api/auth/login', { email: 'mfa@x.io', password: 'correct horse battery' });
      expect((await c.post('/api/auth/mfa', { code })).status).toBe(401);
      expect((await new Person(base, '').post('/api/auth/mfa', { code: codeFor(secret) })).body.restart).toBe(true);
    });

    it('a recovery code signs in once', async () => {
      const b = new Person(base, 'mfa@x.io');
      await b.post('/api/auth/login', { email: 'mfa@x.io', password: 'correct horse battery' });
      const r = await b.post('/api/auth/mfa', { code: recovery[0]!.toUpperCase() });
      expect(r.status).toBe(200);
      expect(r.body.recoveryLeft).toBe(9);
      const again = new Person(base, 'mfa@x.io');
      await again.post('/api/auth/login', { email: 'mfa@x.io', password: 'correct horse battery' });
      expect((await again.post('/api/auth/mfa', { code: recovery[0]! })).status).toBe(401);
      expect((await b.get('/api/me')).body.security.recoveryLeft).toBe(9);
    });

    it('step-up for an approval wants the second factor within five minutes', async () => {
      const as: As = (id, fn) => withUser(db, id, fn);
      const stepUp = createStepUp(as, createSessions(as, { secureCookies: false }));
      const req = () => fakeReq({ cookie: p.cookie });
      expect((await stepUp(req(), { approval: true })).mfaAt).not.toBeNull(); // proved at enable
      await sessionAge(p, 6);
      await expect(stepUp(req(), { approval: true })).rejects.toMatchObject({ status: 403, extra: { stepUp: 'mfa' } });
      // a password alone does not satisfy an MFA account
      expect((await p.post('/api/auth/step-up', { password: 'correct horse battery' })).status).toBe(200);
      await expect(stepUp(req(), { approval: true })).rejects.toMatchObject({ extra: { stepUp: 'mfa' } });
      expect((await p.post('/api/auth/step-up', { code: codeFor(secret, -1) })).status).toBe(400); // an old step
      const before = p.cookie;
      expect((await p.post('/api/auth/step-up', { code: recovery[1]! })).status).toBe(200);
      expect(p.cookie).not.toBe(before); // rotated
      const ok = await stepUp(req(), { approval: true });
      expect(ok.user.id).toBe(p.id);
      expect(Date.now() - new Date(ok.mfaAt!).getTime()).toBeLessThan(60_000);
    });

    it('new recovery codes replace the old; turning MFA off needs a code', async () => {
      const r = await p.post('/api/me/mfa/recovery', { code: recovery[2]! });
      expect(r.status).toBe(200);
      const fresh = r.body.recoveryCodes as string[];
      expect((await p.post('/api/me/mfa/disable', { code: recovery[3]! })).status).toBe(400); // replaced
      expect((await p.post('/api/me/mfa/disable', { code: fresh[0]! })).status).toBe(200);
      expect((await p.get('/api/me')).body.security.mfaEnabled).toBe(false);
      const [row] = await owner.tx((q) => q<{ s: string | null; n: number }>(`SELECT mfa_secret_enc AS s, cardinality(mfa_recovery) AS n FROM users WHERE id = $1`, [p.id]));
      expect(row).toEqual({ s: null, n: 0 });
      expect((await new Person(base, 'mfa@x.io').post('/api/auth/login', { email: 'mfa@x.io', password: 'correct horse battery' })).body).toEqual({ ok: true });
    });

    it('a named approver needs MFA to approve and cannot turn it off', async () => {
      const [col] = await owner.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'project_members' AND column_name = 'is_approver'`));
      if (!col!.n) return; // the roles migration has not landed: nobody is named an approver yet
      const a = await signup('appr@x.io');
      const org = (await a.post('/api/orgs', { name: 'Appr Co' })).body.id;
      const project = (await a.post(`/api/orgs/${org}/projects`, { name: 'A' })).body.id;
      await owner.tx((q) => q(`UPDATE project_members SET is_approver = true WHERE project_id = $1 AND user_id = $2`, [project, a.id]));
      expect((await a.get('/api/me')).body.security.mfaRequired).toBe(true);
      const as: As = (id, fn) => withUser(db, id, fn);
      const stepUp = createStepUp(as, createSessions(as, { secureCookies: false }));
      await expect(stepUp(fakeReq({ cookie: a.cookie }), { approval: true })).rejects.toMatchObject({ extra: { mfaSetup: true } });
      const s = (await a.post('/api/me/mfa/setup')).body.secret as string;
      expect((await a.post('/api/me/mfa/enable', { code: codeFor(s) })).status).toBe(200);
      expect((await a.post('/api/me/mfa/disable', { code: codeFor(s, 1) })).status).toBe(409);
    });
  });

  describe('scoped tokens', () => {
    let p: Person;
    let p1 = '';
    let p2 = '';
    const mcp = async (token: string, project: string) => {
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/d/${project}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      return client;
    };
    const text = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;

    beforeAll(async () => {
      p = await signup('tok@x.io');
      const org = (await p.post('/api/orgs', { name: 'Tok Co' })).body.id;
      p1 = (await p.post(`/api/orgs/${org}/projects`, { name: 'One' })).body.id;
      p2 = (await p.post(`/api/orgs/${org}/projects`, { name: 'Two' })).body.id;
      await owner.tx((q) => q(`UPDATE projects SET stage = 'visual' WHERE id = ANY ($1::uuid[])`, [[p1, p2]]));
    });

    it('a token names its projects and scopes, and expires in 90 days unless told otherwise', async () => {
      expect((await p.post('/api/tokens', { name: 't', scopes: ['read'] })).status).toBe(400);
      expect((await p.post('/api/tokens', { name: 't', projects: [p1], scopes: [] })).status).toBe(400);
      expect((await p.post('/api/tokens', { name: 't', projects: [p1], scopes: ['admin'] })).status).toBe(400);
      expect((await p.post('/api/tokens', { name: 't', projects: [p1], scopes: ['read'], days: 999 })).status).toBe(400);
      const made = await p.post('/api/tokens', { name: 'Reader', projects: [p1], scopes: ['read'] });
      expect(made.status).toBe(200);
      expect(made.body.token).toMatch(/^rng_/);
      const listed = (await p.get('/api/tokens')).body.find((t: { id: string }) => t.id === made.body.id);
      expect(listed).toMatchObject({ name: 'Reader', scopes: ['read'], projects: [{ id: p1, name: 'One' }], revoked_at: null, last_used_at: null, legacy: false });
      const days = (new Date(listed.expires_at).getTime() - Date.now()) / 86400000;
      expect(days).toBeGreaterThan(89.9);
      expect(days).toBeLessThan(90.1);
      expect(JSON.stringify(listed)).not.toContain(made.body.token);
    });

    it('an agent can do what its scopes say, on its projects only, and stops when revoked', async () => {
      const reader = (await p.post('/api/tokens', { name: 'r', projects: [p1], scopes: ['read'] })).body;
      const client = await mcp(reader.token, p1);
      expect((await client.callTool({ name: 'doc_outline', arguments: {} })).isError).toBeFalsy();
      const edit = await client.callTool({ name: 'rdl_apply', arguments: { script: 'Frame name:Nope w10 h10' } });
      expect(edit.isError).toBe(true);
      expect(text(edit)).toMatch(/"draft" scope/);
      expect(text(await client.callTool({ name: 'comment', arguments: { action: 'add', body: 'hi' } }))).toMatch(/"propose" scope/);
      await expect(mcp(reader.token, p2)).rejects.toBeTruthy();
      const used = (await p.get('/api/tokens')).body.find((t: { id: string }) => t.id === reader.id);
      expect(used.last_used_at).not.toBeNull();
      // revoking stops the agent at its next call, without reconnecting
      expect((await p.del(`/api/tokens/${reader.id}`)).status).toBe(200);
      // the endpoint refuses the revoked token outright, before any tool runs
      await expect(client.callTool({ name: 'doc_outline', arguments: {} })).rejects.toThrow(/Sign in/);
      await client.close().catch(() => undefined);
      await expect(mcp(reader.token, p1)).rejects.toBeTruthy();
      expect((await p.get('/api/tokens')).body.find((t: { id: string }) => t.id === reader.id).revoked_at).not.toBeNull();

      // the per-call recheck: a live session whose token stops covering the project is stopped at the next tool
      const narrowing = (await p.post('/api/tokens', { name: 'n', projects: [p1], scopes: ['read'] })).body;
      const live = await mcp(narrowing.token, p1);
      await owner.tx((q) => q(`UPDATE api_tokens SET scopes = '{draft}' WHERE id = $1`, [narrowing.id]));
      expect(text(await live.callTool({ name: 'doc_outline', arguments: {} }))).toMatch(/"read" scope/);
      await live.close();

      const drafter = (await p.post('/api/tokens', { name: 'd', projects: [p1, p2], scopes: ['read', 'draft'] })).body;
      for (const project of [p1, p2]) {
        const c = await mcp(drafter.token, project);
        // design changes happen in a named run
        expect(text(await c.callTool({ name: 'rdl_apply', arguments: { script: 'Frame name:Drafted w10 h10' } }))).toMatch(/named run/);
        expect((await c.callTool({ name: 'run_start', arguments: { intent: 'draft a frame' } })).isError).toBeFalsy();
        const r = await c.callTool({ name: 'rdl_apply', arguments: { script: 'Frame name:Drafted w10 h10' } });
        expect(r.isError, text(r)).toBeFalsy();
        await c.callTool({ name: 'run_end', arguments: {} });
        await c.close();
      }
    }, 20000); // several MCP connections and a named run per project; the 5 s default is too tight under a full parallel run

    it('an expired token is refused', async () => {
      const t = (await p.post('/api/tokens', { name: 'e', projects: [p1], scopes: ['read'], days: 1 })).body;
      await owner.tx((q) => q(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [t.id]));
      await expect(mcp(t.token, p1)).rejects.toBeTruthy();
    });
  });

  describe('sessions', () => {
    it('end after 24 idle hours, and at 14 days whatever the use', async () => {
      const p = await signup('idle@x.io');
      expect((await p.get('/api/me')).status).toBe(200);
      await owner.tx((q) => q(`UPDATE auth_sessions SET last_seen_at = now() - interval '25 hours' WHERE user_id = $1`, [p.id]));
      expect((await p.get('/api/me')).status).toBe(401);
      await p.post('/api/auth/login', { email: 'idle@x.io', password: 'correct horse battery' });
      expect((await p.get('/api/me')).status).toBe(200);
      await owner.tx((q) => q(`UPDATE auth_sessions SET expires_at = now() - interval '1 second' WHERE user_id = $1`, [p.id]));
      expect((await p.get('/api/me')).status).toBe(401);
    });

    it('over HTTPS the cookie is __Host- prefixed, and the plain name is not accepted', async () => {
      const secure = await startApp({ db, port: 0, mail, publicUrl: 'https://rangoli.example' });
      try {
        const b = secure.url.replace(/\/$/, '');
        const r = await fetch(`${b}/api/auth/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'host@x.io', name: 'H', password: 'correct horse battery' }) });
        const set = r.headers.getSetCookie().find((c) => c.includes('session'))!;
        expect(set).toMatch(/^__Host-rangoli_session=[\w-]+; HttpOnly; SameSite=Lax; Path=\/; Max-Age=1209600; Secure$/);
        expect(set).not.toMatch(/Domain=/i);
        const value = set.split(';')[0]!.split('=')[1]!;
        const me = (cookie: string) => fetch(`${b}/api/me`, { headers: { cookie } }).then((x) => x.status);
        expect(await me(`__Host-rangoli_session=${value}`)).toBe(200);
        expect(await me(`rangoli_session=${value}`)).toBe(401);
      } finally {
        await secure.close();
      }
    });
  });

  describe('throttling', () => {
    it('is shared by every app process and survives a restart', async () => {
      const limits = { loginEmail: { max: 3, windowSec: 900 } };
      const a = await startApp({ db, port: 0, mail, identity: { limits } });
      const b = await startApp({ db, port: 0, mail, identity: { limits } });
      await signup('shared@x.io');
      const bad = (srv: AppServer) => new Person(srv.url.replace(/\/$/, ''), '').post('/api/auth/login', { email: 'shared@x.io', password: 'wrong wrong wrong' }).then((r) => r.status);
      expect(await bad(a)).toBe(401);
      expect(await bad(b)).toBe(401);
      expect(await bad(a)).toBe(401);
      expect(await bad(b)).toBe(429);
      await a.close();
      await b.close();
      const c = await startApp({ db, port: 0, mail, identity: { limits } });
      try {
        // the right password does not get through either while the limit holds
        const ok = await new Person(c.url.replace(/\/$/, ''), '').post('/api/auth/login', { email: 'shared@x.io', password: 'correct horse battery' });
        expect(ok.status).toBe(429);
      } finally {
        await c.close();
      }
    }, 30000);

    it('limits by address across many emails, reading the address past the trusted proxy only', async () => {
      const srv = await startApp({ db, port: 0, mail, identity: { trustedProxies: 1, limits: { loginIp: { max: 3, windowSec: 900 } } } });
      try {
        const from = (xff: string) => new Person(srv.url.replace(/\/$/, ''), '', 'P', { 'x-forwarded-for': xff });
        const spray = (xff: string, i: number) => from(xff).post('/api/auth/login', { email: `nobody${i}@x.io`, password: 'wrong wrong wrong' }).then((r) => r.status);
        // the client forges the left part; the proxy's entry is what counts
        expect(await spray('1.1.1.1, 203.0.113.7', 1)).toBe(401);
        expect(await spray('2.2.2.2, 203.0.113.7', 2)).toBe(401);
        expect(await spray('3.3.3.3, 203.0.113.7', 3)).toBe(401);
        expect(await spray('4.4.4.4, 203.0.113.7', 4)).toBe(429);
        expect(await spray('203.0.113.8', 5)).toBe(401); // a different client
      } finally {
        await srv.close();
      }
    }, 30000);

    it('limits sign-ups and reset requests', async () => {
      const srv = await startApp({ db, port: 0, mail, identity: { trustedProxies: 1, limits: { signupIp: { max: 2, windowSec: 3600 }, resetEmail: { max: 2, windowSec: 3600 } } } });
      try {
        const b = srv.url.replace(/\/$/, '');
        const from = new Person(b, '', 'P', { 'x-forwarded-for': '198.51.100.1' });
        const join = (i: number) => from.post('/api/auth/signup', { email: `burst${i}@x.io`, name: 'B', password: 'correct horse battery' }).then((r) => r.status);
        expect(await join(1)).toBe(200);
        expect(await join(2)).toBe(200);
        expect(await join(3)).toBe(429);
        const before = mailbox.length;
        for (let i = 0; i < 4; i++) expect((await new Person(b, '').post('/api/auth/forgot', { email: 'burst1@x.io' })).status).toBe(200);
        expect(mailbox.filter((m) => m.subject.includes('Reset')).length - mailbox.slice(0, before).filter((m) => m.subject.includes('Reset')).length).toBe(2);
      } finally {
        await srv.close();
      }
    }, 30000);

    it('limits second-factor guesses per person', async () => {
      const srv = await startApp({ db, port: 0, mail, identity: { limits: { mfaUser: { max: 2, windowSec: 900 } } } });
      try {
        const p = await signup('guess@x.io', { base: srv.url.replace(/\/$/, '') });
        const s = (await p.post('/api/me/mfa/setup')).body.secret as string;
        expect((await p.post('/api/me/mfa/enable', { code: codeFor(s) })).status).toBe(200);
        const b = new Person(srv.url.replace(/\/$/, ''), '');
        await b.post('/api/auth/login', { email: 'guess@x.io', password: 'correct horse battery' });
        const wrong = codeFor(s, 1) === '000000' ? '111111' : '000000';
        expect((await b.post('/api/auth/mfa', { code: wrong })).status).toBe(401);
        expect((await b.post('/api/auth/mfa', { code: wrong })).status).toBe(401);
        expect((await b.post('/api/auth/mfa', { code: codeFor(s, 1) })).status).toBe(429);
      } finally {
        await srv.close();
      }
    }, 30000);
  });
});
