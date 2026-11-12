import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from './db.js';
import type { MailMessage } from './infra.js';
import { startApp, type AppServer } from './server.js';

type Res = { status: number; body: any; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Every message the app sent, across the suite. */
const mailbox: MailMessage[] = [];

class Person {
  cookie = '';
  id = '';
  constructor(readonly base: string, readonly email: string, readonly name: string) {}
  async call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const res = await fetch(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
      body: body === undefined ? (method === 'GET' ? undefined : '{}') : JSON.stringify(body),
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
    return { status: res.status, body: parsed, headers: res.headers };
  }
  get = (p: string) => this.call('GET', p);
  post = (p: string, b?: unknown) => this.call('POST', p, b);
  patch = (p: string, b?: unknown) => this.call('PATCH', p, b);
  put = (p: string, b?: unknown) => this.call('PUT', p, b);
  del = (p: string) => this.call('DELETE', p);
  async signup(extra: object = {}) {
    const r = await this.post('/api/auth/signup', { email: this.email, name: this.name, password: 'correct horse battery', ...extra });
    expect(r.status).toBe(200);
    // follow the verification link, as anyone who invites, approves or makes tokens has to
    const mail = [...mailbox].reverse().find((m) => m.to.includes(this.email) && /\/verify\//.test(m.text));
    expect((await this.post('/api/auth/verify', { token: /\/verify\/([\w-]+)/.exec(mail!.text)![1] })).status).toBe(200);
    this.id = (await this.get('/api/me')).body.user.id;
    return this;
  }
}

const settle = () => new Promise((r) => setTimeout(r, 300));

/** Sends a JSON body in two separate writes, cut through the middle of `char`. */
const sendSplit = (url: string, method: string, cookie: string, json: unknown, char: string) =>
  new Promise<number>((done, fail) => {
    const body = Buffer.from(JSON.stringify(json));
    const cut = body.indexOf(Buffer.from(char)) + 1;
    const req = httpRequest(url, { method, headers: { 'content-type': 'application/json', 'content-length': body.length, cookie } }, (res) => {
      res.resume();
      res.on('end', () => done(res.statusCode!));
    });
    req.on('error', fail);
    req.write(body.subarray(0, cut));
    setTimeout(() => req.end(body.subarray(cut)), 50);
  });

describe('hosted app', () => {
  let db: Database;
  /** schema owner, for checking what actually landed in the tables */
  let owner: Database;
  const mail = { delivers: true, send: async (m: MailMessage) => void mailbox.push(m) };
  let app: AppServer;
  let base = '';
  let admin: Person, designer: Person, reviewer: Person, outsider: Person, bystander: Person;
  let org = '';
  let project = '';

  const journey = async (who: Person = admin) => (await who.get(`/api/projects/${project}/journey`)).body;
  const item = async (kind: string, fields: object = {}, who: Person = designer) => {
    const r = await who.post(`/api/projects/${project}/items`, { kind, ...fields });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body.id as string;
  };
  /** Joins the organization as a member, with this project role in the projects named (reviewers approve). */
  const invite = async (p: Person, projectRole: string, projects: string[] = []) => {
    const r = await admin.post(`/api/orgs/${org}/invites`, { email: p.email, role: 'member', projects, projectRole });
    expect(r.status).toBe(200);
    const token = (r.body.url as string).split('/invite/')[1]!;
    await p.signup();
    expect((await p.post('/api/invites/accept', { token })).status).toBe(200);
  };

  beforeAll(async () => {
    const url = process.env.TEST_DATABASE_URL;
    owner = await openDatabase({ url });
    db = process.env.TEST_APP_DATABASE_URL ? await openDatabase({ url, appUrl: process.env.TEST_APP_DATABASE_URL }) : owner;
    app = await startApp({ db, port: 0, mail });
    base = app.url.replace(/\/$/, '');
    admin = await new Person(base, 'admin@acme.io', 'Asha').signup();
    org = (await admin.post('/api/orgs', { name: 'Acme Design' })).body.id;
    project = (await admin.post(`/api/orgs/${org}/projects`, { name: 'Checkout', workType: 'full' })).body.id;
    designer = new Person(base, 'dee@acme.io', 'Dee');
    reviewer = new Person(base, 'rae@acme.io', 'Rae');
    bystander = new Person(base, 'bo@acme.io', 'Bo');
    await invite(designer, 'designer', [project]);
    await invite(reviewer, 'reviewer', [project]);
    await invite(bystander, 'designer');
    outsider = await new Person(base, 'eve@evil.io', 'Eve').signup();
    await outsider.post('/api/orgs', { name: 'Evil Co' });
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    if (owner !== db) await owner?.close();
  });

  describe('accounts', () => {
    it('requires sign-in', async () => {
      const anon = new Person(base, '', '');
      expect((await anon.get('/api/me')).status).toBe(401);
      expect((await anon.get(`/api/projects/${project}/journey`)).status).toBe(401);
      expect((await anon.get(`/d/${project}/api/doc`)).status).toBe(401);
    });
    it('uses an HttpOnly session cookie and never returns a password hash', async () => {
      const p = new Person(base, 'admin@acme.io', 'x');
      const r = await p.post('/api/auth/login', { email: 'admin@acme.io', password: 'correct horse battery' });
      expect(r.status).toBe(200);
      expect(r.headers.get('set-cookie')).toMatch(/HttpOnly; SameSite=Lax/);
      expect(JSON.stringify((await p.get('/api/me')).body)).not.toMatch(/scrypt|password/);
    });
    it('rejects bad passwords, then throttles', async () => {
      const p = new Person(base, '', '');
      const bad = () => p.post('/api/auth/login', { email: 'rae@acme.io', password: 'wrong wrong wrong' });
      expect((await bad()).status).toBe(401);
      for (let i = 0; i < 9; i++) await bad();
      expect((await bad()).status).toBe(429);
    }, 30000);
    it('signing out ends the session on the server', async () => {
      const p = new Person(base, 'bo@acme.io', 'Bo');
      await p.post('/api/auth/login', { email: 'bo@acme.io', password: 'correct horse battery' });
      const stolen = p.cookie;
      await p.post('/api/auth/logout');
      p.cookie = stolen;
      expect((await p.get('/api/me')).status).toBe(401);
    });
    it('rejects cross-origin writes even with a valid session', async () => {
      const r = await admin.call('POST', `/api/orgs/${org}/projects`, { name: 'x' }, { origin: 'https://evil.example' });
      expect(r.status).toBe(403);
    });
    it('rejects cross-site writes to the design plane, whichever way the browser marks them', async () => {
      const write = (headers: Record<string, string>) => designer.call('POST', `/d/${project}/api/threads`, { node: null, body: 'from elsewhere' }, headers);
      expect((await write({ origin: 'https://evil.example' })).status).toBe(403);
      expect((await write({ origin: 'null' })).status).toBe(403);
      expect((await write({ 'sec-fetch-site': 'cross-site' })).status).toBe(403); // even with no Origin header
      expect((await write({ 'sec-fetch-site': 'same-site' })).status).toBe(403);
      expect((await write({ 'content-type': 'text/plain' })).status).toBe(403); // what a plain form can send
      const reviews = (await designer.get(`/d/${project}/api/reviews`)).body;
      expect(JSON.stringify(reviews)).not.toContain('from elsewhere');
      expect((await write({ 'sec-fetch-site': 'same-origin' })).status).toBe(200);
    });
  });

  describe('isolation over HTTP', () => {
    const everyRead = () => [`/api/projects/${project}/journey`, `/api/projects/${project}/handoff`, `/d/${project}/api/doc`, `/d/${project}/api/reviews`, `/d/${project}/play`, `/d/${project}/`];

    it('other orgs get 404, not 403, on everything', async () => {
      for (const p of everyRead()) expect((await outsider.get(p)).status, p).toBe(404);
      expect((await outsider.get(`/api/orgs/${org}/projects`)).status).toBe(404);
      expect((await outsider.get(`/api/orgs/${org}/admin`)).status).toBe(404);
      expect((await outsider.post(`/d/${project}/api/rdl`, { script: 'Frame' })).status).toBe(404);
      expect((await outsider.del(`/api/projects/${project}`)).status).toBe(404);
    });
    it('unassigned teammates cannot see the project', async () => {
      for (const p of everyRead()) expect((await bystander.get(p)).status, p).toBe(404);
      const list = await bystander.get(`/api/orgs/${org}/projects`);
      expect(list.body.projects).toEqual([]);
    });
    it('assignment is what grants access, and revoking it takes effect at once', async () => {
      await admin.put(`/api/projects/${project}/members/${bystander.id}`);
      expect((await bystander.get(`/d/${project}/api/doc`)).status).toBe(200);
      await admin.del(`/api/projects/${project}/members/${bystander.id}`);
      expect((await bystander.get(`/d/${project}/api/doc`)).status).toBe(404);
    });
    it('only admins reach the admin panel', async () => {
      expect((await designer.get(`/api/orgs/${org}/admin`)).status).toBe(403);
      expect((await reviewer.post(`/api/orgs/${org}/invites`, { email: 'a@b.io', role: 'admin' })).status).toBe(403);
      expect((await designer.patch(`/api/orgs/${org}/members/${designer.id}`, { role: 'admin' })).status).toBe(403);
      expect((await admin.get(`/api/orgs/${org}/admin`)).status).toBe(200);
    });
    it('an invite link cannot be used by someone else', async () => {
      const r = await admin.post(`/api/orgs/${org}/invites`, { email: 'new@acme.io', role: 'admin' });
      const token = (r.body.url as string).split('/invite/')[1]!;
      expect((await outsider.post('/api/invites/accept', { token })).status).toBe(409);
      expect((await outsider.get(`/api/orgs/${org}/projects`)).status).toBe(404);
    });
    it('the owner cannot leave or step down, only hand the organization over', async () => {
      expect((await admin.del(`/api/orgs/${org}/members/${admin.id}`)).status).toBe(409);
      expect((await admin.patch(`/api/orgs/${org}/members/${admin.id}`, { role: 'member' })).status).toBe(409);
      expect((await designer.post(`/api/orgs/${org}/transfer`, { user: designer.id })).status).toBe(403);
      // and owns no second organization
      expect((await admin.post('/api/orgs', { name: 'Another' })).status).toBe(409);
    });
    it('invites carry a project role, and a guest is invited to exactly one project', async () => {
      expect((await admin.post(`/api/orgs/${org}/invites`, { email: 'g@acme.io', role: 'guest', projects: [] })).status).toBe(400);
      expect((await admin.post(`/api/orgs/${org}/invites`, { email: 'g@acme.io', role: 'guest', projects: [project], projectRole: 'viewer' })).status).toBe(200);
      expect((await admin.post(`/api/orgs/${org}/invites`, { email: 'o@acme.io', role: 'owner' })).status).toBe(400);
      const panel = (await admin.get(`/api/orgs/${org}/admin`)).body;
      expect(panel.invites.find((i: { email: string }) => i.email === 'g@acme.io')).toMatchObject({ role: 'guest', project_role: 'viewer', project_ids: [project] });
      expect(panel.me.can).toContain('org.transfer');
    });
    it('rendered designs are sandboxed away from the app origin', async () => {
      const r = await designer.get(`/d/${project}/play`);
      expect(r.headers.get('content-security-policy')).toBe('sandbox allow-scripts');
      expect(JSON.stringify((await designer.get(`/d/${project}/api/doc`)).body.dir)).toBe('""');
    });
  });

  describe('the lifecycle', () => {
    let research = '', persona = '', story = '', home = '', pay = '';
    const advance = (who: Person = designer, body: object = {}) => who.post(`/api/projects/${project}/advance`, body);
    const requestReview = (who: Person = designer) => who.post(`/api/projects/${project}/review/request`, {});
    const approve = async () => {
      const r = await requestReview();
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return reviewer.post(`/api/projects/${project}/signoff`, { decision: 'approved' });
    };
    const design = (script: string, who: Person = designer) => who.post(`/d/${project}/api/rdl`, { script });
    const stageOf = (j: { stages: { id: string }[] }, id: string) => j.stages.find((s) => s.id === id) as unknown as { checks: { id: string; ok: boolean }[]; signoff: { status: string; approved: boolean }; warnings: unknown[] };

    it('starts at discovery as Full work in Main, and moving on with gaps only warns', async () => {
      const j = await journey();
      expect(j.project.stage).toBe('discovery');
      expect(j.workType.id).toBe('full');
      expect(j.workstream).toMatchObject({ name: 'Main', cycle: 1, work_type: 'full' });
      expect(j.strict).toBe(false);
      expect(stageOf(j, 'discovery').warnings.length).toBeGreaterThan(0);
    });
    it('the canvas is open at every stage, for people and agents', async () => {
      const r = await design('Frame w100 h100');
      expect(r.status).toBe(200);
      expect((await designer.get(`/d/${project}/api/doc`)).body.locked).toBeFalsy();
      const doc = (await designer.get(`/d/${project}/api/doc`)).body.data;
      await design('delete #' + doc.pages[Object.keys(doc.pages)[0]!].children.at(-1));
    });
    it('reviewers cannot change the plan', async () => {
      expect((await reviewer.post(`/api/projects/${project}/items`, { kind: 'brief', body: 'x' })).status).toBe(403);
      expect((await advance(reviewer)).status).toBe(403);
    });
    it('any item can be added at any stage', async () => {
      const r = await designer.post(`/api/projects/${project}/items`, { kind: 'metric', title: 'Early target' });
      expect(r.status).toBe(200);
      expect((await designer.del(`/api/projects/${project}/items/${r.body.id}`)).status).toBe(200);
      expect((await designer.del(`/api/projects/${project}/items/${r.body.id}`)).status).toBe(404);
    });
    it('Discovery checks a complete brief and an insight', async () => {
      await item('brief', { body: 'Checkout loses people', data: { users: 'Shoppers', goals: 'Convert', constraints: 'Mobile' } });
      research = await item('research', { title: 'Interview 1', data: { method: 'interview' } });
      expect(stageOf(await journey(), 'discovery').checks.find((c) => c.id === 'insight')!.ok).toBe(false);
      await designer.patch(`/api/projects/${project}/items/${research}`, { data: { insight: 'They abandon at the address form' } });
      const moved = await advance();
      expect(moved.status).toBe(200);
      expect(moved.body.warnings).toEqual([]);
    });
    it('Define needs a reviewer, nothing freezes in review, and a designer cannot self-approve', async () => {
      await item('problem', { body: 'A shopper needs to pay without retyping details' });
      persona = await item('persona', { title: 'Priya', data: { evidence: [research] } });
      story = await item('story', { title: 'Pay fast', data: { persona, want: 'pay', soThat: 'done' } });
      expect((await designer.post(`/api/projects/${project}/signoff`, { decision: 'approved' })).status).toBe(409); // nothing asked yet
      expect((await requestReview()).status).toBe(200);
      expect(mailbox.at(-1)).toMatchObject({ subject: 'Review requested: Checkout · Define' });
      expect(mailbox.at(-1)!.to).toContain('rae@acme.io');
      expect(mailbox.at(-1)!.to).not.toContain('dee@acme.io'); // not the person who asked
      expect((await designer.post(`/api/projects/${project}/signoff`, { decision: 'approved' })).status).toBe(403); // not your own request
      // work stays open while it is being decided
      const late = await designer.post(`/api/projects/${project}/items`, { kind: 'persona', title: 'Late' });
      expect(late.status).toBe(200);
      await designer.del(`/api/projects/${project}/items/${late.body.id}`);
      expect((await reviewer.post(`/api/projects/${project}/signoff`, { decision: 'changes_requested', note: 'Sharpen the problem' })).status).toBe(200);
      expect(mailbox.at(-1)).toMatchObject({ to: ['dee@acme.io'], subject: 'Changes requested: Checkout · Define' });
      expect(stageOf(await journey(), 'define').signoff.status).toBe('changes_requested');
      expect((await designer.patch(`/api/projects/${project}/items/${persona}`, { body: 'Sharper' })).status).toBe(200);
      expect((await approve()).status).toBe(200);
      expect(stageOf(await journey(), 'define').signoff.status).toBe('approved');
      expect((await advance()).status).toBe(200);
    });
    it('a review can be asked for with open checks, which travel as warnings', async () => {
      const r = await requestReview();
      expect(r.status).toBe(200); // IA has no screens yet
      expect(r.body.warnings).toContain('Screens listed');
      expect((await designer.post(`/api/projects/${project}/review/withdraw`)).status).toBe(200);
    });
    it('refuses references that point outside the project', async () => {
      const r = await designer.post(`/api/projects/${project}/items`, { kind: 'persona', title: 'x', data: { evidence: ['00000000-0000-4000-8000-000000000000'] } });
      expect(r.status).toBe(400);
    });
    it('rejects stray fields in item data', async () => {
      expect((await designer.post(`/api/projects/${project}/items`, { kind: 'persona', title: 'x', data: { hacked: true } })).status).toBe(400);
    });
    it('IA checks every story covered and every screen in a flow', async () => {
      home = await item('screen', { title: 'Cart', body: 'Review items', data: { stories: [story] } });
      pay = await item('screen', { title: 'Pay "now"', body: 'Enter card' });
      await item('flow', { title: 'Buy', data: { steps: [home, pay], story } });
      expect((await approve()).status).toBe(200);
      expect((await advance()).status).toBe(200);
      expect((await journey()).project.stage).toBe('wireframes');
    });
    it('Wireframes can start from a layout and a device', async () => {
      const r = await designer.post(`/api/projects/${project}/wireframes`, { device: 'phone' });
      expect(r.status).toBe(400); // not a device we offer
    });
    it('Wireframes are generated from the agreed screens, and need real layout', async () => {
      expect((await designer.post(`/api/projects/${project}/wireframes`)).body.created).toBe(2);
      expect((await designer.post(`/api/projects/${project}/wireframes`)).body.created).toBe(0);
      const j = await journey();
      expect(j.screenFrames.map((f: { device: string; primary: boolean }) => [f.device, f.primary])).toEqual([['desktop', true], ['desktop', true]]);
      expect(stageOf(j, 'wireframes').checks.find((c) => c.id === 'layout')!.ok).toBe(false);
      for (const f of j.frames) expect((await design(`insert #${f.id} end\n  Frame h200 wfill fill:subtle`)).status).toBe(200);
      // annotations are spec notes: designers write them, reviewers read them, the review count ignores them
      const frame = j.frames[0].id;
      const note = await designer.post(`/d/${project}/api/threads`, { node: frame, body: 'Validates on blur', kind: 'annotation' });
      expect(note.status).toBe(200);
      expect((await reviewer.post(`/d/${project}/api/threads`, { node: frame, body: 'x', kind: 'annotation' })).status).toBe(403);
      expect((await reviewer.post(`/d/${project}/api/threads/${note.body.id}/resolve`, { resolved: true })).status).toBe(403);
      const spec = await reviewer.get(`/d/${project}/spec`);
      expect(spec.body).toContain('Validates on blur');
      expect(spec.headers.get('content-security-policy')).toBe('sandbox allow-scripts allow-modals');
      expect((await outsider.get(`/d/${project}/spec`)).status).toBe(404);
      expect((await reviewer.get(`/d/${project}/?root=${frame}&skin=sketch`)).body).toContain('rk-rough');
      expect((await reviewer.post(`/d/${project}/api/rdl`, { script: 'Frame' })).status).toBe(403);
      expect((await requestReview()).status).toBe(200);
      expect((await design('Frame w10 h10')).status).toBe(200); // editing continues while it is reviewed
      await design('delete #' + (await designer.get(`/d/${project}/api/doc`)).body.data.pages[Object.keys((await designer.get(`/d/${project}/api/doc`)).body.data.pages)[0]].children.at(-1));
      await designer.post(`/api/projects/${project}/review/withdraw`);
      // a designer who did not ask can decide, once named an approver
      await admin.put(`/api/projects/${project}/members/${bystander.id}`, { approver: true });
      await requestReview();
      expect((await bystander.post(`/api/projects/${project}/signoff`, { decision: 'approved' })).status).toBe(200);
      await admin.del(`/api/projects/${project}/members/${bystander.id}`);
      expect((await advance()).status).toBe(200);
    });
    it('saves a named version automatically when leaving a design stage', async () => {
      const reviews = (await designer.get(`/d/${project}/api/reviews`)).body;
      expect(reviews.versions.map((v: { name: string }) => v.name)).toContain('Wireframes · cycle 1');
    });
    it('duplicate to device makes a linked frame of the same screen', async () => {
      const dup = await designer.post(`/api/projects/${project}/screens/${home}/frames`, { device: 'mobile' });
      expect(dup.status, JSON.stringify(dup.body)).toBe(200);
      expect(dup.body).toMatchObject({ device: 'mobile', w: 390, h: 844 });
      expect((await designer.post(`/api/projects/${project}/screens/${home}/frames`, { device: 'mobile' })).status).toBe(409);
      const custom = await designer.post(`/api/projects/${project}/screens/${home}/frames`, { device: 'custom', w: 1280, h: 720 });
      expect(custom.status).toBe(200);
      expect((await designer.post(`/api/projects/${project}/screens/${home}/frames`, { device: 'custom', w: 0, h: 720 })).status).toBe(400);
      expect((await reviewer.post(`/api/projects/${project}/screens/${home}/frames`, { device: 'ipad' })).status).toBe(403);
      expect((await outsider.post(`/api/projects/${project}/screens/${home}/frames`, { device: 'ipad' })).status).toBe(404);
      const j = await journey();
      const mine = j.screenFrames.filter((f: { screen: string }) => f.screen === home);
      expect(mine.map((f: { device: string }) => f.device).sort()).toEqual(['custom', 'desktop', 'mobile']);
      expect(j.frames.find((f: { id: string }) => f.id === dup.body.frame)).toMatchObject({ w: 390, h: 844 });
      // unlinking keeps the frame on the canvas; the primary frame stays linked
      const primary = mine.find((f: { primary: boolean }) => f.primary);
      expect((await designer.del(`/api/projects/${project}/screens/${home}/frames/${primary.id}`)).status).toBe(409);
      expect((await designer.del(`/api/projects/${project}/screens/${home}/frames/${custom.body.id}`)).status).toBe(200);
      await design(`delete #${custom.body.frame}`);
      const bundle = (await designer.get(`/api/projects/${project}/handoff`)).body;
      expect(bundle.screens.find((s: { name: string }) => s.name === 'Cart').devices.map((d: { device: string }) => d.device)).toEqual(['desktop', 'mobile']);
    });
    it('Prototype passes when every flow is linked, on any device', async () => {
      await approve();
      expect((await advance()).status).toBe(200);
      const gap = await advance();
      expect(gap.status).toBe(200); // open checks never block moving on
      expect(gap.body.warnings.some((w: string) => /clicked end to end/.test(w))).toBe(true);
      await designer.post(`/api/projects/${project}/send-back`, { to: 'prototype', note: 'Link the flow' });
      const j = await journey();
      const [from, to] = j.items.filter((i: { kind: string }) => i.kind === 'screen').map((i: { data: { frame: string } }) => i.data.frame);
      expect((await design(`proto start #${from}\nproto #${from}\n  click navigate #${to} dissolve`)).status).toBe(200);
      expect(stageOf(await journey(), 'prototype').checks.every((c) => c.ok)).toBe(true);
      expect((await advance()).status).toBe(200);
    });
    it('the canvas stays open during testing, and a finding pins to its screen', async () => {
      expect((await design('Frame w10 h10')).status).toBe(200);
      await design('delete #' + (await designer.get(`/d/${project}/api/doc`)).body.data.pages[Object.keys((await designer.get(`/d/${project}/api/doc`)).body.data.pages)[0]].children.at(-1));
      const task = await item('test_task', { title: 'Buy a thing', data: { story, success: 'Paid' } });
      const results = [{ task, outcome: 'pass' }];
      for (let i = 1; i <= 3; i++) await item('test_session', { title: `P${i}`, data: { results } });
      const f = await item('finding', { title: 'Card field unclear', body: 'P2 hesitated', data: { severity: 'P1', screen: pay } }, reviewer);
      const reviews = (await designer.get(`/d/${project}/api/reviews`)).body;
      expect(reviews.threads.some((t: { kind: string; title: string }) => t.kind === 'review' && t.title === 'Card field unclear')).toBe(true);
      expect(stageOf(await journey(), 'testing').checks.find((c) => c.id === 'severe')!.ok).toBe(false);
      expect((await designer.patch(`/api/projects/${project}/items/${f}`, { status: 'fix' })).status).toBe(200);
    });
    it('sending work back voids sign-offs', async () => {
      const r = await designer.post(`/api/projects/${project}/send-back`, { to: 'visual', note: 'Fix the card field' });
      expect(r.status).toBe(200);
      let j = await journey();
      expect(stageOf(j, 'visual').signoff.approved).toBe(false);
      await approve();
      await advance();
      await advance();
      j = await journey();
      expect(j.project.stage).toBe('testing');
      expect(stageOf(j, 'testing').signoff.approved).toBe(false);
    });
    it('only the lead records a skipped gate, and it is on the record', async () => {
      expect((await advance(designer, { override: 'ship it' })).status).toBe(403);
      expect((await advance(admin, { override: 'Legal deadline' })).status).toBe(200);
      const j = await journey();
      expect(j.events.at(-1)).toMatchObject({ kind: 'override', note: 'Legal deadline' });
      const audit = (await admin.get(`/api/orgs/${org}/admin`)).body.audit;
      expect(audit[0].action).toBe('stage.override');
    });
    it('strict mode blocks approval and release on failing checks until someone else overrides', async () => {
      expect((await designer.patch(`/api/orgs/${org}/settings`, { strictMode: true })).status).toBe(403);
      expect((await admin.patch(`/api/orgs/${org}/settings`, { strictMode: true })).status).toBe(200);
      expect((await journey()).strict).toBe(true);
      // Handoff has open checks (no states, no notes yet)
      expect((await requestReview()).status).toBe(200);
      const blocked = await reviewer.post(`/api/projects/${project}/signoff`, { decision: 'approved' });
      expect(blocked.status).toBe(409);
      expect(blocked.body.strict).toBe(true);
      expect((await designer.post(`/api/projects/${project}/overrides`, { action: 'approve', reason: 'x' })).status).toBe(403);
      expect((await admin.post(`/api/projects/${project}/overrides`, { action: 'approve', reason: '' })).status).toBe(400);
      expect((await admin.post(`/api/projects/${project}/overrides`, { action: 'approve', reason: 'Signed off by legal in person' })).status).toBe(200);
      const approved = await reviewer.post(`/api/projects/${project}/signoff`, { decision: 'approved' });
      expect(approved.status).toBe(200);
      expect(approved.body.exceptions.length).toBeGreaterThan(0);
      // leaving Handoff is the release: the person releasing cannot be the one who overrode
      expect((await advance(admin)).status).toBe(409);
      expect((await admin.post(`/api/projects/${project}/overrides`, { action: 'release', reason: 'Hotfix window' })).status).toBe(200);
      expect((await advance(admin)).status).toBe(409);
      expect((await admin.patch(`/api/orgs/${org}/settings`, { strictMode: false })).status).toBe(200);
      await designer.post(`/api/projects/${project}/review/withdraw`);
    });
    it('Handoff needs every state and a bundle developers can use', async () => {
      const j = await journey();
      for (const s of j.items.filter((i: { kind: string }) => i.kind === 'screen')) {
        await designer.patch(`/api/projects/${project}/items/${s.id}`, { data: { spec: 'See tokens', states: { hover: 'done', loading: 'done', empty: 'na', error: 'done' } } });
      }
      await approve();
      expect((await advance()).status).toBe(200);
      const bundle = (await designer.get(`/api/projects/${project}/handoff`)).body;
      expect(bundle.screens).toHaveLength(2);
      expect(bundle.screens[0].rdl).toBeTruthy();
      expect(bundle.screens.flatMap((x: { annotations: { body: string }[] }) => x.annotations.map((a) => a.body))).toContain('Validates on blur');
    });
    it('Post-launch feedback becomes research in the next cycle, in a new Main', async () => {
      await item('metric', { title: 'Conversion', data: { target: '60%', actual: '64%' } });
      const fb = await item('feedback', { title: 'Wants Apple Pay', body: 'Asked 12 times', data: { source: 'Support' } }, reviewer);
      expect((await designer.post(`/api/projects/${project}/next-cycle`, { promote: [fb] })).status).toBe(200);
      const j = await journey();
      expect(j.project).toMatchObject({ stage: 'discovery', cycle: 2 });
      expect(j.workstream).toMatchObject({ name: 'Main', cycle: 2, work_type: 'full' });
      expect(j.workstreams.map((w: { cycle: number; status: string }) => [w.cycle, w.status])).toEqual([[2, 'active'], [1, 'closed']]);
      const carried = j.items.find((i: { kind: string; title: string }) => i.kind === 'research' && i.title === 'Wants Apple Pay');
      expect(carried.cycle).toBe(2);
      expect(carried.workstream_id).toBe(j.workstream.id);
      expect(carried.data.fromFeedback).toBe(fb);
      // personas and screens carry forward; this cycle needs its own insight
      const discovery = stageOf(j, 'discovery');
      expect(discovery.checks.find((c) => c.id === 'insight')!.ok).toBe(false);
      expect(j.items.some((i: { kind: string }) => i.kind === 'persona')).toBe(true);
    });
    it('a project change needs write access, and a missing project is not found', async () => {
      expect((await reviewer.patch(`/api/projects/${project}`, { name: 'Hijack' })).status).toBe(403);
      expect((await outsider.patch(`/api/projects/${project}`, { name: 'Hijack' })).status).toBe(404);
      expect((await designer.patch('/api/projects/00000000-0000-4000-8000-000000000000', { name: 'x' })).status).toBe(404);
      expect((await designer.patch(`/api/projects/${project}`, { workType: 'regulated' })).status).toBe(200);
      const j = await journey();
      expect(j.workType.id).toBe('regulated');
      expect(j.strict).toBe(true);
      expect(stageOf(j, 'define').signoff).toMatchObject({ needed: 2 });
      await designer.patch(`/api/projects/${project}`, { workType: 'full' });
    });
    it('new work defaults to Feature, and the project list only shows what you can open', async () => {
      const r = await designer.post(`/api/orgs/${org}/projects`, { name: 'Side quest' });
      expect(r.status).toBe(200);
      const j = (await designer.get(`/api/projects/${r.body.id}/journey`)).body;
      expect(j.workType.id).toBe('feature');
      expect(j.stages.find((s: { id: string }) => s.id === 'define').signoff.required).toBe(false);
      const list = (await reviewer.get(`/api/orgs/${org}/projects`)).body;
      expect(list.projects.map((p: { id: string }) => p.id)).toEqual([project]);
      expect(list.projects[0].work_type).toBe('full');
      expect((await bystander.get(`/api/orgs/${org}/projects`)).body.projects).toEqual([]);
    });
  });

  describe('account recovery', () => {
    const reset = () => /\/reset\/([\w-]+)/.exec(mailbox.at(-1)!.text)![1]!;
    it('resets a password once, signs out everywhere, and does not reveal who has an account', async () => {
      const anon = new Person(base, '', '');
      const before = mailbox.length;
      expect((await anon.post('/api/auth/forgot', { email: 'nobody@nowhere.io' })).status).toBe(200);
      expect(mailbox.length).toBe(before);
      const p = new Person(base, 'bo@acme.io', 'Bo');
      await p.post('/api/auth/login', { email: 'bo@acme.io', password: 'correct horse battery' });
      expect((await anon.post('/api/auth/forgot', { email: 'bo@acme.io' })).status).toBe(200);
      const token = reset();
      expect((await anon.post('/api/auth/reset', { token, password: 'a brand new secret' })).status).toBe(200);
      expect((await anon.post('/api/auth/reset', { token, password: 'another new secret' })).status).toBe(400);
      expect((await p.get('/api/me')).status).toBe(401);
      expect((await p.post('/api/auth/login', { email: 'bo@acme.io', password: 'a brand new secret' })).status).toBe(200);
      bystander.cookie = p.cookie;
    }, 20000);
    it('reports health without signing in', async () => {
      expect((await new Person(base, '', '').get('/healthz')).body).toEqual({ ok: true });
    });
    it('shows who needs to act on the project list', async () => {
      const row = (await reviewer.get(`/api/orgs/${org}/projects`)).body.projects[0];
      expect(row).toHaveProperty('attention');
      expect(row).toHaveProperty('review');
    });
  });

  describe('persistence and agents', () => {
    let p2 = '';
    let token = '';
    const mcp = async (who: string, projectId: string) => {
      const client = new Client({ name: 't', version: '1' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/d/${projectId}/mcp`), { requestInit: { headers: { authorization: `Bearer ${who}` } } }));
      return client;
    };
    const textOf = (r: unknown) => (r as { content: { text: string }[] }).content[0]!.text;
    const ALL_SCOPES = ['read', 'propose', 'draft', 'items', 'export', 'jobs'];
    /** A token the way the app's token screen makes one: for named projects, with chosen scopes. */
    const mint = async (who: Person, name: string, projects = [p2], scopes = ALL_SCOPES) => {
      const r = await who.post('/api/tokens', { name, projects, scopes });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      return r.body as { id: string; token: string };
    };

    beforeAll(async () => {
      p2 = (await admin.post(`/api/orgs/${org}/projects`, { name: 'Agent project' })).body.id;
      await owner.tx((q) => q(`UPDATE projects SET stage = 'visual' WHERE id = $1`, [p2]));
      await admin.put(`/api/projects/${p2}/members/${reviewer.id}`, { role: 'reviewer', approver: true });
      await admin.put(`/api/projects/${p2}/members/${designer.id}`, { role: 'designer' });
      token = (await mint(designer, 'Claude Code')).token;
    });

    it('stores design edits in the database, attributed to the editor', async () => {
      expect((await designer.post(`/d/${p2}/api/rdl`, { script: 'Frame name:Saved w100 h100' })).status).toBe(200);
      await settle();
      const [row] = await owner.tx((q) => q(`SELECT data::text AS d, updated_by FROM designs WHERE project_id = $1`, [p2]));
      expect(row.d).toContain('"Saved"');
      expect(row.updated_by).toBe(designer.id);
    });
    it('a reviewer comment saves without touching the design row', async () => {
      const [before] = await owner.tx((q) => q(`SELECT updated_at FROM designs WHERE project_id = $1`, [p2]));
      expect((await reviewer.post(`/d/${p2}/api/threads`, { node: null, body: 'Nice' })).status).toBe(200);
      await settle();
      const [after] = await owner.tx((q) => q(`SELECT updated_at FROM designs WHERE project_id = $1`, [p2]));
      expect(after.updated_at).toEqual(before.updated_at);
      const [rev] = await owner.tx((q) => q(`SELECT data::text AS d FROM design_reviews WHERE project_id = $1`, [p2]));
      expect(rev.d).toContain('Nice');
    });
    it('keeps uploaded images per project, behind access checks', async () => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const up = await designer.post(`/d/${p2}/api/assets`, { name: 'a', dataUrl: png });
      expect(up.status).toBe(200);
      const path = `/d/${p2}/assets/${up.body.file}`;
      const ok = await designer.get(path);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('cache-control')).toMatch(/^private/);
      expect((await outsider.get(path)).status).toBe(404);
      expect((await bystander.get(path)).status).toBe(404);
    });
    it('agents work through a token, as the person who issued it', async () => {
      const client = await mcp(token, p2);
      const r = await client.callTool({ name: 'rdl_apply', arguments: { script: 'Frame name:FromAgent w100 h100' } });
      expect((r as { isError?: boolean }).isError).toBeFalsy();
      await settle();
      const [row] = await owner.tx((q) => q(`SELECT data::text AS d, updated_by FROM designs WHERE project_id = $1`, [p2]));
      expect(row.d).toContain('FromAgent');
      expect(row.updated_by).toBe(designer.id);
      expect(textOf(await client.callTool({ name: 'journey_get', arguments: {} }))).toContain('"stage":"visual"');
      await client.close();
    });
    it('a screenshot queued in the app reaches the agent, once, and only editors can queue', async () => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
      const asset = (await designer.post(`/d/${p2}/api/assets`, { name: 'sketch', dataUrl: png })).body;
      expect((await reviewer.post(`/d/${p2}/api/agent-requests`, { prompt: 'x' })).status).toBe(403);
      expect((await designer.post(`/d/${p2}/api/agent-requests`, {})).status).toBe(400);
      expect((await outsider.post(`/d/${p2}/api/agent-requests`, { prompt: 'x' })).status).toBe(404);
      const made = await designer.post(`/d/${p2}/api/agent-requests`, { prompt: 'Build this', asset: asset.id, device: 'mobile' });
      expect(made.status).toBe(200);
      const client = await mcp(token, p2);
      const r = (await client.callTool({ name: 'agent_requests', arguments: {} })) as { content: { type: string; text?: string; mimeType?: string; data?: string }[] };
      expect(r.content[0]!.text).toContain('Build this');
      expect(r.content[0]!.text).toContain('mobile');
      expect(r.content[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
      expect(r.content[1]!.data!.length).toBeGreaterThan(20);
      expect(textOf(await client.callTool({ name: 'agent_requests', arguments: {} }))).toContain('Nothing is waiting');
      expect(textOf(await client.callTool({ name: 'agent_request_done', arguments: { id: made.body.id, frame: 'nope' } }))).toMatch(/not found/);
      const built = textOf(await client.callTool({ name: 'wireframe_start', arguments: { name: 'From sketch', device: 'mobile' } }));
      const frame = /#(\w+)/.exec(built)![1]!;
      expect(textOf(await client.callTool({ name: 'agent_request_done', arguments: { id: made.body.id, frame } }))).toContain('done');
      const reviews = (await designer.get(`/d/${p2}/api/reviews`)).body;
      expect(reviews.requests[0]).toMatchObject({ status: 'done', frame });
      await client.close();
    }, 20000);
    it('a reviewer token cannot take the queue', async () => {
      const rt = (await mint(reviewer, 'rq')).token;
      const client = await mcp(rt, p2);
      expect(textOf(await client.callTool({ name: 'agent_requests', arguments: {} }))).toMatch(/cannot edit the design/);
      await client.close();
    });
    it('the agent drafts planned screens from what earlier stages agreed, and they count', async () => {
      const screen = (await designer.post(`/api/projects/${p2}/items`, { kind: 'screen', title: 'Inbox', body: 'See what needs you' })).body.id as string;
      await owner.tx((q) => q(`UPDATE projects SET stage = 'wireframes' WHERE id = $1`, [p2]));
      await designer.post(`/api/projects/${p2}/agent-wireframes`, { device: 'desktop' });
      expect((await designer.post(`/api/projects/${p2}/agent-wireframes`, {})).body.queued).toBe(0); // already queued
      const client = await mcp(token, p2);
      const r = textOf(await client.callTool({ name: 'agent_requests', arguments: {} }));
      expect(r).toContain('Inbox');
      expect(r).toContain('See what needs you');
      const id = /Request (ar\d+)/.exec(r)![1]!;
      const frame = /#(\w+)/.exec(textOf(await client.callTool({ name: 'wireframe_start', arguments: { name: 'Inbox', template: 'list' } })))![1]!;
      await client.callTool({ name: 'agent_request_done', arguments: { id, frame } });
      await settle();
      const j = (await designer.get(`/api/projects/${p2}/journey`)).body;
      expect(j.items.find((i: { id: string }) => i.id === screen).data.frame).toBe(frame);
      await client.close();
      await owner.tx((q) => q(`UPDATE projects SET stage = 'visual' WHERE id = $1`, [p2]));
    }, 20000);
    it('live cursors reach teammates with the account name, not a typed one', async () => {
      const ctrl = new AbortController();
      const res = await fetch(`${base}/d/${p2}/events`, { headers: { cookie: reviewer.cookie }, signal: ctrl.signal });
      const reader = res.body!.getReader();
      const seen = (async () => {
        let buf = '';
        while (!buf.includes('event: cursor')) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += new TextDecoder().decode(value);
        }
        return buf;
      })();
      expect((await designer.call('POST', `/d/${p2}/api/cursor`, { clientId: 'c1', x: 10, y: 20 }, { 'x-rangoli-name': 'Spoofed' })).status).toBe(204);
      const got = await seen;
      ctrl.abort();
      expect(got).toContain('"name":"Dee"');
      expect(got).not.toContain('Spoofed');
      expect((await outsider.post(`/d/${p2}/api/cursor`, { clientId: 'c2', x: 1, y: 1 })).status).toBe(404);
    }, 10000);
    it('the server disk is off limits to agents', async () => {
      const client = await mcp(token, p2);
      const r = await client.callTool({ name: 'asset_upload', arguments: { path: 'C:/Windows/win.ini' } });
      expect(textOf(r)).toMatch(/off in hosted/);
      await client.close();
    });
    it('a reviewer token cannot edit, and a token cannot cross tenants', async () => {
      const rt = (await mint(reviewer, 'r')).token;
      const client = await mcp(rt, p2);
      const r = await client.callTool({ name: 'rdl_apply', arguments: { script: 'Frame' } });
      expect(textOf(r)).toMatch(/cannot edit the design/);
      await client.close();
      // a token cannot even be made for someone else's project
      expect((await outsider.post('/api/tokens', { name: 'e', projects: [p2], scopes: ALL_SCOPES })).status).toBe(403);
      const evilOrg = (await outsider.get('/api/me')).body.orgs[0].id as string;
      const evilProject = (await outsider.post(`/api/orgs/${evilOrg}/projects`, { name: 'Evil' })).body.id as string;
      const et = (await mint(outsider, 'e', [evilProject])).token;
      await expect(mcp(et, p2)).rejects.toBeTruthy();
    });
    it('a browser session cannot open MCP, and access ends mid-session', async () => {
      expect((await designer.post(`/d/${p2}/mcp`, {})).status).toBe(401);
      const client = await mcp(token, p2);
      await admin.del(`/api/projects/${p2}/members/${designer.id}`);
      await expect(client.callTool({ name: 'doc_outline', arguments: {} })).rejects.toThrow(/Not found/);
      await client.close().catch(() => undefined);
      await admin.put(`/api/projects/${p2}/members/${designer.id}`, { role: 'designer' });
    });
    it('revoked tokens stop working', async () => {
      const made = await mint(designer, 'temp');
      await designer.del(`/api/tokens/${made.id}`);
      await expect(mcp(made.token, p2)).rejects.toBeTruthy();
    });
    it('an agent token works on MCP and nowhere else', async () => {
      const adminToken = (await mint(admin, 'a')).token;
      const bearer = { authorization: `Bearer ${adminToken}` };
      const anon = new Person(base, '', '');
      const suggestion = await reviewer.post(`/d/${p2}/api/changesets`, { script: 'Frame name:Suggested w10 h10', label: 'try' });
      expect(suggestion.status).toBe(200);
      const human: [string, string, object?][] = [
        ['POST', `/d/${p2}/api/changesets/${suggestion.body.id}/accept`, {}],
        ['POST', `/d/${p2}/api/mode`, { mode: 'suggest' }],
        ['POST', `/d/${p2}/api/rdl`, { script: 'Frame' }],
        ['GET', `/d/${p2}/api/doc`],
        ['GET', `/d/${p2}/api/reviews`],
        ['GET', `/d/${p2}/assets/aaaaaaaaaaaa.png`],
        ['GET', `/d/${p2}/`],
      ];
      for (const [method, path, body] of human) expect((await anon.call(method, path, body, bearer)).status, path).toBe(403);
      // a browser session on the same request does not widen what the token may do
      expect((await admin.call('POST', `/d/${p2}/api/mode`, { mode: 'suggest' }, bearer)).status).toBe(403);
      // members and approvals were always session-only; this is what keeps them that way
      expect((await anon.call('POST', `/api/projects/${p2}/signoff`, { decision: 'approved' }, bearer)).status).toBe(401);
      expect((await anon.call('PUT', `/api/projects/${p2}/members/${outsider.id}`, {}, bearer)).status).toBe(401);
      expect((await anon.call('PATCH', `/api/orgs/${org}/members/${reviewer.id}`, { role: 'admin' }, bearer)).status).toBe(401);
      const doc = (await designer.get(`/d/${p2}/api/doc`)).body;
      expect(doc.agentMode).toBe('direct');
      const reviews = (await designer.get(`/d/${p2}/api/reviews`)).body;
      expect(reviews.changesets.find((c: { id: string }) => c.id === suggestion.body.id).status).toBe('pending');
      // still a person's call, and still possible with a session
      expect((await designer.post(`/d/${p2}/api/changesets/${suggestion.body.id}/reject`)).status).toBe(200);

      const client = await mcp(adminToken, p2);
      expect(textOf(await client.callTool({ name: 'journey_get', arguments: {} }))).toContain('"stage":"visual"');
      await client.close();
    }, 20000);
    it('nobody can decide a review they asked for, and a decision outlives the account', async () => {
      const id = (await admin.post(`/api/orgs/${org}/projects`, { name: 'Self review', workType: 'full' })).body.id as string;
      await admin.put(`/api/projects/${id}/members/${designer.id}`, { role: 'designer' });
      await admin.put(`/api/projects/${id}/members/${reviewer.id}`, { role: 'reviewer', approver: true });
      await owner.tx((q) => q(`UPDATE projects SET stage = 'define' WHERE id = $1`, [id]));
      const ask = (who: Person) => owner.tx((q) => q(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor) VALUES ($1, $2, 1, 'review_requested', 'define', 'define', $3)`, [id, org, who.id]));
      const decide = (who: Person) => who.post(`/api/projects/${id}/signoff`, { decision: 'approved' });

      await ask(admin);
      const own = await decide(admin);
      expect(own.status, JSON.stringify(own.body)).toBe(403);
      expect(own.body.error).toMatch(/someone else/);
      expect((await admin.get(`/api/orgs/${org}/projects`)).body.projects.find((p: { id: string }) => p.id === id).attention).toBeNull();
      await ask(designer);
      expect((await decide(designer)).status).toBe(403);
      expect((await decide(reviewer)).status).toBe(200);

      const rhea = new Person(base, 'rhea@acme.io', 'Rhea');
      await invite(rhea, 'reviewer', [id]);
      expect((await decide(rhea)).status).toBe(200);
      await owner.tx((q) => q(`DELETE FROM users WHERE id = $1`, [rhea.id]));
      const j = (await admin.get(`/api/projects/${id}/journey`)).body;
      const signoff = j.stages.find((s: { id: string }) => s.id === 'define').signoff;
      expect(signoff.approved).toBe(true);
      expect(signoff.decisions).toHaveLength(2);
      const former = signoff.decisions.find((d: { reviewer: string }) => d.reviewer.startsWith('former:'));
      expect(j.people.find((p: { id: string }) => p.id === former.reviewer).name).toBe('Rhea');
    }, 20000);
    it('resetting a password ends the account API tokens too', async () => {
      const tess = new Person(base, 'tess@acme.io', 'Tess');
      await invite(tess, 'designer', [p2]);
      const t = (await mint(tess, 'agent')).token;
      const client = await mcp(t, p2);
      await client.close();
      const anon = new Person(base, '', '');
      await anon.post('/api/auth/forgot', { email: tess.email });
      const reset = /\/reset\/([\w-]+)/.exec(mailbox.at(-1)!.text)![1]!;
      expect((await anon.post('/api/auth/reset', { token: reset, password: 'a brand new secret' })).status).toBe(200);
      await expect(mcp(t, p2)).rejects.toBeTruthy();
      const [row] = await owner.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM api_tokens WHERE user_id = $1`, [tess.id]));
      expect(row!.n).toBe(0);
    }, 20000);
    it('a character split across two network chunks survives', async () => {
      const name = 'Rae € Müller';
      expect(await sendSplit(`${base}/api/me`, 'PATCH', reviewer.cookie, { name }, '€')).toBe(200);
      expect((await reviewer.get('/api/me')).body.user.name).toBe(name);
      await reviewer.patch('/api/me', { name: 'Rae' });
      const body = 'The price reads €5 — fix it';
      expect(await sendSplit(`${base}/d/${p2}/api/threads`, 'POST', designer.cookie, { node: null, body }, '€')).toBe(200);
      const reviews = (await designer.get(`/d/${p2}/api/reviews`)).body;
      expect(reviews.threads.some((t: { messages?: { body: string }[]; body?: string }) => JSON.stringify(t).includes(body))).toBe(true);
    }, 20000);
    it('a design reloads intact from the database after a restart', async () => {
      await settle();
      await app.close();
      app = await startApp({ db, port: 0, mail });
      base = app.url.replace(/\/$/, '');
      for (const p of [admin, designer, reviewer, outsider, bystander]) (p as { base: string }).base = base;
      const doc = (await designer.get(`/d/${p2}/api/doc`)).body;
      const names = Object.values(doc.data.pages as Record<string, { nodes: Record<string, { name: string }> }>).flatMap((pg) => Object.values(pg.nodes).map((n) => n.name));
      expect(names).toContain('Saved');
      expect(names).toContain('FromAgent');
    });
  });
});
