/**
 * Migration 009 against the database directly: the backfill from the single-frame, one-cycle data, the triggers
 * that keep Main and screen frames in step, and who may record a strict-mode override.
 */
import { createDocument } from '@rangoli/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, openDatabase, tokenActor, withUser, type Database, type Q } from '../db.js';
import { MIGRATIONS } from '../schema.js';

const denied = async (p: Promise<unknown>) => {
  await expect(p).rejects.toMatchObject({ code: expect.stringMatching(/42501/) });
};

describe('migration 009: backfill from existing projects', () => {
  let db: Database;
  afterAll(() => db?.close());

  it('gives every project and cycle a Main, puts rows in it, and turns each screen frame into a linked device frame', async () => {
    // a PGlite database at the schema before 009, holding a project in its second cycle
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite();
    await pg.waitReady;
    db = {
      driver: 'pglite',
      tx: (fn) => pg.transaction(async (t) => fn(async <R>(sql: string, params?: unknown[]) => (await t.query<R>(sql, params as unknown[])).rows)) as Promise<never>,
      exec: async (sql) => void (await pg.exec(sql)),
      session: (fn) => fn({ query: async <R>(sql: string, params?: unknown[]) => (await pg.query<R>(sql, params as unknown[])).rows, exec: async (sql) => void (await pg.exec(sql)) }),
      singleton: async () => undefined,
      close: () => pg.close(),
    };
    const before = MIGRATIONS.slice(0, MIGRATIONS.findIndex((m) => m.id === '009_workstreams_frames'));
    await migrate(db, { migrations: before });
    const doc = createDocument('Old');
    const page = doc.data.manifest.pages[0]!.id;
    doc.data.pages[page]!.nodes.f1 = { id: 'f1', type: 'frame', name: 'Cart', size: { w: { kind: 'fixed', v: 390 }, h: { kind: 'fixed', v: 844 } }, children: [] } as never;
    doc.data.pages[page]!.children.push('f1');
    const ids = await db.tx(async (q) => {
      const [u] = await q<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ('old@x.io', 'Old', 'h') RETURNING id`);
      const [o] = await q<{ id: string }>(`INSERT INTO orgs (name, slug, created_by) VALUES ('Old', 'old', $1) RETURNING id`, [u!.id]);
      await q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'admin')`, [o!.id, u!.id]);
      const [p] = await q<{ id: string }>(`INSERT INTO projects (org_id, name, stage, cycle, created_by) VALUES ($1, 'Old', 'visual', 2, $2) RETURNING id`, [o!.id, u!.id]);
      await q(`INSERT INTO designs (project_id, org_id, data) VALUES ($1, $2, $3::json)`, [p!.id, o!.id, JSON.stringify(doc.data)]);
      const add = async (kind: string, cycle: number, data: object = {}) => (await q<{ id: string }>(`INSERT INTO items (project_id, org_id, kind, cycle, title, data, created_by) VALUES ($1, $2, $3, $4, $3, $5::jsonb, $6) RETURNING id`, [p!.id, o!.id, kind, cycle, JSON.stringify(data), u!.id]))[0]!.id;
      const screen = await add('screen', 1, { frame: 'f1' });
      const gone = await add('screen', 1, { frame: 'nope' });
      const research = await add('research', 2, { method: 'interview' });
      await q(`INSERT INTO stage_events (project_id, org_id, cycle, kind, to_stage, actor) VALUES ($1, $2, 1, 'created', 'discovery', $3), ($1, $2, 2, 'new_cycle', 'discovery', $3)`, [p!.id, o!.id, u!.id]);
      return { project: p!.id, screen, gone, research };
    });
    await migrate(db);
    const owner = <T>(sql: string, params: unknown[] = []) => db.tx((q) => q<T>(sql, params));

    const streams = await owner<{ id: string; cycle: number; status: string; work_type: string; stage: string; name: string }>(`SELECT id, cycle, status, work_type, stage, name FROM workstreams WHERE project_id = $1 ORDER BY cycle`, [ids.project]);
    expect(streams.map(({ id: _, ...w }) => w)).toEqual([
      { cycle: 1, status: 'closed', work_type: 'full', stage: 'launch', name: 'Main' },
      { cycle: 2, status: 'active', work_type: 'full', stage: 'visual', name: 'Main' },
    ]);
    const [first, second] = streams;
    const items = await owner<{ id: string; workstream_id: string }>(`SELECT id, workstream_id FROM items WHERE project_id = $1`, [ids.project]);
    expect(items.find((i) => i.id === ids.screen)!.workstream_id).toBe(first!.id);
    expect(items.find((i) => i.id === ids.research)!.workstream_id).toBe(second!.id);
    const events = await owner<{ cycle: number; workstream_id: string }>(`SELECT cycle, workstream_id FROM stage_events WHERE project_id = $1 ORDER BY cycle`, [ids.project]);
    expect(events.map((e) => e.workstream_id)).toEqual([first!.id, second!.id]);

    // the frame's real size decides its device; a frame no longer in the design still keeps its link
    const frames = await owner<{ screen_id: string; frame_node: string; device: string; w: number; h: number; is_primary: boolean; page_id: string | null }>(`SELECT screen_id, frame_node, device, w, h, is_primary, page_id FROM screen_frames WHERE project_id = $1 ORDER BY w`, [ids.project]);
    expect(frames).toEqual([
      { screen_id: ids.screen, frame_node: 'f1', device: 'mobile', w: 390, h: 844, is_primary: true, page_id: page },
      { screen_id: ids.gone, frame_node: 'nope', device: 'desktop', w: 1440, h: 900, is_primary: true, page_id: null },
    ]);
  }, 60000);
});

describe('migration 009: workstreams, frames and overrides as each role', () => {
  let db: Database;
  const u: Record<'lea' | 'dan' | 'rey' | 'out', string> = {} as never;
  let org = '';
  let project = '';
  const as = <T>(id: string | null, fn: (q: Q) => Promise<T>) => withUser(db, id, fn);
  const owner = <T>(sql: string, params: unknown[] = []) => db.tx((q) => q<T>(sql, params));

  beforeAll(async () => {
    db = await openDatabase({});
    for (const n of ['lea', 'dan', 'rey', 'out'] as const) u[n] = (await owner<{ id: string }>(`INSERT INTO users (email, name, password_hash) VALUES ($1, $2, 'h') RETURNING id`, [`${n}@x.io`, n]))[0]!.id;
    org = (await as(u.lea, (q) => q<{ id: string }>(`SELECT id FROM create_org('Acme')`)))[0]!.id;
    project = (await as(u.lea, (q) => q<{ id: string }>(`SELECT create_project($1, 'One', '', $2::json) AS id`, [org, JSON.stringify(createDocument('One').data)])))[0]!.id;
    await owner(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member'), ($1, $3, 'member')`, [org, u.dan, u.rey]);
    await owner(`INSERT INTO project_members (project_id, org_id, user_id, role, is_approver) VALUES ($1, $2, $3, 'designer', true), ($1, $2, $4, 'reviewer', true)`, [project, org, u.dan, u.rey]);
  }, 60000);
  afterAll(() => db?.close());

  it('a new project starts with an active Main, which follows its stage and closes at the next cycle', async () => {
    const main = async () => owner<{ cycle: number; stage: string; status: string; work_type: string }>(`SELECT cycle, stage, status, work_type FROM workstreams WHERE project_id = $1 ORDER BY cycle`, [project]);
    expect(await main()).toEqual([{ cycle: 1, stage: 'discovery', status: 'active', work_type: 'feature' }]);
    await as(u.dan, (q) => q(`UPDATE workstreams SET work_type = 'fix' WHERE project_id = $1`, [project]));
    await as(u.dan, (q) => q(`UPDATE projects SET stage = 'launch' WHERE id = $1`, [project]));
    await as(u.dan, (q) => q(`UPDATE projects SET stage = 'discovery', cycle = 2 WHERE id = $1`, [project]));
    expect(await main()).toEqual([
      { cycle: 1, stage: 'launch', status: 'closed', work_type: 'fix' },
      { cycle: 2, stage: 'discovery', status: 'active', work_type: 'fix' },
    ]);
    // rows written without a workstream land in their cycle's Main
    const [item] = await as(u.dan, (q) => q<{ workstream_id: string }>(`INSERT INTO items (project_id, org_id, kind, cycle, created_by) VALUES ($1, $2, 'persona', 2, $3) RETURNING workstream_id`, [project, org, u.dan]));
    const [current] = await owner<{ id: string }>(`SELECT id FROM workstreams WHERE project_id = $1 AND cycle = 2`, [project]);
    expect(item!.workstream_id).toBe(current!.id);
  });

  it('reviewers and outsiders cannot change workstreams or frames', async () => {
    expect(await as(u.rey, (q) => q(`UPDATE workstreams SET work_type = 'full' WHERE project_id = $1 RETURNING 1`, [project]))).toHaveLength(0);
    expect(await as(u.out, (q) => q(`SELECT 1 FROM workstreams WHERE project_id = $1`, [project]))).toHaveLength(0);
    await denied(as(u.rey, (q) => q(`INSERT INTO workstreams (project_id, org_id, name, cycle, created_by) VALUES ($1, $2, 'Side', 1, $3)`, [project, org, u.rey])));
    // a row cannot claim another project's workstream
    const [other] = await as(u.lea, (q) => q<{ id: string }>(`SELECT create_project($1, 'Two', '', $2::json) AS id`, [org, JSON.stringify(createDocument('Two').data)]));
    const [ws] = await owner<{ id: string }>(`SELECT id FROM workstreams WHERE project_id = $1`, [other!.id]);
    await expect(as(u.lea, (q) => q(`INSERT INTO items (project_id, org_id, kind, cycle, created_by, workstream_id) VALUES ($1, $2, 'persona', 2, $3, $4)`, [project, org, u.lea, ws!.id]))).rejects.toMatchObject({ code: '23503' });
  });

  it('a screen frame follows the screen, and reviewers cannot link frames', async () => {
    const [screen] = await as(u.dan, (q) => q<{ id: string }>(`INSERT INTO items (project_id, org_id, kind, cycle, created_by, data) VALUES ($1, $2, 'screen', 2, $3, '{"frame":"n1"}') RETURNING id`, [project, org, u.dan]));
    const frames = () => owner<{ frame_node: string; is_primary: boolean }>(`SELECT frame_node, is_primary FROM screen_frames WHERE screen_id = $1 ORDER BY frame_node`, [screen!.id]);
    expect(await frames()).toEqual([{ frame_node: 'n1', is_primary: true }]);
    await as(u.dan, (q) => q(`UPDATE items SET data = '{"frame":"n2"}' WHERE id = $1`, [screen!.id]));
    // n1 is not in the stored design, so its link goes; n2 becomes primary
    expect(await frames()).toEqual([{ frame_node: 'n2', is_primary: true }]);
    await as(u.dan, (q) => q(`INSERT INTO screen_frames (project_id, org_id, screen_id, device, w, h, frame_node) VALUES ($1, $2, $3, 'mobile', 390, 844, 'n3')`, [project, org, screen!.id]));
    await denied(as(u.rey, (q) => q(`INSERT INTO screen_frames (project_id, org_id, screen_id, device, w, h, frame_node) VALUES ($1, $2, $3, 'tablet', 834, 1112, 'n4')`, [project, org, screen!.id])));
    expect(await as(u.rey, (q) => q(`DELETE FROM screen_frames WHERE screen_id = $1 RETURNING 1`, [screen!.id]))).toHaveLength(0);
    await expect(as(u.dan, (q) => q(`INSERT INTO screen_frames (project_id, org_id, screen_id, device, w, h, frame_node) VALUES ($1, $2, $3, 'phone', 1, 1, 'n5')`, [project, org, screen!.id]))).rejects.toMatchObject({ code: '23514' });
    // only a screen of the same project can own a frame
    const [persona] = await owner<{ id: string }>(`SELECT id FROM items WHERE project_id = $1 AND kind = 'persona' LIMIT 1`, [project]);
    expect(persona).toBeTruthy();
    await as(u.dan, (q) => q(`DELETE FROM items WHERE id = $1`, [screen!.id]));
    expect(await frames()).toEqual([]);
  });

  it('strict-mode overrides: the lead records them, never the review requester or an agent, and they cannot be rewritten', async () => {
    const override = (who: string, action = 'approve', stage = 'visual') => as(who, (q) => q(`INSERT INTO strict_overrides (project_id, org_id, cycle, stage, action, reason, actor) VALUES ($1, $2, 2, $3, $4, 'Deadline', $5) RETURNING actor_name`, [project, org, stage, action, who]));
    await owner(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor) VALUES ($1, $2, 2, 'review_requested', 'visual', 'visual', $3)`, [project, org, u.lea]);
    await denied(override(u.lea)); // the lead asked for this review
    await denied(override(u.dan)); // designers cannot override
    await owner(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor) VALUES ($1, $2, 2, 'review_requested', 'visual', 'visual', $3)`, [project, org, u.dan]);
    await denied(tokenActor.run('00000000-0000-4000-8000-000000000001', () => override(u.lea)));
    expect(await override(u.lea)).toEqual([{ actor_name: 'lea' }]);
    expect(await override(u.lea, 'release', 'handoff')).toHaveLength(1);
    await denied(as(u.lea, (q) => q(`UPDATE strict_overrides SET reason = 'x'`)));
    await denied(as(u.lea, (q) => q(`DELETE FROM strict_overrides`)));
    await expect(as(u.lea, (q) => q(`INSERT INTO strict_overrides (project_id, org_id, cycle, stage, action, reason, actor) VALUES ($1, $2, 2, 'visual', 'release', '  ', $3)`, [project, org, u.lea]))).rejects.toMatchObject({ code: '23514' });
    const [row] = await owner<{ n: number }>(`SELECT count(*)::int AS n FROM pg_class WHERE relname IN ('screen_frames', 'strict_overrides') AND relrowsecurity AND relforcerowsecurity`);
    expect(row!.n).toBe(2);
  });

  it('strict mode is off unless an admin turns it on', async () => {
    expect((await owner<{ strict_mode: boolean }>(`SELECT strict_mode FROM orgs WHERE id = $1`, [org]))[0]!.strict_mode).toBe(false);
    // never a direct write; only through the setting function, by an owner or admin, never on a token
    await denied(as(u.lea, (q) => q(`UPDATE orgs SET strict_mode = true WHERE id = $1`, [org])));
    await denied(as(u.dan, (q) => q(`SELECT org_set_strict_mode($1, true)`, [org])));
    await denied(tokenActor.run('00000000-0000-4000-8000-000000000001', () => as(u.lea, (q) => q(`SELECT org_set_strict_mode($1, true)`, [org]))));
    expect(await as(u.lea, (q) => q(`SELECT org_set_strict_mode($1, true) AS ok`, [org]))).toEqual([{ ok: true }]);
    expect((await owner<{ strict_mode: boolean }>(`SELECT strict_mode FROM orgs WHERE id = $1`, [org]))[0]!.strict_mode).toBe(true);
  });

  it('nothing freezes while a stage is in review', async () => {
    expect((await as(u.dan, (q) => q<{ f: boolean }>(`SELECT stage_frozen($1) AS f`, [project])))[0]!.f).toBe(false);
  });
});
