/**
 * The migration runner against a real Postgres, set up the way RDS is (the master account is not a superuser),
 * because locks, lock_timeout and CREATE INDEX CONCURRENTLY mean nothing on single-session PGlite.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { appDatabaseOptions, assertSchemaCurrent, migrate, migrationTarget, openDatabase, openPostgres, runMigrationTask, type Database, type Migration } from '../app/db.js';
import { MIGRATIONS } from '../app/schema.js';
import { startApp } from '../app/server.js';

const SLOW = 180_000;
const freePort = () =>
  new Promise<number>((ok, fail) => {
    const s = createServer();
    s.once('error', fail);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => ok(port));
    });
  });

let server: EmbeddedPostgres;
let admin: pg.Client;
let databaseDir: string;
let port: number;
let dbCount = 0;
const url = (user: string, password: string, db: string) => `postgres://${user}:${password}@127.0.0.1:${port}/${db}`;
const ownerUrl = (db: string) => url('rds_master', 'masterpw', db);

async function newDatabase(): Promise<string> {
  const name = `migrate_${++dbCount}`;
  await admin.query(`CREATE DATABASE ${name} OWNER rds_master`);
  return name;
}

/** A second connection, for holding locks and transactions against the runner. */
async function otherSession(db: string): Promise<pg.Client> {
  const c = new pg.Client({ connectionString: ownerUrl(db) });
  await c.connect();
  return c;
}

const applied = async (db: Database) => (await db.tx((q) => q<{ id: string }>('SELECT id FROM schema_migrations ORDER BY applied_at, id'))).map((r) => r.id);
const NO_TX = '-- rangoli:no-transaction\n';

beforeAll(async () => {
  port = await freePort();
  databaseDir = mkdtempSync(join(tmpdir(), 'rangoli-migrate-'));
  server = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => undefined, onError: () => undefined });
  await server.initialise();
  await server.start();
  admin = new pg.Client({ connectionString: url('postgres', 'pw', 'postgres') });
  await admin.connect();
  await admin.query(`CREATE ROLE rds_master LOGIN PASSWORD 'masterpw' CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS`);
}, SLOW);

afterAll(async () => {
  await admin?.end().catch(() => undefined);
  await server?.stop().catch(() => undefined);
  rmSync(databaseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}, SLOW);

describe('migration runner on Postgres', () => {
  let name: string;
  let db: Database;
  const extra: pg.Client[] = [];
  const hold = async () => {
    const c = await otherSession(name);
    extra.push(c);
    return c;
  };

  beforeEach(async () => {
    name = await newDatabase();
    db = await openPostgres(ownerUrl(name));
  }, SLOW);

  afterEach(async () => {
    for (const c of extra.splice(0)) await c.end().catch(() => undefined);
    await db.close();
  }, SLOW);

  it('applies migrations in array order, even when ids would sort differently', async () => {
    const list: Migration[] = [
      { id: 'zzz_first', sql: 'CREATE TABLE a (id int PRIMARY KEY);' },
      { id: 'aaa_second', sql: 'ALTER TABLE a ADD COLUMN b int; INSERT INTO a VALUES (1, 2);' },
      { id: 'mmm_third', sql: 'UPDATE a SET b = b + 1;' },
    ];
    expect(await migrate(db, { migrations: list })).toEqual(['zzz_first', 'aaa_second', 'mmm_third']);
    expect(await db.tx((q) => q('SELECT b FROM a'))).toEqual([{ b: 3 }]);
  });

  it('stops at the first failure, keeps earlier work, rolls the failure back whole, and resumes', async () => {
    const good: Migration = { id: '1', sql: 'CREATE TABLE a (id int);' };
    const bad: Migration = { id: '2', sql: 'CREATE TABLE half (id int); SELECT no_such_function();' };
    const later: Migration = { id: '3', sql: 'CREATE TABLE c (id int);' };
    await expect(migrate(db, { migrations: [good, bad, later] })).rejects.toThrow(/Migration 2 failed/);
    expect(await applied(db)).toEqual(['1']);
    const tables = await db.tx((q) => q<{ c: string | null }>(`SELECT to_regclass('half')::text AS c`));
    expect(tables[0]!.c).toBeNull();
    const fixed = { id: '2', sql: 'CREATE TABLE half (id int);' };
    expect(await migrate(db, { migrations: [good, fixed, later] })).toEqual(['2', '3']);
  });

  it('treats ids as names, not a sequence: gaps are fine, and a migration inserted later still runs once', async () => {
    const m = (id: string) => ({ id, sql: `CREATE TABLE t_${id} (id int);` });
    expect(await migrate(db, { migrations: [m('001'), m('002'), m('003'), m('006')] })).toEqual(['001', '002', '003', '006']);
    await assertSchemaCurrent(db, [m('001'), m('002'), m('003'), m('006')]);
    // a 004 added to the list after 006 shipped is applied on the next run, after 006
    expect(await migrate(db, { migrations: [m('001'), m('002'), m('003'), m('004'), m('006')] })).toEqual(['004']);
    expect(await migrate(db, { migrations: [m('001'), m('002'), m('003'), m('004'), m('006')] })).toEqual([]);
  });

  it('is idempotent: a second run does nothing', async () => {
    const list: Migration[] = [{ id: '1', sql: 'CREATE TABLE a (id int); INSERT INTO a VALUES (1);' }];
    expect(await migrate(db, { migrations: list })).toEqual(['1']);
    expect(await migrate(db, { migrations: list })).toEqual([]);
    expect(await db.tx((q) => q('SELECT count(*)::int AS n FROM a'))).toEqual([{ n: 1 }]);
  });

  it('rejects duplicate ids before touching anything', async () => {
    await expect(migrate(db, { migrations: [{ id: '1', sql: 'SELECT 1' }, { id: '1', sql: 'SELECT 2' }] })).rejects.toThrow(/share an id/);
  });

  it('serializes concurrent runs: the migration applies once and the later runner waits for it', async () => {
    const list: Migration[] = [{ id: 'slow', sql: 'CREATE TABLE ran (id int); INSERT INTO ran VALUES (1); SELECT pg_sleep(1);' }];
    const second = await openPostgres(ownerUrl(name));
    try {
      const finished: Record<string, number> = {};
      const run = (who: string, d: Database) => migrate(d, { migrations: list }).then((ids) => ((finished[who] = performance.now()), ids));
      const started = performance.now();
      const results = await Promise.all([run('a', db), run('b', second)]);
      expect(results.flat()).toEqual(['slow']); // exactly one did the work
      expect(await db.tx((q) => q('SELECT count(*)::int AS n FROM ran'))).toEqual([{ n: 1 }]);
      expect(Math.min(finished.a!, finished.b!) - started).toBeGreaterThanOrEqual(900); // neither finished while it slept
    } finally {
      await second.close();
    }
  }, 30_000);

  it('gives up with a clear error while another runner holds the lock, and proceeds once it is released', async () => {
    const other = await hold();
    await other.query('SELECT pg_advisory_lock(7200420)');
    const list: Migration[] = [{ id: '1', sql: 'CREATE TABLE a (id int);' }];
    await expect(migrate(db, { migrations: list, runnerWaitMs: 300 })).rejects.toThrow(/Another migration run still holds the lock/);
    expect(await db.tx((q) => q(`SELECT to_regclass('schema_migrations')::text AS t`))).toEqual([{ t: null }]);
    await other.query('SELECT pg_advisory_unlock(7200420)');
    expect(await migrate(db, { migrations: list, runnerWaitMs: 300 })).toEqual(['1']);
  });

  it('is not blocked by the app single-writer lock, which the old task holds during a deploy', async () => {
    const other = await hold();
    await other.query('SELECT pg_advisory_lock(7200419)');
    expect(await migrate(db, { migrations: [{ id: '1', sql: 'CREATE TABLE a (id int);' }], runnerWaitMs: 300 })).toEqual(['1']);
  });

  it('fails fast on lock_timeout instead of queueing, records nothing, and leaves the connection clean', async () => {
    await migrate(db, { migrations: [{ id: '1', sql: 'CREATE TABLE a (id int);' }] });
    const other = await hold();
    await other.query('BEGIN');
    await other.query('LOCK TABLE a IN ACCESS SHARE MODE');
    const alter: Migration = { id: '2', sql: 'ALTER TABLE a ADD COLUMN b int;' };
    const started = performance.now();
    await expect(migrate(db, { migrations: [alter], lockTimeoutMs: 200 })).rejects.toMatchObject({ code: '55P03', message: expect.stringMatching(/Migration 2 failed: could not get a lock within 200 ms/) });
    expect(performance.now() - started).toBeLessThan(5000);
    expect(await applied(db)).toEqual(['1']);
    await other.query('COMMIT');
    expect(await migrate(db, { migrations: [alter], lockTimeoutMs: 200 })).toEqual(['2']);
  });

  it('runs CREATE INDEX CONCURRENTLY outside a transaction and records it', async () => {
    await migrate(db, { migrations: [{ id: '1', sql: 'CREATE TABLE a (id int); INSERT INTO a SELECT generate_series(1, 100);' }] });
    const index: Migration = { id: '2', sql: `\n${NO_TX}CREATE INDEX CONCURRENTLY IF NOT EXISTS a_id ON a (id);` };
    expect(await migrate(db, { migrations: [index] })).toEqual(['2']);
    expect(await db.tx((q) => q(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'a_id'`))).toEqual([{ valid: true }]);
    expect(await migrate(db, { migrations: [index] })).toEqual([]);
  });

  it('refuses CREATE INDEX CONCURRENTLY in an ordinary transactional migration', async () => {
    await migrate(db, { migrations: [{ id: '1', sql: 'CREATE TABLE a (id int);' }] });
    await expect(migrate(db, { migrations: [{ id: '2', sql: 'CREATE INDEX CONCURRENTLY a_id ON a (id);' }] })).rejects.toThrow(/cannot run inside a transaction block/);
    expect(await applied(db)).toEqual(['1']);
  });

  it('replaces the invalid index a failed concurrent build leaves, rather than accepting it through IF NOT EXISTS', async () => {
    await migrate(db, { migrations: [{ id: '1', sql: 'CREATE TABLE a (id int); INSERT INTO a VALUES (1), (1);' }] });
    const unique: Migration = { id: '2', sql: `${NO_TX}CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS A_Id ON a (id);` };
    await expect(migrate(db, { migrations: [unique] })).rejects.toMatchObject({ code: '23505' });
    const validity = () => db.tx((q) => q<{ valid: boolean }>(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'a_id'`));
    expect(await validity()).toEqual([{ valid: false }]);
    expect(await applied(db)).toEqual(['1']);
    await db.exec('DELETE FROM a; INSERT INTO a VALUES (1), (2);');
    expect(await migrate(db, { migrations: [unique] })).toEqual(['2']);
    expect(await validity()).toEqual([{ valid: true }]);
  });

  it('applies its timeout to concurrent builds waiting on an open transaction, and a retry succeeds', async () => {
    await migrate(db, { migrations: [{ id: '1', sql: 'CREATE TABLE a (id int);' }] });
    const other = await hold();
    await other.query('BEGIN');
    await other.query('INSERT INTO a VALUES (1)');
    const index: Migration = { id: '2', sql: `${NO_TX}CREATE INDEX CONCURRENTLY IF NOT EXISTS a_id ON a (id);` };
    await expect(migrate(db, { migrations: [index], concurrentLockTimeoutMs: 200 })).rejects.toMatchObject({ code: '55P03' });
    await other.query('COMMIT');
    expect(await migrate(db, { migrations: [index], concurrentLockTimeoutMs: 5000 })).toEqual(['2']);
    expect(await db.tx((q) => q(`SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'a_id'`))).toEqual([{ valid: true }]);
  }, 30_000);
});

describe('hosted app without the owner password', () => {
  const hostedEnv = (db: string) => ({ DB_HOST: '127.0.0.1', DB_PORT: String(port), DB_NAME: db, DB_APP_PASSWORD: 'apppw' });

  it('derives no owner connection from the app environment, even when owner values are present', () => {
    const options = appDatabaseOptions({ ...hostedEnv('x'), DB_OWNER_USER: 'rangoli_owner', DB_OWNER_PASSWORD: 'should-not-appear' }, 'unused');
    expect(options.url).toBeUndefined();
    expect(options.appPassword).toBeUndefined();
    expect(JSON.stringify(options)).not.toContain('should-not-appear');
    expect(options.appUrl).toContain('rangoli_login');
  });

  it('never falls back to an empty embedded database when the login password is missing', () => {
    expect(() => appDatabaseOptions({ DB_HOST: 'db' }, 'unused')).toThrow(/DB_APP_PASSWORD/);
  });

  it('keeps migrating automatically for embedded and plain DATABASE_URL settings', () => {
    expect(appDatabaseOptions({}, 'data')).toEqual({ url: undefined, appUrl: undefined, sslCaFile: undefined, dataDir: 'data' });
    expect(appDatabaseOptions({ DATABASE_URL: 'postgres://o@h/d' }, 'data').url).toBe('postgres://o@h/d');
  });

  it('reads the owner credentials only for the migrate task', () => {
    expect(migrationTarget({})).toBeNull();
    expect(migrationTarget({ DB_HOST: 'db', DB_APP_PASSWORD: 'p' })).toBeNull();
    expect(migrationTarget({ DB_HOST: 'db', DB_OWNER_USER: 'o', DB_OWNER_PASSWORD: 'p@ss/word', DB_APP_PASSWORD: 'a' })).toEqual({ url: 'postgres://o:p%40ss%2Fword@db:5432/rangoli', appPassword: 'a', sslCaFile: undefined });
  });

  it('starts, serves and is ready after a separate migrate task, logging in only as rangoli_login', async () => {
    const name = await newDatabase();
    expect(await runMigrationTask({ url: ownerUrl(name), appPassword: 'apppw' })).toEqual(MIGRATIONS.map((m) => m.id));
    const db = await openDatabase(appDatabaseOptions(hostedEnv(name), 'unused'));
    expect(db.driver).toBe('postgres');
    const app = await startApp({ db, port: 0 });
    try {
      const [who] = await db.tx((q) => q<{ u: string }>('SELECT current_user AS u'));
      expect(who!.u).toBe('rangoli_login');
      await expect(db.exec('CREATE TABLE should_fail (id int)')).rejects.toMatchObject({ code: '42501' });
      await expect(db.exec('SELECT * FROM schema_migrations')).rejects.toMatchObject({ code: '42501' }); // the boot check needs no read access
      for (const path of ['healthz', 'readyz']) {
        const res = await fetch(`${app.url}${path}`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(res.headers.get('x-request-id')).toBeTruthy();
      }
    } finally {
      await app.close();
      await db.close();
    }
  }, SLOW);

  it('reports not ready without detail when the database is gone, while staying alive', async () => {
    const name = await newDatabase();
    await runMigrationTask({ url: ownerUrl(name), appPassword: 'apppw' });
    const db = await openDatabase(appDatabaseOptions(hostedEnv(name), 'unused'));
    const app = await startApp({ db, port: 0 });
    try {
      await db.close();
      const ready = await fetch(`${app.url}readyz`);
      expect(ready.status).toBe(503);
      expect(await ready.text()).toBe('{"ok":false}');
      expect((await fetch(`${app.url}healthz`)).status).toBe(200);
    } finally {
      await app.close();
    }
  }, SLOW);

  it('refuses to start before migrations have run, and when one is missing', async () => {
    const name = await newDatabase();
    await runMigrationTask({ url: ownerUrl(name), appPassword: 'apppw' }, { migrations: [] }).catch(() => undefined);
    await expect(openDatabase(appDatabaseOptions(hostedEnv(name), 'unused'))).rejects.toThrow(/rangoli migrate/);

    const owner = await openPostgres(ownerUrl(name));
    try {
      await migrate(owner);
      await assertSchemaCurrent(owner);
      await expect(assertSchemaCurrent(owner, [...MIGRATIONS, { id: '999_future', sql: '' }])).rejects.toThrow(/missing 999_future/);
    } finally {
      await owner.close();
    }
  }, SLOW);
});

describe('embedded database', () => {
  it('migrates itself on open and a repeat run does nothing', async () => {
    const db = await openDatabase();
    try {
      expect((await applied(db)).sort()).toEqual(MIGRATIONS.map((m) => m.id).sort());
      expect(await migrate(db)).toEqual([]);
      await assertSchemaCurrent(db);
    } finally {
      await db.close();
    }
  }, SLOW);

  it('supports the no-transaction path and recovers from a failed transactional migration', async () => {
    const db = await openDatabase();
    try {
      await expect(migrate(db, { migrations: [{ id: 'bad', sql: 'CREATE TABLE half (id int); SELECT no_such_function();' }] })).rejects.toThrow(/Migration bad failed/);
      expect(await migrate(db, { migrations: [{ id: 'plain', sql: `${NO_TX}CREATE TABLE plain (id int);` }] })).toEqual(['plain']);
      expect(await db.tx((q) => q(`SELECT to_regclass('half')::text AS h, to_regclass('plain')::text AS p`))).toEqual([{ h: null, p: 'plain' }]);
    } finally {
      await db.close();
    }
  }, SLOW);
});
