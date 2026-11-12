import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RangoliDocument, createDocument, type ChangeEntry, type DocumentData, type Op, type TokenTree } from '@rangoli/engine';
import { hydrateDocument } from '@rangoli/engine/io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openDatabase, withUser, type Database } from '../app/db.js';
import { actor, DbStore } from '../app/store.js';
import { Session, type DesignStore } from '../session.js';
import { startPreview, type PreviewServer } from '../http.js';
import { FileDesignLog, materialize, makeCheckpoint, documentScopeData, type CommitBatch, type DesignLog, type LoadedLog, type StoredScope } from './log.js';
import { ProjectActor } from './project-actor.js';

const SEEDS = Array.from({ length: 16 }, (_, i) => i * 2654435761 + 11);
const clone = <T>(v: T): T => structuredClone(v);
const settle = () => new Promise<void>((r) => setTimeout(r, 1));

function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: T[]): T => xs[Math.floor(next() * xs.length)]! };
}

/** A log held in memory that can refuse, or simply stop writing as a crash would. */
class MemoryLog implements DesignLog {
  scopes = new Map<string, StoredScope>();
  rows: ChangeEntry[] = [];
  refuseWith: unknown;
  crashed = false;
  async load(): Promise<LoadedLog | null> {
    if (!this.scopes.size) return null;
    const stored = JSON.parse(JSON.stringify({ scopes: [...this.scopes.values()], rows: this.rows })) as LoadedLog;
    return { ...stored, headSeq: this.rows.at(-1)?.seq ?? Math.max(...stored.scopes.map((s) => s.seq)) };
  }
  async append(batch: CommitBatch): Promise<void> {
    if (this.refuseWith) throw this.refuseWith;
    if (this.crashed) throw Object.assign(new Error('gone'), { code: '42501' });
    await settle();
    if (this.crashed) throw Object.assign(new Error('gone'), { code: '42501' });
    this.rows.push(...batch.entries.map((e) => JSON.parse(JSON.stringify(e)) as ChangeEntry));
    for (const c of batch.checkpoints) this.scopes.set(c.scope, { scope: c.scope, seq: c.seq, data: JSON.parse(c.json) });
  }
  async loadPage(): Promise<null> {
    return null;
  }
}

class StoreWith implements DesignStore {
  readonly location = '';
  saved = 0;
  constructor(readonly log: DesignLog, readonly attribution?: DesignStore['attribution']) {}
  async saveDocument() {
    this.saved++;
  }
  async saveReviews() {}
  async loadReviews() {
    return null;
  }
  async putAsset() {}
  async readAssetFile() {
    return null;
  }
  assetDataUri() {
    return '';
  }
  async putVersion() {}
  async getVersion() {
    return null;
  }
}

function twoPageDoc(): RangoliDocument {
  const doc = createDocument('multi');
  doc.data.manifest.pages.push({ id: 'p2', name: 'Two' });
  doc.data.pages.p2 = { id: 'p2', name: 'Two', children: [], nodes: {} };
  doc.data.motion ??= {};
  doc.data.assets ??= {};
  return new RangoliDocument(doc.data);
}

function randomEdit(doc: RangoliDocument, r: ReturnType<typeof rng>): Op[] {
  const page = r.pick(['p1', 'p2']);
  const ids = Object.keys(doc.page(page).nodes);
  const id = ids.length ? r.pick(ids) : undefined;
  switch (r.int(7)) {
    case 0:
    case 1:
      return [{ op: 'create', page, node: { id: '', type: 'frame', name: `f${r.int(1e6)}` } }];
    case 2:
      return id ? [{ op: 'update', page, id, patch: { style: { opacity: r.next() } } }] : [];
    case 3:
      return id ? [{ op: 'patch', page, id, sets: [{ path: ['name'], value: `n${r.int(100)}` }] }] : [];
    case 4:
      return id ? [{ op: 'delete', page, id }] : [];
    case 5: {
      const t = clone(doc.data.tokens) as Record<string, Record<string, unknown>>;
      (t.color ??= {})[`x${r.int(4)}`] = { $value: '#123456', $type: 'color' };
      return [{ op: 'setTokens', tokens: t as unknown as TokenTree }];
    }
    default: {
      // one change across two pages and the tokens: a row in every scope's tail
      return [
        ...(ids.length ? ([{ op: 'patch', page, id: ids[0]!, sets: [{ path: ['role'], value: `r${r.int(4)}` }] }] as Op[]) : []),
        { op: 'setAsset', id: `a${r.int(3)}`, meta: null },
        { op: 'create', page: page === 'p1' ? 'p2' : 'p1', node: { id: '', type: 'frame', name: 'cross' } },
      ];
    }
  }
}

describe('checkpoints and replay', () => {
  it.each(SEEDS)('checkpoint plus tail equals full replay, and every prefix of the log equals live state then (seed %i)', async (seed) => {
    const doc = twoPageDoc();
    const initialScopes = [makeCheckpoint('', 0, documentScopeData(doc.data)), ...Object.keys(doc.data.pages).map((id) => makeCheckpoint(id, 0, doc.data.pages[id]))].map((c) => ({ scope: c.scope, seq: c.seq, data: JSON.parse(c.json) as unknown }));
    const log = new MemoryLog();
    const actorW = new ProjectActor(doc, log, { windowMs: 0, checkpointOps: 7 });
    doc.onChange((e) => actorW.enqueue(e));
    const snapshots = new Map<number, DocumentData>();
    const r = rng(seed);
    for (let i = 0; i < 80; i++) {
      const ops = randomEdit(doc, r);
      if (ops.length) {
        doc.apply(ops);
        snapshots.set(doc.headSeq, clone(doc.data));
      }
      if (r.next() < 0.3) await actorW.commit();
    }
    await actorW.commit();

    const loaded = (await log.load())!;
    const fromCheckpoint = materialize(loaded);
    expect(fromCheckpoint.doc.data).toEqual(doc.data);
    // the tail stayed bounded: no scope carries more than one threshold's worth
    expect(Math.max(0, ...[...fromCheckpoint.counters.values()].map((c) => c.ops))).toBeLessThan(10);

    const full = materialize({ scopes: clone(initialScopes), rows: loaded.rows, headSeq: loaded.headSeq });
    expect(full.doc.data).toEqual(doc.data);

    // any log prefix describes the state at that point
    const cut = r.int(loaded.rows.length);
    const seqAt = loaded.rows[cut]!.seq;
    const prefix = materialize({ scopes: clone(initialScopes), rows: loaded.rows.slice(0, cut + 1), headSeq: seqAt });
    expect(prefix.doc.data).toEqual(snapshots.get(seqAt));
  });
});

describe('durable commit', () => {
  it.each(SEEDS)('a crash at any moment keeps every acknowledged write (seed %i)', async (seed) => {
    const doc = twoPageDoc();
    const log = new MemoryLog();
    const actorW = new ProjectActor(doc, log, { windowMs: 0, onRefused: () => undefined });
    doc.onChange((e) => actorW.enqueue(e));
    const snapshots = new Map<number, DocumentData>();
    const r = rng(seed);
    const acked: number[] = [];
    const stopAt = 20 + r.int(60);
    for (let i = 0; i < stopAt; i++) {
      const ops = randomEdit(doc, r);
      if (!ops.length) continue;
      doc.apply(ops);
      snapshots.set(doc.headSeq, clone(doc.data));
      const seq = doc.headSeq;
      const mine = actorW.commit().then(() => acked.push(seq), () => undefined);
      if (r.next() < 0.6) await mine;
    }
    await settle();
    log.crashed = true; // the process dies: whatever was not yet written never will be
    await actorW.commit().catch(() => undefined);

    const after = (await log.load())!;
    const restored = materialize(after);
    const head = after.rows.at(-1)!.seq;
    for (const seq of acked) expect(after.rows.some((row) => row.seq === seq), `acked #${seq}`).toBe(true);
    expect(restored.doc.data).toEqual(snapshots.get(head));
  });

  it('a commit the database refuses is rolled back and reported', async () => {
    const doc = createDocument('x');
    const log = new MemoryLog();
    let refused = 0;
    const actorW = new ProjectActor(doc, log, { windowMs: 0, onRefused: () => refused++ });
    doc.onChange((e) => actorW.enqueue(e));
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'kept' } }]);
    await actorW.commit();
    const before = clone(doc.data);
    log.refuseWith = Object.assign(new Error('RLS'), { code: '42501' });
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'refused' } }]);
    doc.apply([{ op: 'update', id: 'n1', patch: { name: 'refused too' } }]);
    await expect(actorW.commit()).rejects.toMatchObject({ code: '42501' });
    expect(doc.data).toEqual(before);
    expect(doc.headSeq).toBe(1);
    expect(refused).toBe(1);
    // a change made after the refusal is taken back too
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'late' } }]);
    expect(doc.data).toEqual(before);
  });

  it('a commit retries a transient failure instead of losing the edit', async () => {
    const doc = createDocument('x');
    const log = new MemoryLog();
    const actorW = new ProjectActor(doc, log, { windowMs: 0 });
    doc.onChange((e) => actorW.enqueue(e));
    const realAppend = log.append.bind(log);
    let fails = 1;
    log.append = async (b) => {
      if (fails-- > 0) throw new Error('connection reset');
      return realAppend(b);
    };
    doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'kept' } }]);
    await actorW.commit();
    expect(log.rows).toHaveLength(1);
  });
});

describe('sessions over the log', () => {
  it('history, sequence numbers and per-author undo survive a restart', async () => {
    const log = new MemoryLog();
    let who = 'alice';
    const open = (doc: RangoliDocument) => Session.fromStore(new StoreWith(log, () => ({ actorId: who })), doc);
    const first = await open(createDocument('x'));
    first.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'alice1' } }], { author: 'human:alice', label: 'a' });
    who = 'bob';
    first.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'bob1' } }], { author: 'human:bob', label: 'b' });
    await first.durable();
    const seqs = first.doc.historyEntries.map((e) => e.seq);

    const reopened = await open(createDocument('x'));
    expect(reopened.doc.historyEntries.map((e) => e.seq)).toEqual(seqs);
    expect(reopened.doc.historyEntries.map((e) => e.label)).toEqual(['a', 'b']);
    expect(reopened.doc.headSeq).toBe(first.doc.headSeq);

    reopened.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'bob2' } }], { author: 'human:bob' });
    who = 'alice';
    const undone = reopened.doc.undo();
    expect(undone?.label).toBe('a');
    expect(reopened.doc.findNode('n1')).toBeUndefined();
    expect(reopened.doc.findNode('n2')?.node.name).toBe('bob1');
    await reopened.durable();

    const third = await open(createDocument('x'));
    expect(third.doc.findNode('n1')).toBeUndefined();
    expect(third.doc.historyEntries.map((e) => e.label)).toEqual(['b', undefined]);
    expect(third.doc.headSeq).toBe(reopened.doc.headSeq);
  });

  it('a save no longer writes the whole document on every edit', async () => {
    const store = new StoreWith(new MemoryLog());
    const session = await Session.fromStore(store, createDocument('x'));
    session.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'a' } }]);
    await session.durable();
    await new Promise((r) => setTimeout(r, 200));
    expect(store.saved).toBe(0);
    await session.flush();
    expect(store.saved).toBe(1);
  });

  it('publishes a change only after it is durable', async () => {
    const log = new MemoryLog();
    const session = await Session.fromStore(new StoreWith(log), createDocument('x'));
    const events: number[] = [];
    session.on('change', (e) => events.push(e.seq));
    session.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'a' } }]);
    expect(events).toHaveLength(0);
    await session.durable();
    expect(events).toEqual([1]);
  });
});

describe('a real process, killed', () => {
  const dist = (f: string) => pathToFileURL(resolve(__dirname, '..', '..', 'dist', f)).href;

  it('an acknowledged write outlives kill -9', async () => {
    vi.stubEnv('RANGOLI_DESIGN_LOG', '1');
    const dir = await mkdtemp(join(tmpdir(), 'rangoli-kill-'));
    const doc = join(dir, 'kill.rangoli');
    const script = join(dir, 'writer.mjs');
    await writeFile(script, `
import { Session } from ${JSON.stringify(dist('session.js'))};
const session = await Session.openOrCreate(${JSON.stringify(doc)}, 'kill');
const parent = session.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'root-' + Date.now() } }]).created[0];
await session.durable();
for (let i = 0; ; i++) {
  const made = session.doc.apply([{ op: 'create', parent, node: { id: '', type: 'text', name: 'w' + i, text: String(i) } }, { op: 'update', id: parent, patch: { name: 'at' + i } }], { label: 'w' + i, author: 'kill' }).created[0];
  await session.durable();
  process.stdout.write(made + ' ' + i + ' ' + session.doc.headSeq + '\\n');
}
`);
    const acked: { id: string; i: number; seq: number }[] = [];
    try {
      for (let round = 0; round < 4; round++) {
        await new Promise<void>((done, fail) => {
          const child = spawn(process.execPath, [script], { env: { ...process.env, RANGOLI_DESIGN_LOG: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          let err = '';
          const killAt = 15 + round * 7;
          let seen = 0;
          child.stderr.on('data', (b: Buffer) => { err += b.toString(); });
          child.stdout.on('data', (b: Buffer) => {
            out += b.toString();
            const lines = out.split('\n');
            out = lines.pop()!;
            for (const l of lines) {
              const [id, i, seq] = l.split(' ');
              acked.push({ id: id!, i: Number(i), seq: Number(seq) });
              if (++seen === killAt) child.kill('SIGKILL');
            }
          });
          child.on('error', fail);
          child.on('exit', (code, signal) => {
            if (signal === 'SIGKILL' || seen >= killAt) done();
            else fail(new Error(`writer exited early (${code}): ${err}`));
          });
        });
        const reopened = await Session.open(doc);
        const check = reopened.doc;
        for (const a of acked) expect(check.findNode(a.id), `acked ${a.id} (round ${round})`).toBeDefined();
        expect(check.headSeq).toBeGreaterThanOrEqual(Math.max(...acked.map((a) => a.seq)));
        const labels = new Set(check.historyEntries.map((e) => e.label));
        for (const a of acked) expect(labels.has(`w${a.i}`), `history w${a.i}`).toBe(true);
      }
      // numbering stayed monotonic across restarts: a killed writer's seq is never reused
      const seqs = acked.map((a) => a.seq);
      expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      vi.unstubAllEnvs();
      await rm(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe('the database log', () => {
  let db: Database;
  const u: Record<'alice' | 'bob' | 'carol', string> = {} as never;
  let orgId = '';
  let projectId = '';

  const as = <T>(id: string | null, fn: Parameters<typeof withUser<T>>[2]) => withUser(db, id, fn);
  const openSession = (user: string) => {
    const store = new DbStore(db, projectId, orgId, () => undefined);
    return actor.run(user, async () => {
      const [row] = await as(user, (q) => q<{ data: DocumentData }>(`SELECT data FROM designs WHERE project_id = $1`, [projectId]));
      return Session.fromStore(store, hydrateDocument(row!.data));
    });
  };

  beforeAll(async () => {
    vi.stubEnv('RANGOLI_DESIGN_LOG', '1');
    db = await openDatabase({ url: process.env.TEST_DATABASE_URL });
    for (const n of ['alice', 'bob', 'carol'] as const) {
      const [row] = await as(null, (q) => q<{ id: string }>(`SELECT auth_signup($1,$2,'hash') AS id`, [`${n}@log.io`, n]));
      u[n] = row!.id;
    }
    [{ id: orgId }] = (await as(u.alice, (q) => q<{ id: string }>('SELECT id FROM create_org($1)', ['Log'])));
    [{ id: projectId }] = (await as(u.alice, (q) => q<{ id: string }>(`SELECT create_project($1,'P','',$2::json) AS id`, [orgId, JSON.stringify(createDocument('p').data)])));
    await db.tx(async (owner) => {
      await owner(`INSERT INTO org_members (org_id,user_id,role) VALUES ($1,$2,'member'),($1,$3,'member')`, [orgId, u.bob, u.carol]);
    });
    // alice created the project, so she leads it and staffs it
    await as(u.alice, async (q) => {
      for (const [id, role] of [[u.bob, 'designer'], [u.carol, 'reviewer']] as const) await q(`INSERT INTO project_members (project_id,org_id,user_id,role) VALUES ($1,$2,$3,$4)`, [projectId, orgId, id, role]);
    });
  }, 120000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    await db?.close();
  });

  it('persists path patches with per-row authorship, across restart', async () => {
    const session = await openSession(u.alice);
    expect(session.logEnabled).toBe(true);
    actor.run(u.alice, () => session.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'alices', style: { opacity: 1 } } }], { author: 'human:alice', label: 'make' }));
    actor.run(u.bob, () => session.doc.apply([{ op: 'update', id: 'n1', patch: { style: { opacity: 0.5 } } }], { author: 'human:bob', label: 'dim' }));
    await session.durable();

    const rows = await as(u.alice, (q) => q<{ actor_id: string; ops: Op[]; seq: number }>(`SELECT actor_id, ops, seq::float8 AS seq FROM design_ops WHERE project_id = $1 ORDER BY seq`, [projectId]));
    expect(rows.map((r) => r.actor_id)).toEqual([u.alice, u.bob]);
    expect(rows[1]!.ops[0]).toMatchObject({ op: 'patch', sets: [{ path: ['style', 'opacity'], value: 0.5 }] });

    const restarted = await openSession(u.bob);
    expect(restarted.doc.node('n1').style).toEqual({ opacity: 0.5 });
    expect(restarted.doc.historyEntries.map((e) => e.label)).toEqual(['make', 'dim']);
    expect(restarted.doc.headSeq).toBe(rows.at(-1)!.seq);

    // alice's undo cannot pop bob's later change, and his edit to opacity stays
    const undone = actor.run(u.alice, () => restarted.doc.undo());
    expect(undone?.label).toBe('make');
    await restarted.durable();
    expect(restarted.doc.findNode('n1')?.node.style?.opacity).toBe(0.5);
    expect(undone?.stayed).toBeGreaterThan(0);
  }, 60000);

  it('loads a single page without the rest of the document', async () => {
    const session = await openSession(u.alice);
    actor.run(u.alice, () => session.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'second' } }], { author: 'human:alice' }));
    await session.durable();
    const page = await actor.run(u.alice, () => session.store.log!.loadPage('p1'));
    expect(Object.values(page!.page.nodes).map((n) => n.name)).toContain('second');
  });

  it('a person who may not edit is refused, and memory goes back', async () => {
    const session = await openSession(u.alice);
    const before = clone(session.doc.data);
    actor.run(u.carol, () => session.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'not allowed' } }], { author: 'human:carol' }));
    await expect(session.durable()).rejects.toBeTruthy();
    expect(session.doc.data).toEqual(before);
    const rows = await as(u.alice, (q) => q(`SELECT 1 FROM design_ops WHERE author = 'human:carol'`));
    expect(rows).toHaveLength(0);
  });

  it('nothing rewrites the log', async () => {
    await expect(as(u.alice, (q) => q(`UPDATE design_ops SET label = 'x'`))).rejects.toMatchObject({ code: '42501' });
    await expect(as(u.alice, (q) => q(`DELETE FROM design_ops`))).rejects.toMatchObject({ code: '42501' });
  });
});

describe('the document API with the log on', () => {
  let dir: string;
  let srv: PreviewServer;
  let session: Session;

  beforeAll(async () => {
    vi.stubEnv('RANGOLI_DESIGN_LOG', '1');
    dir = await mkdtemp(join(tmpdir(), 'rangoli-api-'));
    session = await Session.create(join(dir, 'd.rangoli'), 'Api');
    session.doc.data.manifest.pages.push({ id: 'p2', name: 'Two' });
    session.doc.data.pages.p2 = { id: 'p2', name: 'Two', children: [], nodes: {} };
    srv = await startPreview(session, { port: 4978 });
  });
  afterAll(async () => {
    await srv?.close();
    await session?.flush();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('acknowledges an edit only after it is durable, and serves one page at a time', async () => {
    const r = await fetch(`${srv.url}api/rdl`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script: 'Card col p4' }) });
    expect(r.status).toBe(200);
    // the log already holds it when the response arrives
    const reopened = await new FileDesignLog(session.dir).load();
    expect(reopened!.rows.at(-1)?.seq).toBe(session.doc.headSeq);
    const doc = (await (await fetch(`${srv.url}api/doc?page=active`)).json()) as { data: DocumentData; loadedPages: string[]; seq: number };
    expect(doc.loadedPages).toEqual(['p1']);
    expect(doc.seq).toBe(session.doc.headSeq);
    expect(Object.keys(doc.data.pages.p1!.nodes).length).toBeGreaterThan(0);
    const page = (await (await fetch(`${srv.url}api/pages/p2`)).json()) as { page: { name: string } };
    expect(page.page.name).toBe('Two');
    expect((await fetch(`${srv.url}api/pages/__proto__`)).status).toBe(404);
    expect((await fetch(`${srv.url}api/doc?page=__proto__`)).status).toBe(404);
  });
});
