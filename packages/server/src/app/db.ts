/**
 * Postgres access. Two drivers, one contract: embedded PGlite (real Postgres compiled to WASM, no install)
 * by default, or a server when DATABASE_URL is set. RLS behaves identically on both.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readFile } from 'node:fs/promises';
import { logger } from '../telemetry/log.js';
import { metrics } from '../telemetry/metrics.js';
import { MIGRATIONS } from './schema.js';

/** The API token behind the current request, so the database can refuse what only a person may do. */
export const tokenActor = new AsyncLocalStorage<string>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Q = <R = any>(sql: string, params?: unknown[]) => Promise<R[]>;

export interface Database {
  driver: 'pglite' | 'postgres';
  /** Plain transaction with no identity. Application code goes through withUser instead. */
  tx<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  /** One dedicated connection outside any transaction, for session state and statements that refuse a transaction. */
  session<T>(fn: (s: DatabaseSession) => Promise<T>): Promise<T>;
  /** Resolves once this is the only app process on the database; open designs live in memory. */
  singleton(): Promise<void>;
  close(): Promise<void>;
}

export interface DatabaseSession {
  query: Q;
  /** Runs SQL that may hold several statements. */
  exec(sql: string): Promise<void>;
}

export interface DatabaseOptions {
  /** postgres:// connection string for the schema owner, which migrates on open; omit for embedded or app-only */
  url?: string;
  /** postgres:// connection string the running app uses, logging in as rangoli_login. Alone, nothing is migrated */
  appUrl?: string;
  /** set rangoli_login's password during migration (managed deployments) */
  appPassword?: string;
  /** CA bundle for TLS to a Postgres server, e.g. the RDS global bundle */
  sslCaFile?: string;
  /** embedded data directory; omit for an in-memory database (tests) */
  dataDir?: string;
}

async function openPglite(dataDir?: string): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  if (dataDir) await mkdir(dataDir, { recursive: true });
  const db = new PGlite(dataDir);
  await db.waitReady;
  return {
    driver: 'pglite',
    tx: (fn) => db.transaction(async (t) => fn(async <R>(sql: string, params?: unknown[]) => (await t.query<R>(sql, params as unknown[])).rows)) as Promise<never>,
    exec: async (sql) => void (await db.exec(sql)),
    session: (fn) =>
      fn({
        query: async <R>(sql: string, params?: unknown[]) => (await db.query<R>(sql, params as unknown[])).rows,
        exec: async (sql) => void (await db.exec(sql)),
      }),
    singleton: async () => undefined, // one process owns the data directory already
    close: () => db.close(),
  };
}

export async function openPostgres(url: string, sslCaFile?: string): Promise<Database> {
  const { default: pg } = await import('pg');
  const ssl = sslCaFile ? { ca: await readFile(sslCaFile, 'utf8'), rejectUnauthorized: true } : undefined;
  const pool = new pg.Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 10000, ssl });
  // an idle connection dropped by the server must not bring the process down
  pool.on('error', (err) => logger.error('database connection lost', { err }));
  const held: { client?: import('pg').PoolClient } = {};
  const connect = async () => {
    const started = performance.now();
    const client = await pool.connect();
    metrics.observe('db.pool.wait_ms', performance.now() - started);
    return client;
  };
  return {
    driver: 'postgres',
    tx: async (fn) => {
      const client = await connect();
      try {
        await client.query('BEGIN');
        const out = await fn(async (sql, params) => (await client.query(sql, params as unknown[])).rows);
        await client.query('COMMIT');
        return out;
      } catch (e) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    exec: async (sql) => void (await pool.query(sql)),
    session: async (fn) => {
      const client = await connect();
      client.on('error', (err) => logger.error('database session lost', { err }));
      try {
        return await fn({
          query: async (sql, params) => (await client.query(sql, params as unknown[])).rows,
          exec: async (sql) => void (await client.query(sql)),
        });
      } finally {
        client.release(true); // closed, not pooled: no session setting or lock can outlive this
      }
    },
    singleton: async () => {
      const client = await connect();
      held.client = client;
      client.on('error', () => {
        // holding the lock is what makes this process the writer; without it, exit and let the orchestrator restart
        logger.error('lost the single-writer lock, exiting');
        process.exit(1);
      });
      for (let waited = false; ; waited = true) {
        const r = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock(7200419) AS ok');
        if (r.rows[0]!.ok) return;
        if (!waited) logger.warn('another app process is running on this database; waiting for it to stop');
        await new Promise((ok) => setTimeout(ok, 3000));
      }
    },
    close: async () => {
      held.client?.release();
      await pool.end();
    },
  };
}

/**
 * Open the database the running app will use.
 *
 * Embedded and a plain DATABASE_URL migrate here, so local use needs no extra step. Given only appUrl, as in the
 * hosted deployment, nothing is migrated: that login holds no owner rights, a separate task (`rangoli migrate`)
 * has already run, and this refuses to start if it has not.
 *
 * On a Postgres server the app should log in as rangoli_login (APP_DATABASE_URL): SET ROLE is checked against
 * the login user, so that login cannot step out of rangoli_app even if an injection got through.
 * Embedded PGlite is a single superuser session and cannot make that separation; there every query being
 * parameterized is what stops it. RLS itself is enforced the same on both.
 */
export async function openDatabase(opts: DatabaseOptions = {}): Promise<Database> {
  if (!opts.url && opts.appUrl) {
    const app = await openPostgres(opts.appUrl, opts.sslCaFile);
    try {
      await assertSchemaCurrent(app);
    } catch (e) {
      await app.close().catch(() => undefined);
      throw e;
    }
    return app;
  }
  if (!opts.url) {
    const db = await openPglite(opts.dataDir);
    await migrate(db);
    return db;
  }
  const owner = await openPostgres(opts.url, opts.sslCaFile);
  await migrate(owner);
  if (opts.appPassword) await setLoginPassword(owner, opts.appPassword);
  if (!opts.appUrl) {
    logger.warn('APP_DATABASE_URL is not set: the app is using the schema owner login. Set it to a rangoli_login connection for production.');
    return owner;
  }
  await owner.close();
  return openPostgres(opts.appUrl, opts.sslCaFile);
}

async function setLoginPassword(owner: Database, password: string): Promise<void> {
  await owner.tx(async (q) => {
    const [row] = await q<{ sql: string }>(`SELECT format('ALTER ROLE rangoli_login PASSWORD %L', $1::text) AS sql`, [password]);
    await q(row!.sql);
  });
}

type Env = Record<string, string | undefined>;

// ECS injects credentials as separate values, so a password never has to be URL-safe
const partsUrl = (env: Env, user: string, password: string) => `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${env.DB_HOST}:${env.DB_PORT ?? 5432}/${env.DB_NAME ?? 'rangoli'}`;

/** Connection settings for `rangoli app`. With DB_HOST the owner credentials are never read. */
export function appDatabaseOptions(env: Env, dataDir: string): DatabaseOptions {
  const sslCaFile = env.DB_SSL_CA;
  if (env.DB_HOST) {
    // falling through would quietly start an empty embedded database in place of the real one
    if (!env.DB_APP_PASSWORD) throw new Error('DB_HOST is set but DB_APP_PASSWORD is not: the app has no way to log in.');
    return { appUrl: partsUrl(env, 'rangoli_login', env.DB_APP_PASSWORD), sslCaFile };
  }
  return { url: env.DATABASE_URL, appUrl: env.APP_DATABASE_URL, sslCaFile, dataDir };
}

export interface MigrationTarget {
  url: string;
  appPassword?: string;
  sslCaFile?: string;
}

/** Connection settings for `rangoli migrate`, or null when no server is configured. */
export function migrationTarget(env: Env): MigrationTarget | null {
  const url = env.DB_HOST && env.DB_OWNER_USER && env.DB_OWNER_PASSWORD ? partsUrl(env, env.DB_OWNER_USER, env.DB_OWNER_PASSWORD) : env.DATABASE_URL;
  return url ? { url, appPassword: env.DB_APP_PASSWORD, sslCaFile: env.DB_SSL_CA } : null;
}

/** The migrate task: run pending migrations as the owner, set the login password, disconnect. Returns the ids applied. */
export async function runMigrationTask(target: MigrationTarget, opts: MigrateOptions = {}): Promise<string[]> {
  const owner = await openPostgres(target.url, target.sslCaFile);
  try {
    const applied = await migrate(owner, opts);
    if (target.appPassword) await setLoginPassword(owner, target.appPassword);
    return applied;
  } finally {
    await owner.close();
  }
}

export interface Migration {
  id: string;
  /**
   * Starting the SQL with the comment `-- rangoli:no-transaction` runs it outside a transaction, for
   * CREATE INDEX CONCURRENTLY. Such a migration must be one statement (several sent together form an implicit
   * transaction) and safe to repeat (use IF NOT EXISTS): a crash before it is recorded runs it again.
   */
  sql: string;
}

export interface MigrateOptions {
  migrations?: readonly Migration[];
  /** How long a migration may queue for a table lock. Short, because every query on that table queues behind it. */
  lockTimeoutMs?: number;
  /**
   * The same for no-transaction migrations. Longer, because CREATE INDEX CONCURRENTLY has to wait out every
   * transaction already using the table, and it blocks nobody while it does.
   */
  concurrentLockTimeoutMs?: number;
  /** How long to wait for another runner to finish. */
  runnerWaitMs?: number;
}

// distinct from the single-writer lock (7200419), which the previous app task still holds during a deploy
const MIGRATION_LOCK = 7200420;
const NO_TRANSACTION = /^\s*--\s*rangoli:no-transaction\b/;
const CONCURRENT_INDEX = /create\s+(?:unique\s+)?index\s+concurrently\s+(?:if\s+not\s+exists\s+)?(?:"([^"]+)"|([a-z_][\w$]*))/i;

async function takeMigrationLock(s: DatabaseSession, waitMs: number): Promise<void> {
  const deadline = performance.now() + waitMs;
  for (let announced = false; ; announced = true) {
    const [row] = await s.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [MIGRATION_LOCK]);
    if (row!.ok) return;
    if (performance.now() >= deadline) throw new Error(`Another migration run still holds the lock after ${waitMs} ms; nothing was applied.`);
    if (!announced) logger.warn('another migration run is in progress; waiting for it to finish');
    await new Promise((ok) => setTimeout(ok, 100));
  }
}

function failure(id: string, e: unknown, lockTimeoutMs: number): Error {
  const err = e as { code?: string; message?: string };
  const reason = err.code === '55P03' ? `could not get a lock within ${lockTimeoutMs} ms; run it again when the table is quieter` : err.message;
  return Object.assign(new Error(`Migration ${id} failed: ${reason}`, { cause: e }), { code: err.code });
}

async function applyInTransaction(s: DatabaseSession, m: Migration, lockTimeoutMs: number): Promise<void> {
  try {
    await s.exec('BEGIN');
    await s.exec(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
    await s.exec(m.sql);
    await s.query('INSERT INTO schema_migrations (id) VALUES ($1)', [m.id]);
    await s.exec('COMMIT');
  } catch (e) {
    await s.exec('ROLLBACK').catch(() => undefined);
    throw e;
  }
}

/** A failed or killed CREATE INDEX CONCURRENTLY leaves an invalid index that IF NOT EXISTS would then accept as done. */
async function dropInvalidIndex(s: DatabaseSession, sql: string): Promise<void> {
  const match = CONCURRENT_INDEX.exec(sql);
  if (!match) return;
  const name = match[1] ?? match[2]!.toLowerCase();
  const invalid = await s.query(`SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND pg_table_is_visible(c.oid) AND NOT i.indisvalid`, [name]);
  if (invalid.length) await s.exec(`DROP INDEX CONCURRENTLY IF EXISTS "${name.replace(/"/g, '""')}"`);
}

async function applyOutsideTransaction(s: DatabaseSession, m: Migration, lockTimeoutMs: number): Promise<void> {
  await s.exec(`SET lock_timeout = '${lockTimeoutMs}ms'`);
  await dropInvalidIndex(s, m.sql);
  await s.exec(m.sql);
  await s.query('INSERT INTO schema_migrations (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [m.id]);
}

/**
 * The app login must not be able to read schema_migrations, yet has to know at boot whether the schema is current.
 * A table comment is readable from the catalog without any privilege on the table, so no grant is needed.
 */
async function publishSchemaState(s: DatabaseSession): Promise<void> {
  const [row] = await s.query<{ sql: string }>(`SELECT format('COMMENT ON TABLE schema_migrations IS %L', coalesce(json_agg(id ORDER BY id), '[]'::json)::text) AS sql FROM schema_migrations`);
  await s.exec(row!.sql);
}

/**
 * Apply pending migrations in array order, stopping at the first failure. Safe to run repeatedly and from
 * several processes at once: a session lock makes later runners wait, and they then find nothing to do.
 */
export async function migrate(db: Database, opts: MigrateOptions = {}): Promise<string[]> {
  const migrations = opts.migrations ?? MIGRATIONS;
  const lockTimeoutMs = opts.lockTimeoutMs ?? 3000;
  const concurrentLockTimeoutMs = opts.concurrentLockTimeoutMs ?? 600_000;
  if (new Set(migrations.map((m) => m.id)).size !== migrations.length) throw new Error('Two migrations share an id.');
  return db.session(async (s) => {
    await takeMigrationLock(s, opts.runnerWaitMs ?? 300_000);
    try {
      await s.exec(`SET lock_timeout = '${lockTimeoutMs}ms'`);
      await s.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      const done = new Set((await s.query<{ id: string }>('SELECT id FROM schema_migrations')).map((r) => r.id));
      const applied: string[] = [];
      for (const m of migrations) {
        if (done.has(m.id)) continue;
        const outside = NO_TRANSACTION.test(m.sql);
        try {
          if (outside) await applyOutsideTransaction(s, m, concurrentLockTimeoutMs);
          else await applyInTransaction(s, m, lockTimeoutMs);
        } catch (e) {
          throw failure(m.id, e, outside ? concurrentLockTimeoutMs : lockTimeoutMs);
        }
        applied.push(m.id);
      }
      await s.exec(`SET lock_timeout = '${lockTimeoutMs}ms'`);
      await publishSchemaState(s);
      return applied;
    } finally {
      await s.exec('RESET lock_timeout').catch(() => undefined);
      await s.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    }
  });
}

/** Refuse to serve on a schema older than this build expects. A newer schema is fine: deploys expand first. */
export async function assertSchemaCurrent(db: Database, migrations: readonly Migration[] = MIGRATIONS): Promise<void> {
  const behind = (detail: string) => new Error(`The database schema is behind this build (${detail}). Run "rangoli migrate" as the schema owner first.`);
  const [row] = await db.tx((q) => q<{ state: string | null }>(`SELECT obj_description(to_regclass('schema_migrations'), 'pg_class') AS state`));
  if (!row?.state) throw behind('migrations have not run');
  const applied = new Set(JSON.parse(row.state) as string[]);
  const missing = migrations.filter((m) => !applied.has(m.id)).map((m) => m.id);
  if (missing.length) throw behind(`missing ${missing.join(', ')}`);
}

/**
 * The only way application code touches data: one transaction, as the unprivileged role,
 * with the caller's identity scoped to that transaction (SET LOCAL, so pooled connections cannot leak it).
 * Pass null for a signed-out request; policies then return nothing.
 */
export function withUser<T>(db: Database, userId: string | null, fn: (q: Q) => Promise<T>): Promise<T> {
  return db.tx(async (q) => {
    await q('SET LOCAL ROLE rangoli_app');
    await q(`SELECT set_config('app.user_id', $1, true), set_config('app.token_id', $2, true)`, [userId ?? '', tokenActor.getStore() ?? '']);
    return fn(q);
  });
}

/** Translate database refusals into something a person can act on. */
export function dbErrorMessage(e: unknown): { status: number; message: string } | null {
  const err = e as { code?: string; message?: string; constraint?: string };
  if (err.code === '42501') return { status: 403, message: 'You do not have permission to do that.' };
  if (err.code === 'P0001') return { status: 409, message: err.message ?? 'That change is not allowed.' };
  if (err.code === '23505') return { status: 409, message: 'That already exists.' };
  if (err.code === '23503') return { status: 409, message: 'That refers to something that no longer exists.' };
  if (err.code === '23514' || err.code === '22P02') return { status: 400, message: 'That value is not valid.' };
  return null;
}
