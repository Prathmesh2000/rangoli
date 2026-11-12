import { agentHasCapability, hasCapability, type Capability, type OrganizationRole, type ProjectRole, type Subject, type TokenScope } from '@rangoli/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase, tokenActor, withUser, type Database, type Q } from './db.js';
import { MIGRATIONS } from './schema.js';

/**
 * The attack matrix: every actor (each organization role, each project role, a guest, an outsider, and API
 * tokens) tries every verb on every tenant table, in its own organization and in another. What should happen
 * comes from packages/engine/src/capabilities.ts, never from this file, and each attempt is rolled back so
 * they stay independent. One mismatch anywhere fails the test and is named.
 */

interface Tenant {
  org: string;
  project: string;
  /** in the organization, on no project */
  member: string;
  /** on the project, for changing or removing */
  staffed: string;
  /** asked for the open review on the project */
  requester: string;
}

interface Actor {
  name: string;
  id: string;
  org: 'A' | 'B';
  subject: Subject;
  token?: { id: string; scopes: TokenScope[] };
}

type Expect = (can: (c: Capability) => boolean, actor: Actor, t: Tenant) => boolean;

interface Attempt {
  name: string;
  sql: (t: Tenant, a: Actor) => [string, unknown[]];
  expect: Expect;
}

const need = (c: Capability): Expect => (can) => can(c);

describe('row level security attack matrix', () => {
  let db: Database;
  const A = {} as Tenant;
  const B = {} as Tenant;
  const actors: Actor[] = [];
  const as = <T>(id: string | null, fn: (q: Q) => Promise<T>) => withUser(db, id, fn);
  const signup = async (name: string) => (await as(null, (q) => q<{ id: string }>(`SELECT auth_signup($1, $2, 'hash') AS id`, [`${name}@matrix.io`, name])))[0]!.id;
  // policies never look inside the design, and a small row keeps hundreds of rolled-back rewrites cheap
  const doc = '{}';
  const HASH = 'b'.repeat(64);
  let seq = 1000;

  beforeAll(async () => {
    db = await openDatabase({ url: process.env.TEST_DATABASE_URL });
    const people: Record<string, string> = {};
    for (const n of ['alice', 'adam', 'mona', 'designer', 'designer_na', 'researcher', 'product_manager', 'developer', 'reviewer', 'viewer', 'gus', 'erin', 'bea']) people[n] = await signup(n);
    await db.tx((q) => q(`UPDATE users SET email_verified_at = now() WHERE email LIKE '%@matrix.io'`));
    const org = async (who: string, name: string) => (await as(who, (q) => q<{ id: string }>('SELECT id FROM create_org($1)', [name])))[0]!.id;
    const project = async (who: string, o: string) => (await as(who, (q) => q<{ id: string }>(`SELECT create_project($1, 'M', '', $2::json) AS id`, [o, doc])))[0]!.id;
    Object.assign(A, { org: await org(people.alice!, 'Matrix A'), member: people.mona, staffed: people.viewer, requester: people.alice });
    Object.assign(B, { org: await org(people.erin!, 'Matrix B'), member: people.bea, staffed: people.erin, requester: people.erin });
    A.project = await project(people.alice!, A.org);
    B.project = await project(people.erin!, B.org);
    const staff: [string, OrganizationRole, ProjectRole | null, boolean][] = [
      ['adam', 'admin', null, false],
      ['mona', 'member', null, false],
      ['designer', 'member', 'designer', true],
      ['designer_na', 'member', 'designer', false],
      ['researcher', 'member', 'researcher', true],
      ['product_manager', 'member', 'product_manager', true],
      ['developer', 'member', 'developer', true],
      ['reviewer', 'member', 'reviewer', true],
      ['viewer', 'member', 'viewer', true],
      ['gus', 'guest', 'reviewer', true],
    ];
    await db.tx(async (q) => {
      for (const [n, orgRole, projectRole, approver] of staff) {
        await q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [A.org, people[n], orgRole]);
        if (projectRole) await q(`INSERT INTO project_members (project_id, org_id, user_id, role, is_approver) VALUES ($1, $2, $3, $4, $5)`, [A.project, A.org, people[n], projectRole, approver]);
      }
      await q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [B.org, people.bea]);
      for (const t of [A, B]) {
        await q(`SELECT set_config('app.user_id', $1, true)`, [t.requester]);
        await q(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor) VALUES ($1, $2, 1, 'review_requested', 'ia', 'ia', $3)`, [t.project, t.org, t.requester]);
        await q(`INSERT INTO items (project_id, org_id, kind, cycle, title, created_by) VALUES ($1, $2, 'research', 1, 'seed', $3)`, [t.project, t.org, t.requester]);
        await q(`INSERT INTO invites (org_id, email, role, token_hash, expires_at) VALUES ($1, 'x@matrix.io', 'member', $2, now() + interval '1 day')`, [t.org, `inv-${t.org}`]);
        await q(`INSERT INTO audit_log (org_id, actor, action) VALUES ($1, $2, 'seed')`, [t.org, t.requester]);
        await q(`INSERT INTO design_ops (project_id, org_id, seq, page_id, actor_kind, actor_id, author, ops, inverse) VALUES ($1, $2, 1, 'p', 'human', $3, 't', '[]', '[]')`, [t.project, t.org, t.requester]);
        await q(`INSERT INTO design_pages (project_id, org_id, page_id, data, seq, hash) VALUES ($1, $2, 'p', '{}', 1, $3)`, [t.project, t.org, HASH]);
      }
    });
    const subjects: Record<string, Subject> = {
      alice: { orgRole: 'owner', projectRole: 'lead', isApprover: true },
      erin: { orgRole: 'owner', projectRole: 'lead', isApprover: true },
    };
    for (const [n, orgRole, projectRole, approver] of staff) subjects[n] = { orgRole, ...(projectRole ? { projectRole } : {}), isApprover: approver };
    for (const [n, subject] of Object.entries(subjects)) actors.push({ name: n, id: people[n]!, org: n === 'erin' ? 'B' : 'A', subject });
    // tokens: the person's role, narrowed by the scopes
    const mint = async (who: string, scopes: TokenScope[]) =>
      (await db.tx((q) => q<{ id: string }>(`INSERT INTO api_tokens (user_id, name, token_hash, org_id, project_ids, scopes, expires_at) VALUES ($1, 't', $2, $3, $4::uuid[], $5::text[], now() + interval '1 day') RETURNING id`, [people[who], `tok-${who}-${scopes.join('+')}`, A.org, [A.project], scopes])))[0]!.id;
    for (const [who, scopes] of [['alice', ['read', 'propose', 'draft', 'items', 'export', 'jobs']], ['designer', ['draft']], ['designer', ['read']], ['reviewer', ['propose', 'items']]] as [string, TokenScope[]][]) {
      actors.push({ name: `${who} token ${scopes.join('+')}`, id: people[who]!, org: 'A', subject: subjects[who]!, token: { id: await mint(who, scopes), scopes } });
    }
  }, 120000);
  afterAll(() => db?.close());

  const attempts: Attempt[] = [
    // reads
    // who works on a project is visible to whoever staffs it
    { name: 'SELECT project_members', sql: (t) => [`SELECT 1 FROM project_members WHERE project_id = $1`, [t.project]], expect: (can) => can('design.view') || can('org.members.manage') },
    ...['designs', 'design_reviews', 'items', 'stage_events', 'design_ops', 'design_pages', 'workstreams'].map((table): Attempt => ({ name: `SELECT ${table}`, sql: (t) => [`SELECT 1 FROM ${table} WHERE project_id = $1`, [t.project]], expect: need('design.view') })),
    { name: 'SELECT projects', sql: (t) => [`SELECT 1 FROM projects WHERE id = $1`, [t.project]], expect: (can) => can('design.view') || can('org.members.manage') },
    { name: 'SELECT invites', sql: (t) => [`SELECT 1 FROM invites WHERE org_id = $1`, [t.org]], expect: need('org.members.manage') },
    { name: 'SELECT audit_log', sql: (t) => [`SELECT 1 FROM audit_log WHERE org_id = $1`, [t.org]], expect: need('org.audit.read') },
    { name: 'SELECT org_members (someone else)', sql: (t) => [`SELECT 1 FROM org_members WHERE org_id = $1 AND user_id = $2`, [t.org, t.member]], expect: need('org.directory.read') },
    // design writes
    { name: 'UPDATE designs', sql: (t) => [`UPDATE designs SET data = data WHERE project_id = $1 RETURNING 1`, [t.project]], expect: need('design.edit') },
    { name: 'UPDATE design_reviews', sql: (t) => [`UPDATE design_reviews SET data = data WHERE project_id = $1 RETURNING 1`, [t.project]], expect: need('comment') },
    { name: 'INSERT design_versions', sql: (t) => [`INSERT INTO design_versions (project_id, org_id, version_id, data) VALUES ($1, $2, $3, '{}') RETURNING 1`, [t.project, t.org, `v${seq++}`]], expect: need('design.edit') },
    { name: 'INSERT design_assets', sql: (t) => [`INSERT INTO design_assets (project_id, org_id, file, mime, bytes) VALUES ($1, $2, $3, 'image/png', '\\x01') RETURNING 1`, [t.project, t.org, `f${seq++}.png`]], expect: need('design.edit') },
    {
      name: 'INSERT design_ops (as itself)',
      sql: (t, a) => [`INSERT INTO design_ops (project_id, org_id, seq, page_id, actor_kind, actor_id, token_id, author, ops, inverse) VALUES ($1, $2, $3, 'p', $4, app_uid(), $5, 't', '[]', '[]') RETURNING 1`, [t.project, t.org, seq++, a.token ? 'agent' : 'human', a.token?.id ?? null]],
      expect: need('design.edit'),
    },
    { name: 'INSERT design_pages', sql: (t) => [`INSERT INTO design_pages (project_id, org_id, page_id, data, seq, hash) VALUES ($1, $2, $3, '{}', 1, $4) RETURNING 1`, [t.project, t.org, `p${seq++}`, HASH]], expect: need('design.edit') },
    { name: 'UPDATE projects', sql: (t) => [`UPDATE projects SET name = name WHERE id = $1 RETURNING 1`, [t.project]], expect: need('design.edit') },
    // the lifecycle
    { name: 'INSERT items (plan)', sql: (t) => [`INSERT INTO items (project_id, org_id, kind, cycle, created_by) VALUES ($1, $2, 'persona', 1, app_uid()) RETURNING 1`, [t.project, t.org]], expect: need('design.edit') },
    { name: 'INSERT items (evidence)', sql: (t) => [`INSERT INTO items (project_id, org_id, kind, cycle, created_by) VALUES ($1, $2, 'finding', 1, app_uid()) RETURNING 1`, [t.project, t.org]], expect: need('evidence.add') },
    { name: 'UPDATE items (someone else\'s)', sql: (t) => [`UPDATE items SET title = 'x' WHERE project_id = $1 AND title = 'seed' RETURNING 1`, [t.project]], expect: need('design.edit') },
    { name: 'DELETE items (someone else\'s)', sql: (t) => [`DELETE FROM items WHERE project_id = $1 AND title = 'seed' RETURNING 1`, [t.project]], expect: need('design.edit') },
    { name: 'INSERT stage_events (advance)', sql: (t) => [`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor) VALUES ($1, $2, 1, 'advance', 'ia', 'wireframes', app_uid()) RETURNING 1`, [t.project, t.org]], expect: need('design.edit') },
    { name: 'INSERT stage_events (override)', sql: (t) => [`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor) VALUES ($1, $2, 1, 'override', 'ia', 'wireframes', app_uid()) RETURNING 1`, [t.project, t.org]], expect: need('override.strict') },
    {
      name: 'INSERT stage_signoffs',
      sql: (t) => [`INSERT INTO stage_signoffs (project_id, org_id, cycle, stage, decision, reviewer) VALUES ($1, $2, 1, 'ia', 'approved', app_uid()) RETURNING 1`, [t.project, t.org]],
      // a named approver, never on their own request, never through a token
      expect: (can, a, t) => can('approve') && !a.token && a.id !== t.requester,
    },
    // people
    { name: 'INSERT project_members', sql: (t) => [`INSERT INTO project_members (project_id, org_id, user_id, role) VALUES ($1, $2, $3, 'viewer') RETURNING 1`, [t.project, t.org, t.member]], expect: (can) => can('members.manage') || can('org.members.manage') },
    { name: 'UPDATE project_members', sql: (t) => [`UPDATE project_members SET is_approver = NOT is_approver WHERE project_id = $1 AND user_id = $2 RETURNING 1`, [t.project, t.staffed]], expect: (can) => can('members.manage') || can('org.members.manage') },
    { name: 'DELETE project_members', sql: (t) => [`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2 RETURNING 1`, [t.project, t.staffed]], expect: (can) => can('members.manage') || can('org.members.manage') },
    { name: 'UPDATE org_members', sql: (t) => [`UPDATE org_members SET role = 'admin' WHERE org_id = $1 AND user_id = $2 RETURNING 1`, [t.org, t.member]], expect: need('org.members.manage') },
    { name: 'INSERT invites', sql: (t) => [`INSERT INTO invites (org_id, email, role, token_hash, expires_at) VALUES ($1, 'y@matrix.io', 'member', $2, now() + interval '1 day') RETURNING 1`, [t.org, `inv${seq++}`]], expect: need('org.members.manage') },
    // the organization and its projects
    { name: 'UPDATE orgs', sql: (t) => [`UPDATE orgs SET name = name WHERE id = $1 RETURNING 1`, [t.org]], expect: need('org.settings.manage') },
    { name: 'DELETE orgs', sql: (t) => [`DELETE FROM orgs WHERE id = $1 RETURNING 1`, [t.org]], expect: need('org.delete') },
    { name: 'DELETE projects', sql: (t) => [`DELETE FROM projects WHERE id = $1 RETURNING 1`, [t.project]], expect: need('org.projects.delete') },
    { name: 'create_project', sql: (t) => [`SELECT create_project($1, 'x', '', '{}'::json) AS id`, [t.org]], expect: need('org.projects.create') },
  ];

  /**
   * Runs every attempt for one actor in one organization inside a single transaction on one connection, each
   * behind its own savepoint and rolled back to it, then rolls the whole transaction back. 'ok' when the statement
   * reached at least one row; refused (42501) or reaching nothing is 'no'. One transaction per actor rather than
   * per attempt keeps this to a few round trips each.
   */
  const runAll = (a: Actor, list: [string, unknown[]][]): Promise<('ok' | 'no')[]> =>
    // one dedicated connection, set up exactly as withUser sets up a request
    db.session(async (s) => {
      const out: ('ok' | 'no')[] = [];
      await s.exec('BEGIN');
      try {
        await s.exec('SET LOCAL ROLE rangoli_app');
        await s.query(`SELECT set_config('app.user_id', $1, true), set_config('app.token_id', $2, true)`, [a.id, a.token?.id ?? '']);
        // a statement that hangs fails the test instead of the run
        await s.exec(`SET LOCAL statement_timeout = '15s'`);
        for (const [sql, params] of list) {
          await s.exec('SAVEPOINT attempt');
          try {
            out.push((await s.query(sql, params)).length > 0 ? 'ok' : 'no');
          } catch (e) {
            if ((e as { code?: string }).code !== '42501') throw e;
            out.push('no');
          }
          await s.exec('ROLLBACK TO SAVEPOINT attempt');
        }
      } finally {
        await s.exec('ROLLBACK');
      }
      return out;
    });

  it('decides every policy through has_capability, never by comparing role names', async () => {
    const policies = await db.tx((q) => q<{ tablename: string; policyname: string; expr: string }>(`SELECT tablename, policyname, coalesce(qual, '') || ' ' || coalesce(with_check, '') AS expr FROM pg_policies WHERE schemaname = 'public'`));
    const byRole = policies.filter((p) => /project_role_of\(|org_role_of\([^)]*\)\s*(=|<>|IN|=\s*ANY)/i.test(p.expr));
    expect(byRole.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
  });

  it('a guest sees its project and the people in it, not the organization', async () => {
    const gus = actors.find((x) => x.name === 'gus')!;
    const visible = await as(gus.id, (q) => q<{ user_id: string }>(`SELECT user_id FROM org_members WHERE org_id = $1`, [A.org]));
    expect(visible.map((r) => r.user_id)).not.toContain(A.member); // mona is on no project
    expect(visible.map((r) => r.user_id)).toContain(gus.id);
    expect(await as(gus.id, (q) => q(`SELECT 1 FROM users WHERE id = $1`, [A.member]))).toHaveLength(0);
  });

  it('a guest works in one project', async () => {
    const gus = actors.find((x) => x.name === 'gus')!;
    const alice = actors.find((x) => x.name === 'alice')!;
    const second = (await as(alice.id, (q) => q<{ id: string }>(`SELECT create_project($1, 'Second', '', '{}'::json) AS id`, [A.org])))[0]!.id;
    await expect(as(alice.id, (q) => q(`INSERT INTO project_members (project_id, org_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`, [second, A.org, gus.id]))).rejects.toThrow(/guest works in one project/);
    // and someone on two projects cannot be turned into a guest
    const designer = actors.find((x) => x.name === 'designer' && !x.token)!;
    await as(alice.id, (q) => q(`INSERT INTO project_members (project_id, org_id, user_id, role) VALUES ($1, $2, $3, 'viewer')`, [second, A.org, designer.id]));
    await expect(as(alice.id, (q) => q(`UPDATE org_members SET role = 'guest' WHERE org_id = $1 AND user_id = $2`, [A.org, designer.id]))).rejects.toThrow(/guest works in one project/);
    await as(alice.id, (q) => q(`DELETE FROM projects WHERE id = $1`, [second]));
    // a guest invite names exactly one project
    await expect(as(alice.id, (q) => q(`INSERT INTO invites (org_id, email, role, token_hash, project_ids, expires_at) VALUES ($1, 'g@matrix.io', 'guest', 'g-inv', '{}', now() + interval '1 day')`, [A.org]))).rejects.toMatchObject({ code: '23514' });
  });

  it('an account owns one organization but can be a guest in others', async () => {
    const alice = actors.find((x) => x.name === 'alice')!;
    await expect(as(alice.id, (q) => q(`SELECT * FROM create_org('Second')`))).rejects.toThrow(/already own an organization/);
    // erin owns B and can still belong to A, as a guest
    await db.tx((q) => q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'guest')`, [A.org, B.requester]));
    expect(await as(B.requester, (q) => q(`SELECT 1 FROM orgs WHERE id = $1`, [A.org]))).toHaveLength(1);
    await db.tx((q) => q(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [A.org, B.requester]));
  });

  it('hands an organization over only by transfer, from the owner, to a member who owns nothing', async () => {
    const adam = actors.find((x) => x.name === 'adam')!;
    const alice = actors.find((x) => x.name === 'alice')!;
    await expect(as(adam.id, (q) => q(`SELECT transfer_org($1, $2)`, [A.org, adam.id]))).rejects.toMatchObject({ code: '42501' });
    await expect(tokenActor.run(actors.find((x) => x.token && x.id === alice.id)!.token!.id, () => as(alice.id, (q) => q(`SELECT transfer_org($1, $2)`, [A.org, adam.id])))).rejects.toMatchObject({ code: '42501' });
    await expect(as(alice.id, (q) => q(`SELECT transfer_org($1, $2)`, [A.org, actors.find((x) => x.name === 'gus')!.id]))).rejects.toThrow(/member of the organization/);
    await db.tx((q) => q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [A.org, B.requester]));
    await expect(as(alice.id, (q) => q(`SELECT transfer_org($1, $2)`, [A.org, B.requester]))).rejects.toThrow(/already owns an organization/);
    await db.tx((q) => q(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2`, [A.org, B.requester]));
    await as(alice.id, (q) => q(`SELECT transfer_org($1, $2)`, [A.org, adam.id]));
    const roles = await db.tx((q) => q<{ user_id: string; role: string }>(`SELECT user_id, role FROM org_members WHERE org_id = $1 AND user_id = ANY ($2::uuid[])`, [A.org, [alice.id, adam.id]]));
    expect(Object.fromEntries(roles.map((r) => [r.user_id, r.role]))).toEqual({ [alice.id]: 'admin', [adam.id]: 'owner' });
    expect((await db.tx((q) => q<{ owner_id: string }>(`SELECT owner_id FROM orgs WHERE id = $1`, [A.org])))[0]!.owner_id).toBe(adam.id);
    await as(adam.id, (q) => q(`SELECT transfer_org($1, $2)`, [A.org, alice.id]));
  });

  it('refuses a 101st project, counting concurrent creations one at a time under the organization lock', async () => {
    const owner = await signup('hundred');
    const o = (await as(owner, (q) => q<{ id: string }>(`SELECT id FROM create_org('Hundred')`)))[0]!.id;
    await db.tx((q) => q(`INSERT INTO projects (org_id, name) SELECT $1, 'p' || n FROM generate_series(1, 98) n`, [o]));
    const create = () => as(owner, (q) => q(`SELECT create_project($1, 'last', '', '{}'::json)`, [o]));
    const results = await Promise.allSettled([create(), create(), create()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results.filter((x): x is PromiseRejectedResult => x.status === 'rejected')) expect(String(r.reason.message)).toMatch(/at most 100 projects/);
    expect((await db.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM projects WHERE org_id = $1`, [o])))[0]!.n).toBe(100);
    // even the schema owner cannot go past it
    await expect(db.tx((q) => q(`INSERT INTO projects (org_id, name) VALUES ($1, 'over')`, [o]))).rejects.toThrow(/at most 100 projects/);
  }, 60000);

  it('every actor, table, verb and organization does what capabilities.ts says and nothing more', async () => {
    const broken: string[] = [];
    let tried = 0;
    for (const a of actors) {
      for (const [label, t] of [['own org', a.org === 'A' ? A : B], ['other org', a.org === 'A' ? B : A]] as const) {
        // in another organization the actor holds no role at all; a token is narrowed to its scopes
        const subject: Subject = label === 'own org' ? a.subject : {};
        const can = (c: Capability) => (a.token ? agentHasCapability({ person: subject, scopes: a.token.scopes, work: { kind: 'solo_frame' } }, c) : hasCapability(subject, c));
        const got = await runAll(a, attempts.map((attempt) => attempt.sql(t, a)));
        attempts.forEach((attempt, i) => {
          const want = attempt.expect(can, a, t) ? 'ok' : 'no';
          tried++;
          if (got[i] !== want) broken.push(`${a.name} · ${label} · ${attempt.name}: ${got[i]}, should be ${want}`);
        });
      }
    }
    expect(broken).toEqual([]);
    expect(tried).toBeGreaterThan(700);
  }, 180000);
});

describe('migration 008 backfill', () => {
  /** An embedded database migrated only as far as asked, so data can be laid down in the old shape. */
  const bare = async (): Promise<Database> => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.waitReady;
    const query: Q = async (sql, params) => (await pg.query(sql, params as unknown[])).rows as never;
    return {
      driver: 'pglite',
      tx: (fn) => pg.transaction(async (t) => fn(async (sql, params) => (await t.query(sql, params as unknown[])).rows as never)) as never,
      exec: async (sql) => void (await pg.exec(sql)),
      session: (fn) => fn({ query, exec: async (sql) => void (await pg.exec(sql)) }),
      singleton: async () => undefined,
      close: () => pg.close(),
    };
  };

  it('turns admin, designer and reviewer into owner or admin, member and designer, member and reviewer', async () => {
    const db = await bare();
    const at = MIGRATIONS.findIndex((m) => m.id === '008_roles');
    await migrate(db, { migrations: MIGRATIONS.slice(0, at) });
    const ids = await db.tx(async (q) => {
      const user = async (n: string) => (await q<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1, $1, 'h') RETURNING id`, [`${n}@old.io`]))[0]!.id;
      const [creator, admin2, designer, reviewer, multi] = [await user('creator'), await user('admin2'), await user('designer'), await user('reviewer'), await user('multi')];
      const org = async (name: string, by: string) => (await q<{ id: string }>(`INSERT INTO orgs (name, slug, created_by) VALUES ($1, $1, $2) RETURNING id`, [name, by]))[0]!.id;
      const o1 = await org('old1', creator);
      const o2 = await org('old2', multi);
      const o3 = await org('old3', multi);
      for (const [o, u, r] of [[o1, creator, 'admin'], [o1, admin2, 'admin'], [o1, designer, 'designer'], [o1, reviewer, 'reviewer'], [o2, multi, 'admin'], [o3, multi, 'admin']]) await q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [o, u, r]);
      const p = (await q<{ id: string }>(`INSERT INTO projects (org_id, name) VALUES ($1, 'P') RETURNING id`, [o1]))[0]!.id;
      for (const u of [designer, reviewer]) await q(`INSERT INTO project_members (project_id, org_id, user_id) VALUES ($1, $2, $3)`, [p, o1, u]);
      // 007 wants a verified person behind an invite
      await q(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [creator]);
      await q(`SELECT set_config('app.user_id', $1, true)`, [creator]);
      await q(`INSERT INTO invites (org_id, email, role, token_hash, expires_at) VALUES ($1, 'r@old.io', 'reviewer', 'old-inv', now() + interval '1 day')`, [o1]);
      return { creator, admin2, designer, reviewer, multi, o1, o2, o3, p };
    });
    await migrate(db);
    const org = await db.tx((q) => q<{ user_id: string; role: string }>(`SELECT user_id, role FROM org_members WHERE org_id = $1`, [ids.o1]));
    expect(Object.fromEntries(org.map((r) => [r.user_id, r.role]))).toEqual({ [ids.creator]: 'owner', [ids.admin2]: 'admin', [ids.designer]: 'member', [ids.reviewer]: 'member' });
    const project = await db.tx((q) => q<{ user_id: string; role: string; is_approver: boolean }>(`SELECT user_id, role, is_approver FROM project_members WHERE project_id = $1`, [ids.p]));
    expect(Object.fromEntries(project.map((r) => [r.user_id, [r.role, r.is_approver]]))).toEqual({
      // admins reached every project before, so they keep it, as Lead
      [ids.creator]: ['lead', true],
      [ids.admin2]: ['lead', true],
      [ids.designer]: ['designer', true],
      [ids.reviewer]: ['reviewer', true],
    });
    // an account that already owned two keeps both; only one counts toward the limit
    const owned = await db.tx((q) => q<{ id: string; owner_id: string; owner_legacy: boolean }>(`SELECT id, owner_id, owner_legacy FROM orgs WHERE owner_id = $1 ORDER BY created_at, id`, [ids.multi]));
    expect(owned.map((o) => o.owner_legacy)).toEqual([false, true]);
    const [invite] = await db.tx((q) => q<{ role: string; project_role: string; is_approver: boolean }>(`SELECT role, project_role, is_approver FROM invites WHERE token_hash = 'old-inv'`));
    expect(invite).toEqual({ role: 'member', project_role: 'reviewer', is_approver: true });
    const [{ n }] = (await db.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM orgs o WHERE (SELECT count(*) FROM org_members m WHERE m.org_id = o.id AND m.role = 'owner') <> 1`))) as [{ n: number }];
    expect(n).toBe(0);
    await db.close();
  }, 120000);
});
