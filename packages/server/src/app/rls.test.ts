import { createDocument } from '@rangoli/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, tokenActor, withUser, type Database, type Q } from './db.js';

/**
 * Attacks the database directly as each role, with no application code in front of it.
 * If a policy regresses, this fails even when the HTTP layer would have hidden the problem.
 */
/** migration-010: snapshots, approvals, releases, fixes and share links */
const APPROVAL_TABLES = ['snapshots', 'snapshot_screens', 'snapshot_assets', 'approvals', 'approval_decisions', 'releases', 'fixes', 'share_links'];
const TENANT_TABLES = ['org_members', 'invites', 'projects', 'project_members', 'designs', 'design_reviews', 'design_versions', 'design_assets', 'items', 'stage_events', 'stage_signoffs', 'audit_log', 'design_ops', 'design_pages', 'design_checkpoints', ...APPROVAL_TABLES, 'agent_tasks', 'agent_jobs', 'agent_runs', 'frame_owners', 'page_agent_policies'];
const PROJECT_TABLES = ['project_members', 'designs', 'design_reviews', 'design_versions', 'design_assets', 'items', 'stage_events', 'stage_signoffs', 'design_ops', 'design_pages', 'design_checkpoints', ...APPROVAL_TABLES, 'agent_tasks', 'agent_jobs', 'agent_runs', 'frame_owners', 'page_agent_policies'];

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
    // an agent's change belongs to a named run it has open (migration 011)
    await denied(tokenActor.run(token, () => as(u.bob, (q) => addOp(q, 3, u.bob, token))));
    const run = await tokenActor.run(token, () => as(u.bob, async (q) => (await q<{ id: string }>(`SELECT agent_run_start($1, 'Claude Code', 'log test', 0, NULL, NULL) AS id`, [p1]))[0]!.id));
    const withRun = (seq: number, touched: string[] = ['n1']) =>
      tokenActor.run(token, () => as(u.bob, (q) => q(`INSERT INTO design_ops (project_id,org_id,seq,page_id,actor_kind,actor_id,token_id,author,ops,inverse,touched,run_id) VALUES ($1,$2,$3,'p1','agent',$4,$5,'t','[]','[]',$6,$7) RETURNING 1`, [p1, orgA, seq, u.bob, token, touched, run])));
    expect(await withRun(3)).toHaveLength(1);
    await tokenActor.run(token, () => as(u.bob, (q) => q(`SELECT agent_run_end($1, 'done', 3, NULL)`, [run])));
    await denied(withRun(4)); // the run has ended
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

  it('approvals bind to an immutable snapshot: own reviews, tokens and stale MFA are refused; names and used assets outlive', async () => {
    const fay = (await as(null, (q) => q<{ id: string }>(`SELECT auth_signup('fay@x.io', 'fay', 'hash') AS id`)))[0]!.id;
    await db.tx(async (owner) => {
      await owner(`UPDATE users SET email_verified_at = now() WHERE id = $1`, [fay]);
      await owner(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [orgA, fay]);
    });
    await as(u.alice, (q) => q(`INSERT INTO project_members (project_id, org_id, user_id, role, is_approver) VALUES ($1, $2, $3, 'reviewer', true)`, [p1, orgA, fay]));
    const KEY = 'a'.repeat(16);
    const SNAP = `INSERT INTO snapshots (project_id, org_id, cycle, stage, kind, name, data, content_hash, library_hash, canon_version, engine_version, signature, signing_key, created_by)
                  VALUES ($1, $2, 1, 'visual', $3, 'S', '{}', $4, $4, 'rangoli-canon@1', 'e', $4, $5, app_uid()) RETURNING id`;
    const SCREEN = `INSERT INTO snapshot_screens (snapshot_id, project_id, org_id, screen_key, page_id, screen_hash, root_hash, deps) VALUES ($1, $2, $3, $4, 'p1', $5, $5, '{}')`;
    const [snap] = await as(u.bob, async (q) => {
      const rows = await q<{ id: string }>(SNAP, [p1, orgA, 'review', HASH, KEY]);
      await q(SCREEN, [rows[0]!.id, p1, orgA, 'f1', HASH]);
      await q(`INSERT INTO snapshot_assets (snapshot_id, project_id, org_id, file, sha256, mime) VALUES ($1, $2, $3, 'a.png', $4, 'image/png')`, [rows[0]!.id, p1, orgA, HASH]);
      return rows;
    });
    const s = snap!.id;
    // complete when it commits: nothing joins it later, nothing in it changes, nobody deletes it
    await denied(as(u.bob, (q) => q(SCREEN, [s, p1, orgA, 'f2', HASH])));
    await denied(as(u.bob, (q) => q(`UPDATE snapshots SET name = 'x' WHERE id = $1`, [s])));
    await denied(as(u.alice, (q) => q(`DELETE FROM snapshots WHERE id = $1`, [s])));
    await expect(db.tx((owner) => owner(`UPDATE snapshots SET name = 'x' WHERE id = $1`, [s]))).rejects.toThrow(/cannot be changed/);
    await expect(db.tx((owner) => owner(`UPDATE snapshot_screens SET screen_hash = $2 WHERE snapshot_id = $1`, [s, 'b'.repeat(64)]))).rejects.toThrow(/cannot be changed/);
    // a reviewer cannot take one; a release snapshot needs the release capability
    await denied(as(u.carol, (q) => q(SNAP, [p1, orgA, 'review', HASH, KEY])));
    expect(await as(u.alice, (q) => q(SNAP, [p1, orgA, 'release', HASH, KEY]))).toHaveLength(1);
    // the image it uses cannot be deleted, by anyone
    await expect(as(u.alice, (q) => q(`DELETE FROM design_assets WHERE project_id = $1 AND file = 'a.png'`, [p1]))).rejects.toThrow(/saved snapshot/);
    await expect(db.tx((owner) => owner(`DELETE FROM design_assets WHERE project_id = $1 AND file = 'a.png'`, [p1]))).rejects.toThrow(/saved snapshot/);

    const ASK = `INSERT INTO approvals (project_id, org_id, snapshot_id, cycle, stage, requested_by) VALUES ($1, $2, $3, 1, 'visual', app_uid()) RETURNING id`;
    const [byBob] = await as(u.bob, (q) => q<{ id: string }>(ASK, [p1, orgA, s]));
    const [byAlice] = await as(u.alice, (q) => q<{ id: string }>(ASK, [p1, orgA, s]));
    await denied(as(u.carol, (q) => q(ASK, [p1, orgA, s]))); // reviewers do not ask for reviews
    /** a session with the second factor proved `ago` ago; returns that time */
    const proved = async (who: string, ago = '0 seconds') => {
      const h = `mfa-${Math.random()}`;
      await as(null, (q) => q(`SELECT auth_session_create($1, $2, now() + interval '1 day', true)`, [h, who]));
      return (await db.tx((owner) => owner<{ at: Date }>(`UPDATE auth_sessions SET mfa_at = now() - $2::interval WHERE token_hash = $1 RETURNING mfa_at AS at`, [h, ago])))[0]!.at;
    };
    const DECIDE = `INSERT INTO approval_decisions (approval_id, project_id, org_id, snapshot_id, content_hash, approver_id, decision, mfa_at) VALUES ($1, $2, $3, $4, 'forged', app_uid(), 'approved', $5) RETURNING approver_name, content_hash, snapshot_id`;
    const decide = (who: string, approval: string, mfaAt: Date | null) => as(who, (q) => q<{ approver_name: string; content_hash: string; snapshot_id: string }>(DECIDE, [approval, p1, orgA, s, mfaAt]));
    // nobody decides their own review: the designer, or the lead who owns the organization
    await denied(decide(u.bob, byBob!.id, await proved(u.bob)));
    await denied(decide(u.alice, byAlice!.id, await proved(u.alice)));
    // from another organization
    await denied(decide(u.erin, byBob!.id, await proved(u.erin)));
    // a second factor, proved within five minutes on one of this person's own sessions
    await expect(decide(fay, byBob!.id, null)).rejects.toThrow(/Confirm it is you/);
    await expect(decide(fay, byBob!.id, await proved(fay, '10 minutes'))).rejects.toThrow(/Confirm it is you/);
    await expect(decide(fay, byBob!.id, await proved(u.carol))).rejects.toThrow(/Confirm it is you/);
    // never through an API token, whatever its scopes
    const t = await mintToken(fay, [p1], ['read', 'propose', 'draft', 'items', 'export', 'jobs']);
    const fresh = await proved(fay);
    await denied(tokenActor.run(t, () => decide(fay, byBob!.id, fresh)));
    const [d] = await decide(fay, byBob!.id, await proved(fay));
    // bound to the approval's snapshot and its hash, whatever the statement said
    expect(d).toMatchObject({ approver_name: 'fay', content_hash: HASH, snapshot_id: s });
    expect((await as(u.carol, (q) => q<{ s: string }>(`SELECT approval_status($1) AS s`, [byBob!.id])))[0]!.s).toBe('approved');
    await expect(db.tx((owner) => owner(`UPDATE approval_decisions SET note = 'edited' WHERE approval_id = $1`, [byBob!.id]))).rejects.toThrow(/cannot be changed/);
    // named approvers only, and only while the review is open
    const [named] = await as(u.bob, (q) => q<{ id: string }>(`INSERT INTO approvals (project_id, org_id, snapshot_id, cycle, stage, approvers, requested_by) VALUES ($1, $2, $3, 1, 'visual', $4::uuid[], app_uid()) RETURNING id`, [p1, orgA, s, [u.carol]]));
    await expect(decide(fay, named!.id, await proved(fay))).rejects.toThrow(/not one of them/);
    await expect(as(u.bob, (q) => q(`INSERT INTO approvals (project_id, org_id, snapshot_id, cycle, stage, approvers, requested_by) VALUES ($1, $2, $3, 1, 'visual', $4::uuid[], app_uid())`, [p1, orgA, s, [u.bob]]))).rejects.toMatchObject({ code: '23514' });
    expect(await as(u.bob, (q) => q(`UPDATE approvals SET withdrawn_at = now(), withdrawn_by = app_uid() WHERE id = $1 RETURNING 1`, [named!.id]))).toHaveLength(1);
    await expect(decide(u.carol, named!.id, await proved(u.carol))).rejects.toThrow(/withdrawn/);

    // a release names an approved snapshot; an open review is not one, and agents never release
    const RELEASE = `INSERT INTO releases (project_id, org_id, cycle, snapshot_id, basis, approval_id, released_by) VALUES ($1, $2, 1, $3, 'approval', $4, app_uid()) RETURNING released_by_name`;
    await expect(as(u.alice, (q) => q(RELEASE, [p1, orgA, s, byAlice!.id]))).rejects.toThrow(/not approved/);
    await denied(as(u.carol, (q) => q(RELEASE, [p1, orgA, s, byBob!.id])));
    const at = await mintToken(u.alice, [p1], ['read', 'draft', 'export']);
    await denied(tokenActor.run(at, () => as(u.alice, (q) => q(RELEASE, [p1, orgA, s, byBob!.id]))));
    expect((await as(u.alice, (q) => q<{ released_by_name: string }>(RELEASE, [p1, orgA, s, byBob!.id])))[0]!.released_by_name).toBe('alice');

    // share links: the token hash is never read back, and only people who may share make them
    const LINK = `INSERT INTO share_links (project_id, org_id, snapshot_id, kind, token_hash, created_by) VALUES ($1, $2, $3, $4, $5, app_uid()) RETURNING id`;
    await denied(as(u.carol, (q) => q(LINK, [p1, orgA, s, 'stakeholder', 'c'.repeat(64)])));
    await expect(as(u.bob, (q) => q(`INSERT INTO share_links (project_id, org_id, snapshot_id, kind, token_hash, created_by, expires_at) VALUES ($1, $2, $3, 'stakeholder', $4, app_uid(), now() + interval '400 days')`, [p1, orgA, s, 'd'.repeat(64)]))).rejects.toMatchObject({ code: '23514' });
    const [link] = await as(u.bob, (q) => q<{ id: string }>(LINK, [p1, orgA, s, 'stakeholder', 'e'.repeat(64)]));
    await denied(as(u.bob, (q) => q(`SELECT token_hash FROM share_links WHERE id = $1`, [link!.id])));
    expect(await as(null, (q) => q(`SELECT snapshot_id FROM share_link_open($1)`, ['e'.repeat(64)]))).toHaveLength(1);
    expect(await as(null, (q) => q(`SELECT file FROM share_link_assets($1)`, ['e'.repeat(64)]))).toHaveLength(1);
    await as(u.bob, (q) => q(`UPDATE share_links SET revoked_at = now(), revoked_by = app_uid() WHERE id = $1`, [link!.id]));
    expect(await as(null, (q) => q(`SELECT 1 FROM share_link_open($1)`, ['e'.repeat(64)]))).toHaveLength(0);
    expect(await as(null, (q) => q(`SELECT 1 FROM share_link_assets($1)`, ['e'.repeat(64)]))).toHaveLength(0);
    // another organization sees none of it
    for (const tbl of APPROVAL_TABLES) expect(await as(u.erin, (q) => q(`SELECT 1 FROM ${tbl} WHERE project_id = $1`, [p1])), tbl).toHaveLength(0);

    // the decision keeps the approver's name after the account is gone
    await db.tx((owner) => owner(`DELETE FROM users WHERE id = $1`, [fay]));
    const [kept] = await as(u.carol, (q) => q<{ approver_id: string | null; approver_name: string }>(`SELECT approver_id, approver_name FROM approval_decisions WHERE approval_id = $1`, [byBob!.id]));
    expect(kept).toEqual({ approver_id: null, approver_name: 'fay' });
    expect((await as(u.carol, (q) => q<{ s: string }>(`SELECT approval_status($1) AS s`, [byBob!.id])))[0]!.s).toBe('approved');
  });

  // ---------------------------------------------------------------- the agent platform (migration 011)

  const refused = async (p: Promise<unknown>, code = 'P0001') => {
    await expect(p).rejects.toMatchObject({ code });
  };
  const leaveTask = (who: string, body: string, kind = 'task', node: string | null = null) =>
    as(who, async (q) => (await q<{ id: string }>(`INSERT INTO agent_tasks (project_id,org_id,kind,target_node,author,author_name,body) VALUES ($1,$2,$3,$4,app_uid(),'x',$5) RETURNING id`, [p1, orgA, kind, node, body]))[0]!.id);
  const viaToken = <T>(token: string, who: string, fn: (q: Q) => Promise<T>) => tokenActor.run(token, () => as(who, fn));
  const claim = (token: string, who = u.bob, agent = 'Claude Code') =>
    viaToken(token, who, async (q) => (await q<{ job_id: string; lease_token: string; task_id: string }>(`SELECT job_id, lease_token, task_id FROM agent_job_claim($1, $2, 300)`, [p1, agent]))[0] ?? null);
  const taskStatus = async (id: string) => (await db.tx((q) => q<{ status: string; failure_reason: string | null }>(`SELECT status, failure_reason FROM agent_tasks WHERE id = $1`, [id])))[0]!;
  const drainQueue = () => db.tx((q) => q(`UPDATE agent_jobs SET status = 'done', lease_token = NULL, lease_until = NULL WHERE project_id = $1 AND status IN ('waiting', 'leased')`, [p1]));

  it('notes and tasks are requests only from people with task.create; agents never write the queue directly', async () => {
    await drainQueue();
    await denied(leaveTask(u.carol, 'reviewers comment, they do not request'));
    const bobToken = await mintToken(u.bob, [p1], ['read', 'draft', 'jobs']);
    await denied(tokenActor.run(bobToken, () => leaveTask(u.bob, 'an agent asking itself')));
    await expect(leaveTask(u.bob, 'a note must be pinned', 'note')).rejects.toMatchObject({ code: '23514' });
    await denied(leaveTask(u.erin, 'other org'));
    const id = await leaveTask(u.bob, 'make the card quieter');
    const [job] = await as(u.carol, (q) => q<{ status: string }>(`SELECT status FROM agent_jobs WHERE task_id = $1`, [id]));
    expect(job!.status).toBe('waiting');
    expect(await as(u.erin, (q) => q(`SELECT 1 FROM agent_tasks WHERE project_id = $1`, [p1]))).toHaveLength(0);
    // the queue's state changes only through its functions
    await denied(as(u.bob, (q) => q(`UPDATE agent_jobs SET status = 'done' WHERE task_id = $1`, [id])));
    await denied(as(u.bob, (q) => q(`UPDATE agent_tasks SET status = 'done_ready_to_review' WHERE id = $1`, [id])));
    await denied(viaToken(bobToken, u.bob, (q) => q(`UPDATE agent_tasks SET status = 'picked_up' WHERE id = $1`, [id])));
    await denied(as(u.bob, (q) => q(`INSERT INTO agent_runs (project_id,org_id,no,agent_name,intent,start_seq) VALUES ($1,$2,99,'x','y',0)`, [p1, orgA])));
  });

  it('a lease is claimed once with SKIP LOCKED, fenced by its token, and reaped when it runs out', async () => {
    await drainQueue();
    const t1 = await mintToken(u.bob, [p1], ['read', 'draft', 'jobs']);
    const t2 = await mintToken(u.bob, [p1], ['read', 'draft', 'jobs']);
    const readOnly = await mintToken(u.bob, [p1], ['read']);
    const carolToken = await mintToken(u.carol, [p1], ['read', 'propose', 'jobs']);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await leaveTask(u.bob, `task ${i}`));
    await denied(claim(readOnly));
    await denied(as(u.bob, (q) => q(`SELECT * FROM agent_job_claim($1, 'me', 300)`, [p1]))); // a person is not an agent
    const got = await Promise.all([claim(t1), claim(t2), claim(t1), claim(t2), claim(t1), claim(carolToken, u.carol)]);
    const leases = got.filter((x): x is NonNullable<typeof x> => !!x);
    expect(leases).toHaveLength(4);
    expect(new Set(leases.map((l) => l.job_id)).size).toBe(4);
    expect(await Promise.all(leases.map((l) => taskStatus(l.task_id).then((s) => s.status)))).toEqual(['picked_up', 'picked_up', 'picked_up', 'picked_up']);
    // which token holds which lease, as the database recorded it
    const holderOf = async (job: string) => {
      const [r] = await db.tx((q) => q<{ token_id: string }>(`SELECT token_id FROM agent_jobs WHERE id = $1`, [job]));
      const token = r!.token_id;
      return { token, who: token === carolToken ? u.carol : u.bob, other: token === t1 ? t2 : t1 };
    };
    const [mine, idle, busy] = leases;
    const { token: holder, other } = await holderOf(mine!.job_id);
    // finishing as done needs a run; another token cannot use this lease; a wrong lease is fenced out
    await refused(viaToken(holder, u.bob, (q) => q(`SELECT agent_job_finish($1, $2, 'done', NULL, NULL)`, [mine!.job_id, mine!.lease_token])));
    await refused(viaToken(other, u.bob, (q) => q(`SELECT agent_run_start($1, 'x', 'y', 0, $2, $3)`, [p1, mine!.job_id, mine!.lease_token])));
    await refused(viaToken(holder, u.bob, (q) => q(`SELECT agent_job_heartbeat($1, $2, 300)`, [mine!.job_id, '00000000-0000-4000-8000-000000000001'])));
    const [run] = await viaToken(holder, u.bob, (q) => q<{ id: string }>(`SELECT agent_run_start($1, 'Claude Code', 'quieter card', 5, $2, $3) AS id`, [p1, mine!.job_id, mine!.lease_token]));
    expect((await taskStatus(mine!.task_id)).status).toBe('run_in_progress');
    await viaToken(holder, u.bob, (q) => q(`SELECT agent_job_finish($1, $2, 'done', NULL, 'n1')`, [mine!.job_id, mine!.lease_token]));
    expect((await taskStatus(mine!.task_id)).status).toBe('done_ready_to_review');
    expect((await db.tx((q) => q<{ status: string }>(`SELECT status FROM agent_runs WHERE id = $1`, [run!.id])))[0]!.status).toBe('done');
    // a finished job cannot be finished again
    await refused(viaToken(holder, u.bob, (q) => q(`SELECT agent_job_finish($1, $2, 'failed', 'again', NULL)`, [mine!.job_id, mine!.lease_token])));

    // two leases run out: one before any run (back to waiting), one during a run (could not complete)
    const { token: busyToken, who: busyWho } = await holderOf(busy!.job_id);
    await viaToken(busyToken, busyWho, (q) => q(`SELECT agent_run_start($1, 'Cursor', 'busy', 5, $2, $3)`, [p1, busy!.job_id, busy!.lease_token]));
    await db.tx((q) => q(`UPDATE agent_jobs SET lease_until = now() - interval '1 minute' WHERE id = ANY ($1::uuid[])`, [[idle!.job_id, busy!.job_id]]));
    const [reaped] = await as(null, (q) => q<{ n: number }>(`SELECT agent_jobs_reap(NULL) AS n`));
    expect(reaped!.n).toBeGreaterThanOrEqual(2);
    expect((await taskStatus(idle!.task_id)).status).toBe('waiting_for_agent');
    const failed = await taskStatus(busy!.task_id);
    expect(failed.status).toBe('could_not_complete');
    expect(failed.failure_reason).toMatch(/lease ran out during the run/);
    // the late writer is fenced out
    await refused(viaToken(busyToken, busyWho, (q) => q(`SELECT agent_job_heartbeat($1, $2, 300)`, [busy!.job_id, busy!.lease_token])));
    // requeue is a person's, with task.create
    await denied(as(u.carol, (q) => q(`SELECT agent_task_requeue($1)`, [busy!.task_id])));
    await denied(viaToken(t1, u.bob, (q) => q(`SELECT agent_task_requeue($1)`, [busy!.task_id])));
    await as(u.bob, (q) => q(`SELECT agent_task_requeue($1)`, [busy!.task_id]));
    expect((await taskStatus(busy!.task_id)).status).toBe('waiting_for_agent');
    // withdrawing works only before pickup
    await as(u.bob, (q) => q(`SELECT agent_task_withdraw($1)`, [busy!.task_id]));
    expect(await db.tx((q) => q(`SELECT 1 FROM agent_jobs WHERE task_id = $1`, [busy!.task_id]))).toHaveLength(0);
    await refused(as(u.bob, (q) => q(`SELECT agent_task_withdraw($1)`, [mine!.task_id])));
    await db.tx((q) => q(`UPDATE agent_runs SET status = 'done' WHERE project_id = $1 AND status = 'running'`, [p1]));
  });

  it('runs: one open per token, ended only by their agent, undone only by a person who can edit', async () => {
    const t = await mintToken(u.bob, [p1], ['read', 'draft']);
    const other = await mintToken(u.bob, [p1], ['read', 'draft']);
    const carolToken = await mintToken(u.carol, [p1], ['read', 'propose']);
    const [run] = await viaToken(t, u.bob, (q) => q<{ id: string }>(`SELECT agent_run_start($1, 'Claude Code', 'tidy', 0, NULL, NULL) AS id`, [p1]));
    await refused(viaToken(t, u.bob, (q) => q(`SELECT agent_run_start($1, 'Claude Code', 'again', 0, NULL, NULL)`, [p1])));
    await denied(as(u.bob, (q) => q(`SELECT agent_run_start($1, 'me', 'a person', 0, NULL, NULL)`, [p1])));
    await denied(viaToken(await mintToken(u.erin, [p2], ['read']), u.erin, (q) => q(`SELECT agent_run_start($1, 'x', 'y', 0, NULL, NULL)`, [p1])));
    // a run on a reviewer's token exists, but the database still refuses its design writes
    const [rr] = await viaToken(carolToken, u.carol, (q) => q<{ id: string }>(`SELECT agent_run_start($1, 'x', 'review', 0, NULL, NULL) AS id`, [p1]));
    await denied(viaToken(carolToken, u.carol, (q) => q(`INSERT INTO design_ops (project_id,org_id,seq,page_id,actor_kind,actor_id,token_id,author,ops,inverse,run_id) VALUES ($1,$2,700,'p1','agent',$3,$4,'t','[]','[]',$5)`, [p1, orgA, u.carol, carolToken, rr!.id])));
    // no token or component writes from an agent, even inside its run
    await denied(viaToken(t, u.bob, (q) => q(`INSERT INTO design_ops (project_id,org_id,seq,page_id,actor_kind,actor_id,token_id,author,ops,inverse,touched,run_id) VALUES ($1,$2,701,'','agent',$3,$4,'t','[]','[]',ARRAY['$tokens'],$5)`, [p1, orgA, u.bob, t, run!.id])));
    await denied(viaToken(t, u.bob, (q) => q(`INSERT INTO design_ops (project_id,org_id,seq,page_id,actor_kind,actor_id,token_id,author,ops,inverse,touched,run_id) VALUES ($1,$2,702,'','agent',$3,$4,'t','[]','[]',ARRAY['$component:Button'],$5)`, [p1, orgA, u.bob, t, run!.id])));
    // another token cannot write in this run
    await denied(viaToken(other, u.bob, (q) => q(`INSERT INTO design_ops (project_id,org_id,seq,page_id,actor_kind,actor_id,token_id,author,ops,inverse,run_id) VALUES ($1,$2,703,'p1','agent',$3,$4,'t','[]','[]',$5)`, [p1, orgA, u.bob, other, run!.id])));
    // undo is a person's, after the run ends
    await refused(as(u.bob, (q) => q(`SELECT agent_run_mark_undone($1, '{}')`, [run!.id])));
    await refused(viaToken(other, u.bob, (q) => q(`SELECT agent_run_end($1, 'done', 1, NULL)`, [run!.id])));
    await viaToken(t, u.bob, (q) => q(`SELECT agent_run_end($1, 'done', 1, 'tidied')`, [run!.id]));
    await denied(viaToken(t, u.bob, (q) => q(`SELECT agent_run_mark_undone($1, '{}')`, [run!.id])));
    await denied(as(u.carol, (q) => q(`SELECT agent_run_mark_undone($1, '{}')`, [run!.id])));
    await as(u.bob, (q) => q(`SELECT agent_run_mark_undone($1, '{"reverted":3,"stayed":1}')`, [run!.id]));
    await refused(as(u.bob, (q) => q(`SELECT agent_run_mark_undone($1, '{}')`, [run!.id])));
    const [row] = await as(u.carol, (q) => q<{ status: string; undone_by: string; no: number }>(`SELECT status, undone_by, no FROM agent_runs WHERE id = $1`, [run!.id]));
    expect(row).toMatchObject({ status: 'undone', undone_by: u.bob });
    await viaToken(carolToken, u.carol, (q) => q(`SELECT agent_run_end($1, 'failed', 0, NULL)`, [rr!.id]));
  });

  it('connection status is the project’s to see, never a token’s; page modes are a person’s to set', async () => {
    const t = await mintToken(u.bob, [p1], ['read']);
    const rows = await as(u.carol, (q) => q<{ owner_id: string; mine: boolean; token_name: string }>(`SELECT owner_id, mine, token_name FROM project_agent_connections($1)`, [p1]));
    expect(rows.some((r) => r.owner_id === u.bob && !r.mine)).toBe(true);
    expect(Object.keys(rows[0]!)).not.toContain('token_hash');
    expect(await viaToken(t, u.bob, (q) => q(`SELECT * FROM project_agent_connections($1)`, [p1]))).toHaveLength(0);
    expect(await as(u.erin, (q) => q(`SELECT * FROM project_agent_connections($1)`, [p1]))).toHaveLength(0);
    const draftToken = await mintToken(u.bob, [p1], ['read', 'draft']);
    await denied(viaToken(draftToken, u.bob, (q) => q(`INSERT INTO page_agent_policies (project_id,org_id,page_id,mode,set_by) VALUES ($1,$2,'p1','draft',app_uid())`, [p1, orgA])));
    await denied(as(u.carol, (q) => q(`INSERT INTO page_agent_policies (project_id,org_id,page_id,mode,set_by) VALUES ($1,$2,'p1','draft',app_uid())`, [p1, orgA])));
    expect(await as(u.bob, (q) => q(`INSERT INTO page_agent_policies (project_id,org_id,page_id,mode,imported_by,set_by) VALUES ($1,$2,'p1','protected',app_uid(),app_uid()) RETURNING 1`, [p1, orgA]))).toHaveLength(1);
    // frame owners are recorded as whoever made the frame, never as someone else
    await denied(as(u.bob, (q) => q(`INSERT INTO frame_owners (project_id,org_id,frame_id,owner_id) VALUES ($1,$2,'f1',$3)`, [p1, orgA, u.alice])));
    await denied(as(u.carol, (q) => q(`INSERT INTO frame_owners (project_id,org_id,frame_id,owner_id) VALUES ($1,$2,'f1',app_uid())`, [p1, orgA])));
    expect(await as(u.bob, (q) => q(`INSERT INTO frame_owners (project_id,org_id,frame_id,owner_id) VALUES ($1,$2,'f1',app_uid()) RETURNING 1`, [p1, orgA]))).toHaveLength(1);
    expect((await as(u.bob, (q) => q<{ solo: boolean }>(`SELECT project_is_solo($1) AS solo`, [p1])))[0]!.solo).toBe(false);
  });

  it('an agent’s claim about people is held until a person accepts it', async () => {
    const t = await mintToken(u.alice, [p1], ['read', 'draft', 'items']);
    await denied(viaToken(t, u.alice, (q) => q(`INSERT INTO items (project_id,org_id,kind,cycle,title,created_by) VALUES ($1,$2,'persona',1,'Pat',$3)`, [p1, orgA, u.alice])));
    const [held] = await viaToken(t, u.alice, (q) => q<{ id: string }>(`INSERT INTO items (project_id,org_id,kind,cycle,title,created_by,status) VALUES ($1,$2,'persona',1,'Pat',$3,'held') RETURNING id`, [p1, orgA, u.alice]));
    await denied(viaToken(t, u.alice, (q) => q(`UPDATE items SET status = 'open' WHERE id = $1`, [held!.id])));
    expect(await as(u.alice, (q) => q(`UPDATE items SET status = 'open' WHERE id = $1 RETURNING 1`, [held!.id]))).toHaveLength(1);
    // anything that is not about people is not held
    expect(await viaToken(t, u.alice, (q) => q(`INSERT INTO items (project_id,org_id,kind,cycle,title,created_by) VALUES ($1,$2,'story',1,'s',$3) RETURNING 1`, [p1, orgA, u.alice]))).toHaveLength(1);
  });

  it('leaving the org removes project access immediately', async () => {
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM designs WHERE project_id=$1`, [p1]))).toHaveLength(1);
    await as(u.alice, (q) => q(`DELETE FROM org_members WHERE org_id=$1 AND user_id=$2`, [orgA, u.bob]));
    expect(await as(u.bob, (q) => q(`SELECT 1 FROM designs WHERE project_id=$1`, [p1]))).toHaveLength(0);
    expect(await as(u.alice, (q) => q(`SELECT 1 FROM project_members WHERE user_id=$1`, [u.bob]))).toHaveLength(0);
  });
});
