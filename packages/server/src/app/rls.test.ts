import { createDocument } from '@rangoli/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, tokenActor, withUser, type Database, type Q } from './db.js';

/**
 * Attacks the database directly as each role, with no application code in front of it.
 * If a policy regresses, this fails even when the HTTP layer would have hidden the problem.
 */
const TENANT_TABLES = ['org_members', 'invites', 'projects', 'project_members', 'designs', 'design_reviews', 'design_versions', 'design_assets', 'items', 'stage_events', 'stage_signoffs', 'audit_log', 'design_ops', 'design_pages', 'design_checkpoints'];
const PROJECT_TABLES = ['project_members', 'designs', 'design_reviews', 'design_versions', 'design_assets', 'items', 'stage_events', 'stage_signoffs', 'design_ops', 'design_pages', 'design_checkpoints'];

describe('row level security', () => {
  let db: Database;
  const u: Record<'alice' | 'bob' | 'carol' | 'dave' | 'erin', string> = {} as never;
  let orgA = '';
  let orgB = '';
  let p1 = '';
  let p2 = '';
  const as = <T>(id: string | null, fn: (q: Q) => Promise<T>) => withUser(db, id, fn);
  const denied = async (p: Promise<unknown>) => {
    await expect(p).rejects.toMatchObject({ code: expect.stringMatching(/42501/) });
  };
  const doc = JSON.stringify(createDocument('x').data);
  const HASH = 'a'.repeat(64);
  /** A live token for who on these projects, made the way the app makes one. Returns its id. */
  const mintToken = async (who: string, projects: string[], scopes: string[], hash = `h-${Math.random()}`) =>
    (await as(who, (q) => q<{ id: string }>(`SELECT token_create('t', $1, $2::uuid[], $3::text[], 30) AS id`, [hash, projects, scopes])))[0]!.id;
  const addOp = (q: Q, seq: number, actorId: string | null, tokenId: string | null = null, kind = tokenId ? 'agent' : 'human', project = p1, org = orgA) =>
    q(`INSERT INTO design_ops (project_id,org_id,seq,page_id,actor_kind,actor_id,token_id,author,ops,inverse) VALUES ($1,$2,$3,'p1',$4,$5,$6,'t','[]','[]') RETURNING 1`, [project, org, seq, kind, actorId, tokenId]);

  beforeAll(async () => {
    db = await openDatabase({ url: process.env.TEST_DATABASE_URL });
    for (const n of ['alice', 'bob', 'carol', 'dave', 'erin'] as const) {
      const [row] = await as(null, (q) => q<{ id: string }>(`SELECT auth_signup($1,$2,'hash') AS id`, [`${n}@x.io`, n]));
      u[n] = row!.id;
    }
    // verified addresses, as every account that invites, decides or makes tokens must have
    await db.tx((owner) => owner(`UPDATE users SET email_verified_at = now()`));
    const org = async (who: string, name: string) => (await as(who, (q) => q<{ id: string }>('SELECT id FROM create_org($1)', [name])))[0]!.id;
    orgA = await org(u.alice, 'Acme');
    orgB = await org(u.erin, 'Beta');
    const project = async (who: string, o: string, n: string) => (await as(who, (q) => q<{ id: string }>(`SELECT create_project($1,$2,'',$3::json) AS id`, [o, n, doc])))[0]!.id;
    p1 = await project(u.alice, orgA, 'One');
    p2 = await project(u.erin, orgB, 'Two');
    // joining normally goes through accept_invite; the owner shortcut keeps this setup short
    await db.tx(async (owner) => {
      for (const id of [u.bob, u.carol, u.dave]) await owner(`INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'member')`, [orgA, id]);
      // a decision already on the record, from before this suite's reviews
      await owner(`SELECT set_config('app.user_id', $1, true)`, [u.alice]); // decisions need a verified person behind them
      await owner(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'define','approved',$3)`, [p1, orgA, u.alice]);
    });
    // alice made p1, so she leads it: bob designs, carol reviews, both approve; dave is in the org but not on p1
    await as(u.alice, async (q) => {
      for (const [id, role] of [[u.bob, 'designer'], [u.carol, 'reviewer']] as const) await q(`INSERT INTO project_members (project_id,org_id,user_id,role,is_approver) VALUES ($1,$2,$3,$4,true)`, [p1, orgA, id, role]);
      await q(`INSERT INTO items (project_id,org_id,kind,cycle,title,created_by) VALUES ($1,$2,'research',1,'secret-a',$3)`, [p1, orgA, u.alice]);
      await q(`INSERT INTO design_assets (project_id,org_id,file,mime,bytes) VALUES ($1,$2,'a.png','image/png',$3)`, [p1, orgA, Buffer.from([1])]);
      await q(`INSERT INTO design_versions (project_id,org_id,version_id,data) VALUES ($1,$2,'v1','{}')`, [p1, orgA]);
      await q(`INSERT INTO invites (org_id,email,role,token_hash,expires_at) VALUES ($1,'x@x.io','member','h1',now()+interval '1 day')`, [orgA]);
      await q(`INSERT INTO audit_log (org_id,actor,action) VALUES ($1,$2,'test')`, [orgA, u.alice]);
      await addOp(q, 1, u.alice);
      await q(`INSERT INTO design_pages (project_id,org_id,page_id,data,seq,hash) VALUES ($1,$2,'p1','{}',1,$3)`, [p1, orgA, HASH]);
      await q(`INSERT INTO design_checkpoints (project_id,org_id,page_id,seq,data,hash) VALUES ($1,$2,'p1',1,'{}',$3)`, [p1, orgA, HASH]);
    });
  }, 60000);
  afterAll(() => db.close());

  it('covers every table, and the app role has no way around it', async () => {
    const tables = await db.tx((q) => q<{ relname: string; relrowsecurity: boolean; owner: string }>(`
      SELECT c.relname, c.relrowsecurity, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> 'schema_migrations'`));
    expect(tables.length).toBeGreaterThan(15);
    for (const t of tables) {
      expect(t.relrowsecurity, `${t.relname} must have RLS on`).toBe(true);
      expect(t.owner, `${t.relname} must not be owned by the app role`).not.toBe('rangoli_app');
    }
    const [role] = await db.tx((q) => q<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>(`SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = 'rangoli_app'`));
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    const [mig] = await db.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'rangoli_app' AND table_name = 'schema_migrations'`));
    expect(mig!.n).toBe(0);
  });

  it('a signed-out request sees nothing in any table', async () => {
    for (const t of ['users', 'orgs', ...TENANT_TABLES]) {
      const rows = await as(null, (q) => q(`SELECT 1 FROM ${t}`));
      expect(rows, t).toHaveLength(0);
    }
  });

  it('another org cannot see a single row of this org', async () => {
    for (const t of TENANT_TABLES) {
      const rows = await as(u.erin, (q) => q(`SELECT 1 FROM ${t} WHERE org_id = $1`, [orgA]));
      expect(rows, t).toHaveLength(0);
    }
    expect(await as(u.erin, (q) => q(`SELECT 1 FROM orgs WHERE id = $1`, [orgA]))).toHaveLength(0);
    expect(await as(u.erin, (q) => q(`SELECT 1 FROM users WHERE id = $1`, [u.alice]))).toHaveLength(0);
  });

  it('another org cannot write into this org', async () => {
    await denied(as(u.erin, (q) => q(`INSERT INTO items (project_id,org_id,kind,cycle,created_by) VALUES ($1,$2,'research',1,$3)`, [p1, orgA, u.erin])));
    const updated = await as(u.erin, (q) => q(`UPDATE designs SET data = '{}' WHERE project_id = $1 RETURNING 1`, [p1]));
    expect(updated).toHaveLength(0);
    expect(await as(u.erin, (q) => q(`DELETE FROM projects WHERE id = $1 RETURNING 1`, [p1]))).toHaveLength(0);
    await denied(as(u.erin, (q) => q(`INSERT INTO project_members (project_id,org_id,user_id) VALUES ($1,$2,$3)`, [p1, orgA, u.erin])));
  });

  it('a row cannot be pointed at a project in a different org', async () => {
    // even the table owner is stopped by the composite foreign key
    await expect(db.tx((q) => q(`INSERT INTO items (project_id,org_id,kind,cycle) VALUES ($1,$2,'research',1)`, [p1, orgB]))).rejects.toMatchObject({ code: '23503' });
    await expect(as(u.erin, (q) => q(`INSERT INTO items (project_id,org_id,kind,cycle,created_by) VALUES ($1,$2,'research',1,$3)`, [p2, orgA, u.erin]))).rejects.toBeTruthy();
  });

  it('within an org, a project is invisible until you are assigned', async () => {
    for (const t of PROJECT_TABLES) expect(await as(u.dave, (q) => q(`SELECT 1 FROM ${t} WHERE project_id = $1`, [p1])), t).toHaveLength(0);
    expect(await as(u.dave, (q) => q(`SELECT 1 FROM projects WHERE id = $1`, [p1]))).toHaveLength(0);
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM projects WHERE id = $1`, [p1]))).toHaveLength(1);
    expect(await as(u.alice, (q) => q(`SELECT 1 FROM projects WHERE id = $1`, [p1]))).toHaveLength(1);
  });

  it('credentials are unreadable by the app role', async () => {
    await denied(as(u.alice, (q) => q(`SELECT password_hash FROM users`)));
    await denied(as(u.alice, (q) => q(`SELECT * FROM users`)));
    await denied(as(u.alice, (q) => q(`SELECT * FROM auth_sessions`)));
    await denied(as(u.alice, (q) => q(`SELECT * FROM api_tokens`)));
    await denied(as(u.alice, (q) => q(`SELECT * FROM password_resets`)));
    await denied(as(u.alice, (q) => q(`UPDATE users SET email = 'x@y.io' WHERE id = $1`, [u.alice])));
  });

  const signoff = (who: string, stage: string) => as(who, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,$3,'approved',$4) RETURNING 1`, [p1, orgA, stage, who]));
  const askFor = (who: string, stage: string) => db.tx((q) => q(`INSERT INTO stage_events (project_id,org_id,cycle,kind,from_stage,to_stage,actor) VALUES ($1,$2,1,'review_requested',$3,$3,$4)`, [p1, orgA, stage, who]));

  it('nobody decides a review they asked for, whatever their role', async () => {
    await askFor(u.alice, 'wireframes');
    await denied(signoff(u.alice, 'wireframes')); // an admin
    expect(await signoff(u.carol, 'wireframes')).toHaveLength(1);
    await askFor(u.carol, 'visual');
    await denied(signoff(u.carol, 'visual')); // a reviewer who asked before their role changed
    expect(await signoff(u.alice, 'visual')).toHaveLength(1);
  });

  it('a session on an API token can never sign off', async () => {
    await askFor(u.bob, 'testing');
    // a real, live token of the same person that covers this project
    const token = await mintToken(u.carol, [p1], ['read', 'propose', 'draft', 'items', 'export', 'jobs']);
    await denied(tokenActor.run(token, () => signoff(u.carol, 'testing')));
    await denied(tokenActor.run('00000000-0000-4000-8000-000000000001', () => signoff(u.carol, 'testing')));
    expect(await signoff(u.carol, 'testing')).toHaveLength(1); // the same person, from a browser session
  });

  it('a sign-off outlives the reviewer, under the name it was made with', async () => {
    const [row] = await as(null, (q) => q<{ id: string }>(`SELECT auth_signup('frank@x.io','Frank','hash') AS id`));
    const frank = row!.id;
    await db.tx((owner) => owner(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [frank]));
    await db.tx((owner) => owner(`INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'member')`, [orgA, frank]));
    await as(u.alice, (q) => q(`INSERT INTO project_members (project_id,org_id,user_id,role,is_approver) VALUES ($1,$2,$3,'reviewer',true)`, [p1, orgA, frank]));
    await askFor(u.alice, 'handoff');
    await as(frank, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer,reviewer_name) VALUES ($1,$2,1,'handoff','approved',$3,'Someone Else')`, [p1, orgA, frank]));
    expect(await as(u.alice, (q) => q(`SELECT reviewer, reviewer_name FROM stage_signoffs WHERE stage = 'handoff'`))).toEqual([{ reviewer: frank, reviewer_name: 'Frank' }]);
    await db.tx((owner) => owner(`DELETE FROM users WHERE id = $1`, [frank]));
    expect(await as(u.alice, (q) => q(`SELECT reviewer, reviewer_name FROM stage_signoffs WHERE stage = 'handoff'`))).toEqual([{ reviewer: null, reviewer_name: 'Frank' }]);
  });

  it('the production login can only ever become the app role', async () => {
    // on a real server this logs in as rangoli_login; PGlite is always a superuser session, so it impersonates
    const appUrl = process.env.TEST_APP_DATABASE_URL;
    const login = appUrl ? await openDatabase({ url: process.env.TEST_DATABASE_URL, appUrl }) : null;
    const attempt = (sql: string) => (login ?? db).tx(async (q) => { if (!login) await q('SET LOCAL SESSION AUTHORIZATION rangoli_login'); return q(sql); });
    if (login) expect((await attempt('SELECT session_user AS u'))[0].u).toBe('rangoli_login');
    await expect(attempt('SET LOCAL ROLE rangoli_app')).resolves.toBeDefined();
    await expect(attempt('SET LOCAL ROLE postgres'), 'SET ROLE').rejects.toBeTruthy();
    await expect(attempt(`SELECT set_config('role', 'postgres', true)`), 'set_config').rejects.toBeTruthy();
    await expect(attempt('SELECT * FROM schema_migrations'), 'migrations').rejects.toBeTruthy();
    const [role] = await db.tx((q) => q(`SELECT rolsuper, rolbypassrls, rolcreaterole FROM pg_roles WHERE rolname = 'rangoli_login'`));
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreaterole: false });
    await login?.close();
    // PGlite keeps a SET LOCAL SESSION AUTHORIZATION after its transaction ends; without this, every later
    // schema-owner step in this file would quietly run as rangoli_login
    if (!login) await db.exec('SET SESSION AUTHORIZATION postgres');
  });

  it('the app role cannot escalate out of the sandbox', async () => {
    await expect(as(u.bob, (q) => q(`ALTER TABLE items DISABLE ROW LEVEL SECURITY`))).rejects.toBeTruthy();
    await expect(as(u.bob, (q) => q(`DROP POLICY items_read ON items`))).rejects.toBeTruthy();
  });

  it('reviewers cannot change the design or the plan', async () => {
    expect(await as(u.carol, (q) => q(`UPDATE designs SET data = '{}' WHERE project_id = $1 RETURNING 1`, [p1]))).toHaveLength(0);
    expect(await as(u.carol, (q) => q(`UPDATE projects SET stage = 'launch' WHERE id = $1 RETURNING 1`, [p1]))).toHaveLength(0);
    await denied(as(u.carol, (q) => q(`INSERT INTO items (project_id,org_id,kind,cycle,created_by) VALUES ($1,$2,'persona',1,$3)`, [p1, orgA, u.carol])));
    await denied(as(u.carol, (q) => q(`INSERT INTO stage_events (project_id,org_id,cycle,kind,to_stage,actor) VALUES ($1,$2,1,'advance','define',$3)`, [p1, orgA, u.carol])));
    expect(await as(u.carol, (q) => q(`UPDATE design_reviews SET data = '{"c":1}' WHERE project_id = $1 RETURNING 1`, [p1]))).toHaveLength(1);
  });

  it('reviewers log findings, and can only touch their own', async () => {
    const [mine] = await as(u.carol, (q) => q<{ id: string }>(`INSERT INTO items (project_id,org_id,kind,cycle,title,created_by) VALUES ($1,$2,'finding',1,'stuck',$3) RETURNING id`, [p1, orgA, u.carol]));
    const [other] = await as(u.bob, (q) => q<{ id: string }>(`INSERT INTO items (project_id,org_id,kind,cycle,title,created_by) VALUES ($1,$2,'finding',1,'b',$3) RETURNING id`, [p1, orgA, u.bob]));
    expect(await as(u.carol, (q) => q(`UPDATE items SET title='x' WHERE id=$1 RETURNING 1`, [mine!.id]))).toHaveLength(1);
    expect(await as(u.carol, (q) => q(`UPDATE items SET title='x' WHERE id=$1 RETURNING 1`, [other!.id]))).toHaveLength(0);
    await denied(as(u.carol, (q) => q(`UPDATE items SET kind='persona' WHERE id=$1 RETURNING 1`, [mine!.id])));
    await denied(as(u.carol, (q) => q(`INSERT INTO items (project_id,org_id,kind,cycle,created_by) VALUES ($1,$2,'finding',1,$3)`, [p1, orgA, u.bob])));
  });

  it('designers cannot approve their own work or skip gates', async () => {
    // nothing has been asked of define yet: nobody can decide what was never put to review
    await denied(as(u.carol, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'define','approved',$3)`, [p1, orgA, u.carol])));
    await askFor(u.bob, 'define');
    await denied(as(u.bob, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'define','approved',$3)`, [p1, orgA, u.bob])));
    await denied(as(u.bob, (q) => q(`INSERT INTO stage_events (project_id,org_id,cycle,kind,to_stage,actor) VALUES ($1,$2,1,'override','define',$3)`, [p1, orgA, u.bob])));
    await denied(as(u.carol, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'define','approved',$3)`, [p1, orgA, u.alice])));
    const rows = await as(u.carol, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'define','approved',$3) RETURNING 1`, [p1, orgA, u.carol]));
    expect(rows).toHaveLength(1);
  });

  it('the design log is append-only and every row states who really wrote it', async () => {
    const [catalog] = await db.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('design_ops','design_pages','design_checkpoints') AND relforcerowsecurity AND relrowsecurity`));
    expect(catalog!.n).toBe(3);
    // no one rewrites history, whatever their role
    for (const who of [u.alice, u.bob, u.carol]) {
      await denied(as(who, (q) => q(`UPDATE design_ops SET label = 'x'`)));
      await denied(as(who, (q) => q(`DELETE FROM design_ops`)));
      await denied(as(who, (q) => q(`DELETE FROM design_checkpoints`)));
    }
    await denied(as(u.bob, (q) => addOp(q, 50, u.alice))); // a row claiming to be someone else
    await denied(as(u.carol, (q) => addOp(q, 51, u.carol))); // reviewers do not edit
    await denied(as(u.bob, (q) => addOp(q, 52, u.bob, null, 'system'))); // nor can a person write as the system
    await denied(as(u.bob, (q) => addOp(q, 53, u.bob, null, 'agent')));
    await denied(as(u.erin, (q) => addOp(q, 54, u.erin))); // another org
    await denied(as(u.dave, (q) => addOp(q, 55, u.dave))); // same org, not on the project
    expect(await as(u.bob, (q) => addOp(q, 2, u.bob))).toHaveLength(1);
    await expect(as(u.bob, (q) => addOp(q, 2, u.bob))).rejects.toMatchObject({ code: '23505' }); // a second writer is fenced
  });

  it('a token writes the log as itself and cannot pretend to be a person', async () => {
    const token = await mintToken(u.bob, [p1], ['draft']);
    await denied(tokenActor.run(token, () => as(u.bob, (q) => addOp(q, 60, u.bob, null, 'human')))); // a token session claiming no token
    await denied(tokenActor.run(token, () => as(u.bob, (q) => addOp(q, 61, u.bob, '00000000-0000-4000-8000-000000000009', 'agent'))));
    expect(await tokenActor.run(token, () => as(u.bob, (q) => addOp(q, 3, u.bob, token)))).toHaveLength(1);
  });

  it('design checkpoints follow who may edit', async () => {
    const page = (who: string, id: string) => as(who, (q) => q(`INSERT INTO design_pages (project_id,org_id,page_id,data,seq,hash) VALUES ($1,$2,$3,'{}',1,$4) RETURNING 1`, [p1, orgA, id, HASH]));
    await denied(page(u.carol, 'reviewer'));
    await denied(page(u.erin, 'other-org'));
    expect(await page(u.bob, 'p2')).toHaveLength(1);
    expect(await as(u.carol, (q) => q(`UPDATE design_pages SET seq = 9 WHERE project_id = $1 RETURNING 1`, [p1]))).toHaveLength(0);
    expect(await as(u.carol, (q) => q(`SELECT 1 FROM design_pages WHERE project_id = $1`, [p1]))).not.toHaveLength(0);
  });

  it('designers review each other, but not a review they asked for', async () => {
    await as(u.bob, (q) => q(`INSERT INTO stage_events (project_id,org_id,cycle,kind,from_stage,to_stage,actor) VALUES ($1,$2,1,'review_requested','ia','ia',$3)`, [p1, orgA, u.bob]));
    await denied(as(u.bob, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'ia','approved',$3)`, [p1, orgA, u.bob])));
    // dave designs too, but only decides once he is named an approver
    await as(u.alice, (q) => q(`INSERT INTO project_members (project_id,org_id,user_id,role) VALUES ($1,$2,$3,'designer')`, [p1, orgA, u.dave]));
    await denied(as(u.dave, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'ia','approved',$3)`, [p1, orgA, u.dave])));
    await as(u.alice, (q) => q(`UPDATE project_members SET is_approver = true WHERE project_id = $1 AND user_id = $2`, [p1, u.dave]));
    const rows = await as(u.dave, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'ia','approved',$3) RETURNING 1`, [p1, orgA, u.dave]));
    expect(rows).toHaveLength(1);
  });

  it('the decision record cannot be rewritten', async () => {
    for (const t of ['stage_signoffs', 'stage_events', 'audit_log']) {
      await denied(as(u.alice, (q) => q(`UPDATE ${t} SET org_id = org_id`)));
      await denied(as(u.alice, (q) => q(`DELETE FROM ${t}`)));
    }
  });

  it('only the owner reads the audit log, and only managers manage people', async () => {
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM audit_log`))).toHaveLength(0);
    expect((await as(u.alice, (q) => q(`SELECT 1 FROM audit_log`))).length).toBeGreaterThan(0);
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM invites`))).toHaveLength(0);
    expect(await as(u.bob, (q) => q(`UPDATE org_members SET role='admin' WHERE user_id=$1 RETURNING 1`, [u.bob]))).toHaveLength(0);
    await denied(as(u.bob, (q) => q(`INSERT INTO project_members (project_id,org_id,user_id) VALUES ($1,$2,$3)`, [p1, orgA, u.dave])));
    await denied(as(u.bob, (q) => q(`SELECT create_project($1,'x','','{}'::json)`, [orgB])));
    await denied(as(u.erin, (q) => q(`SELECT create_project($1,'x','','{}'::json)`, [orgA])));
  });

  it('an org always keeps exactly one owner', async () => {
    // through the app role, the owner row is out of reach altogether
    expect(await as(u.alice, (q) => q(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2 RETURNING 1`, [orgA, u.alice]))).toHaveLength(0);
    expect(await as(u.alice, (q) => q(`DELETE FROM org_members WHERE org_id=$1 AND user_id=$2 RETURNING 1`, [orgA, u.alice]))).toHaveLength(0);
    await denied(as(u.alice, (q) => q(`UPDATE org_members SET role='owner' WHERE org_id=$1 AND user_id=$2 RETURNING 1`, [orgA, u.bob])));
    // and even the schema owner cannot leave an organization with none, or two
    await expect(db.tx((owner) => owner(`UPDATE org_members SET role='admin' WHERE org_id=$1 AND user_id=$2`, [orgA, u.alice]))).rejects.toThrow(/owner/);
    await expect(db.tx((owner) => owner(`DELETE FROM org_members WHERE org_id=$1 AND user_id=$2`, [orgA, u.alice]))).rejects.toThrow(/owner/);
    await expect(db.tx((owner) => owner(`UPDATE org_members SET role='owner' WHERE org_id=$1 AND user_id=$2`, [orgA, u.bob]))).rejects.toMatchObject({ code: '23505' });
  });

  it('invites only work for the address they were sent to', async () => {
    await as(u.alice, (q) => q(`INSERT INTO invites (org_id,email,role,token_hash,expires_at) VALUES ($1,'bob@x.io','member','h2',now()+interval '1 day')`, [orgA]));
    await expect(as(u.erin, (q) => q(`SELECT accept_invite('h2')`))).rejects.toThrow(/different email/);
    expect(await as(u.erin, (q) => q(`SELECT 1 FROM orgs WHERE id = $1`, [orgA]))).toHaveLength(0);
  });

  it('identity does not outlive its transaction', async () => {
    await as(u.alice, (q) => q(`SELECT 1 FROM projects`));
    const [row] = await db.tx((q) => q<{ v: string | null }>(`SELECT nullif(current_setting('app.user_id', true), '') AS v`));
    expect(row!.v).toBeNull();
    expect(await as(null, (q) => q(`SELECT 1 FROM projects`))).toHaveLength(0);
  });

  // ---------------------------------------------------------------- identity (migration 007)

  const IDENTITY_TABLES = ['email_verifications', 'auth_mfa_challenges', 'auth_throttle'];

  it('identity tables and secret columns are reachable only through their functions', async () => {
    for (const t of IDENTITY_TABLES) {
      await denied(as(u.alice, (q) => q(`SELECT * FROM ${t}`)));
      await denied(as(null, (q) => q(`SELECT * FROM ${t}`)));
      await denied(as(u.alice, (q) => q(`DELETE FROM ${t}`)));
    }
    await denied(as(u.alice, (q) => q(`INSERT INTO auth_throttle (bucket, key, hits, window_ends) VALUES ('login_email', $1, 1, now())`, ['0'.repeat(64)])));
    for (const col of ['email_verified_at', 'mfa_secret_enc', 'mfa_pending_enc', 'mfa_recovery', 'mfa_last_step', 'mfa_enabled_at']) {
      await denied(as(u.alice, (q) => q(`SELECT ${col} FROM users WHERE id = app_uid()`)));
      await denied(as(u.alice, (q) => q(`UPDATE users SET ${col} = NULL WHERE id = app_uid()`)));
    }
    const [rls] = await db.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname = ANY ($1) AND relrowsecurity`, [IDENTITY_TABLES]));
    expect(rls!.n).toBe(IDENTITY_TABLES.length);
    const [grants] = await db.tx((q) => q<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.role_table_grants WHERE grantee = 'rangoli_app' AND table_name = ANY ($1)`, [IDENTITY_TABLES]));
    expect(grants!.n).toBe(0);
  });

  it('nobody invites or decides a review before verifying their email', async () => {
    const [row] = await as(null, (q) => q<{ id: string }>(`SELECT auth_signup('gina@x.io','Gina','hash') AS id`));
    const gina = row!.id;
    await db.tx((owner) => owner(`INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'admin')`, [orgA, gina]));
    await expect(as(gina, (q) => q(`INSERT INTO invites (org_id,email,role,token_hash,expires_at) VALUES ($1,'y@x.io','member','h-gina',now()+interval '1 day')`, [orgA]))).rejects.toThrow(/verify your email/i);
    await expect(as(gina, (q) => q(`INSERT INTO stage_signoffs (project_id,org_id,cycle,stage,decision,reviewer) VALUES ($1,$2,1,'launch','approved',$3)`, [p1, orgA, gina]))).rejects.toThrow(/verify your email/i);
    await expect(as(gina, (q) => q(`SELECT token_create('t','h-g',$1::uuid[],'{read}',30)`, [[p1]]))).rejects.toThrow(/verify your email/i);
    expect((await as(gina, (q) => q<{ v: boolean }>(`SELECT app_email_verified() AS v`)))[0]!.v).toBe(false);
    // the link verifies the address it was sent to, once
    await as(gina, (q) => q(`SELECT * FROM auth_verify_create('vh-gina', now() + interval '1 hour')`));
    expect((await as(null, (q) => q<{ id: string | null }>(`SELECT auth_verify_consume('vh-gina') AS id`)))[0]!.id).toBe(gina);
    expect((await as(null, (q) => q<{ id: string | null }>(`SELECT auth_verify_consume('vh-gina') AS id`)))[0]!.id).toBeNull();
    expect((await as(gina, (q) => q<{ v: boolean }>(`SELECT app_email_verified() AS v`)))[0]!.v).toBe(true);
    expect(await as(gina, (q) => q(`INSERT INTO invites (org_id,email,role,token_hash,expires_at) VALUES ($1,'y@x.io','member','h-gina',now()+interval '1 day') RETURNING 1`, [orgA]))).toHaveLength(1);
    await db.tx((owner) => owner(`DELETE FROM org_members WHERE user_id = $1`, [gina]));
  });

  it('a token stays inside the projects it names, and only while it is live', async () => {
    const [p3row] = await as(u.alice, (q) => q<{ id: string }>(`SELECT create_project($1,'Three','',$2::json) AS id`, [orgA, doc]));
    const p3 = p3row!.id;
    const token = await mintToken(u.alice, [p1], ['read']);
    const asToken = <T,>(fn: (q: Q) => Promise<T>, id = token) => tokenActor.run(id, () => as(u.alice, fn));
    for (const t of PROJECT_TABLES) expect(await asToken((q) => q(`SELECT 1 FROM ${t} WHERE project_id = $1`, [p3])), t).toHaveLength(0);
    expect(await asToken((q) => q(`SELECT id FROM projects`))).toEqual([{ id: p1 }]);
    expect(await asToken((q) => q(`SELECT 1 FROM designs WHERE project_id = $1`, [p1]))).toHaveLength(1);
    await denied(asToken((q) => q(`INSERT INTO items (project_id,org_id,kind,cycle,created_by) VALUES ($1,$2,'research',1,$3)`, [p3, orgA, u.alice])));
    expect(await asToken((q) => q(`UPDATE designs SET data = data WHERE project_id = $1 RETURNING 1`, [p3]))).toHaveLength(0);
    expect((await asToken((q) => q<{ s: string[] | null }>(`SELECT token_scopes_on($1) AS s`, [p1])))[0]!.s).toEqual(['read']);
    expect((await asToken((q) => q<{ s: string[] | null }>(`SELECT token_scopes_on($1) AS s`, [p3])))[0]!.s).toBeNull();
    // agents never manage people, and a token never mints another token
    expect(await asToken((q) => q(`SELECT 1 FROM invites`))).toHaveLength(0);
    expect(await asToken((q) => q(`SELECT 1 FROM audit_log`))).toHaveLength(0);
    expect((await as(u.alice, (q) => q(`SELECT 1 FROM audit_log`))).length).toBeGreaterThan(0);
    await denied(asToken((q) => q(`SELECT token_create('t2','h-t2',$1::uuid[],'{read}',30)`, [[p1]])));
    // someone else's token id is no one's key
    expect(await tokenActor.run(token, () => as(u.carol, (q) => q(`SELECT 1 FROM designs WHERE project_id = $1`, [p1])))).toHaveLength(0);
    // expired, then revoked: nothing at all
    await db.tx((owner) => owner(`UPDATE api_tokens SET expires_at = now() - interval '1 second' WHERE id = $1`, [token]));
    expect(await asToken((q) => q(`SELECT 1 FROM projects`))).toHaveLength(0);
    const second = await mintToken(u.alice, [p1, p3], ['read', 'draft']);
    expect(await asToken((q) => q(`SELECT 1 FROM projects`), second)).toHaveLength(2);
    await as(u.alice, (q) => q(`SELECT token_delete($1)`, [second]));
    expect(await asToken((q) => q(`SELECT 1 FROM projects`), second)).toHaveLength(0);
    const [kept] = await db.tx((owner) => owner<{ revoked: boolean }>(`SELECT revoked_at IS NOT NULL AS revoked FROM api_tokens WHERE id = $1`, [second]));
    expect(kept!.revoked).toBe(true);
  });

  it('every table with a project_id keeps a token inside its projects', async () => {
    // tables made after 007 get the guard by calling token_scope_policy() in their own migration
    // (009's workstreams, screen_frames and strict_overrides get theirs in 008)
    const AWAITING: string[] = [];
    const rows = await db.tx((q) => q<{ t: string; guarded: boolean }>(`
      SELECT c.relname AS t, EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND NOT p.polpermissive AND p.polname = c.relname || '_token_scope') AS guarded
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind = 'r'`));
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) if (!AWAITING.includes(r.t)) expect(r.guarded, `${r.t} needs token_scope_policy('${r.t}')`).toBe(true);
  });

  it('a token is made only for projects you can open, in one organization, with known scopes', async () => {
    await expect(mintToken(u.dave, [p2], ['read'])).rejects.toMatchObject({ code: '42501' }); // another org
    await expect(mintToken(u.alice, [p1, p2], ['read'])).rejects.toBeTruthy(); // p2 is not alice's
    await expect(mintToken(u.alice, [p1], ['admin'])).rejects.toMatchObject({ code: '23514' });
    await expect(mintToken(u.alice, [], ['read'])).rejects.toThrow(/choose a project/i);
    await expect(as(u.alice, (q) => q(`SELECT token_create('t','h-d',$1::uuid[],'{read}',400)`, [[p1]]))).rejects.toThrow(/365/);
    // only a legacy token may lack a project list
    await expect(db.tx((owner) => owner(`INSERT INTO api_tokens (user_id,name,token_hash,scopes,expires_at) VALUES ($1,'x','h-x','{read}',now()+interval '1 day')`, [u.alice]))).rejects.toMatchObject({ code: '23514' });
    const [legacy] = await db.tx((owner) => owner<{ id: string }>(`INSERT INTO api_tokens (user_id,name,token_hash,scopes,expires_at,legacy) VALUES ($1,'old','h-old','{read}',now()+interval '1 day',true) RETURNING id`, [u.alice]));
    expect(await tokenActor.run(legacy!.id, () => as(u.alice, (q) => q(`SELECT 1 FROM projects WHERE id = $1`, [p1])))).toHaveLength(1);
    const listed = await as(u.alice, (q) => q<{ id: string; legacy: boolean }>(`SELECT id, legacy FROM my_tokens()`));
    expect(listed.find((t) => t.id === legacy!.id)?.legacy).toBe(true);
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM my_tokens() WHERE id = $1`, [legacy!.id]))).toHaveLength(0);
  });

  it('sessions end at the idle limit and the absolute limit, and rotation keeps the absolute limit', async () => {
    const make = (hash: string, expires = `now() + interval '14 days'`) => as(null, (q) => q(`SELECT auth_session_create($1, $2, ${expires}, false)`, [hash, u.alice]));
    const user = (hash: string) => as(null, (q) => q(`SELECT * FROM auth_session_user($1, 86400)`, [hash]));
    await make('s-idle');
    expect(await user('s-idle')).toHaveLength(1);
    await db.tx((owner) => owner(`UPDATE auth_sessions SET last_seen_at = now() - interval '25 hours' WHERE token_hash = 's-idle'`));
    expect(await user('s-idle')).toHaveLength(0);
    expect(await db.tx((owner) => owner(`SELECT 1 FROM auth_sessions WHERE token_hash = 's-idle'`))).toHaveLength(0);
    await make('s-old', `now() - interval '1 second'`);
    expect(await user('s-old')).toHaveLength(0);
    await make('s-a');
    const [before] = await db.tx((owner) => owner<{ e: Date }>(`SELECT expires_at AS e FROM auth_sessions WHERE token_hash = 's-a'`));
    await as(null, (q) => q(`SELECT auth_session_rotate('s-a', 's-b', false, true)`));
    expect(await user('s-a')).toHaveLength(0);
    const [after] = await user('s-b');
    expect(new Date(after.expires_at).getTime()).toBe(new Date(before!.e).getTime());
    expect(after.mfa_at).not.toBeNull();
  });

  it('MFA state is only ever the subject own, and only as ciphertext', async () => {
    await db.tx((owner) => owner(`UPDATE users SET mfa_secret_enc = 'v1.x', mfa_enabled_at = now(), mfa_recovery = '{r1,r2}' WHERE id = $1`, [u.carol]));
    const mine = await as(u.alice, (q) => q<{ user_id: string }>(`SELECT * FROM auth_mfa_secret(NULL)`));
    expect(mine.map((r) => r.user_id)).toEqual([u.alice]);
    expect(await as(u.alice, (q) => q(`SELECT * FROM auth_mfa_secret('not-a-challenge')`))).toHaveLength(0);
    // a recovery code is spent once, and only by its owner
    expect((await as(u.alice, (q) => q<{ n: number | null }>(`SELECT auth_mfa_use_recovery(NULL, 'r1') AS n`)))[0]!.n).toBeNull();
    expect((await as(u.carol, (q) => q<{ n: number | null }>(`SELECT auth_mfa_use_recovery(NULL, 'r1') AS n`)))[0]!.n).toBe(1);
    expect((await as(u.carol, (q) => q<{ n: number | null }>(`SELECT auth_mfa_use_recovery(NULL, 'r1') AS n`)))[0]!.n).toBeNull();
    // a time step is accepted once
    expect((await as(u.carol, (q) => q<{ ok: boolean }>(`SELECT auth_mfa_mark_step(NULL, 100) AS ok`)))[0]!.ok).toBe(true);
    expect((await as(u.carol, (q) => q<{ ok: boolean }>(`SELECT auth_mfa_mark_step(NULL, 100) AS ok`)))[0]!.ok).toBe(false);
    // a challenge names its person until it is used
    await as(null, (q) => q(`SELECT auth_mfa_challenge_create('c-1', $1, now() + interval '5 minutes')`, [u.carol]));
    expect((await as(null, (q) => q<{ user_id: string }>(`SELECT user_id FROM auth_mfa_secret('c-1')`)))[0]!.user_id).toBe(u.carol);
    expect((await as(null, (q) => q<{ id: string | null }>(`SELECT auth_mfa_challenge_end('c-1') AS id`)))[0]!.id).toBe(u.carol);
    expect(await as(null, (q) => q(`SELECT * FROM auth_mfa_secret('c-1')`))).toHaveLength(0);
    // a token session cannot change how its person signs in
    await denied(tokenActor.run('00000000-0000-4000-8000-000000000003', () => as(u.carol, (q) => q(`SELECT auth_mfa_disable()`))));
  });

  it('the throttle counts atomically per bucket and key, and keeps no plain values', async () => {
    const key = 'f'.repeat(64);
    const hit = () => as(null, (q) => q<{ n: number }>(`SELECT auth_throttle_hit('login_email', $1, 60) AS n`, [key]));
    expect((await hit())[0]!.n).toBe(1);
    expect((await Promise.all([hit(), hit(), hit()])).map((r) => r[0]!.n).sort()).toEqual([2, 3, 4]);
    expect((await as(null, (q) => q<{ n: number }>(`SELECT auth_throttle_count('login_email', $1) AS n`, [key])))[0]!.n).toBe(4);
    expect((await as(null, (q) => q<{ n: number }>(`SELECT auth_throttle_count('login_ip', $1) AS n`, [key])))[0]!.n).toBe(0);
    await expect(as(null, (q) => q(`SELECT auth_throttle_hit('login_email', 'someone@x.io', 60)`))).rejects.toMatchObject({ code: '23514' });
    await as(null, (q) => q(`SELECT auth_throttle_clear('login_email', $1)`, [key]));
    expect((await as(null, (q) => q<{ n: number }>(`SELECT auth_throttle_count('login_email', $1) AS n`, [key])))[0]!.n).toBe(0);
  });

  it('leaving the org removes project access immediately', async () => {
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM designs WHERE project_id=$1`, [p1]))).toHaveLength(1);
    await as(u.alice, (q) => q(`DELETE FROM org_members WHERE org_id=$1 AND user_id=$2`, [orgA, u.bob]));
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM designs WHERE project_id=$1`, [p1]))).toHaveLength(0);
    expect(await as(u.alice, (q) => q(`SELECT 1 FROM project_members WHERE user_id=$1`, [u.bob]))).toHaveLength(0);
  });
});
