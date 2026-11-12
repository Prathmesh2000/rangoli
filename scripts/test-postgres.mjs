#!/usr/bin/env node
/**
 * Runs the database and app tests against a real Postgres server, set up the way RDS is:
 * the master account is NOT a superuser, and the app logs in as the restricted rangoli_login.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const port = Number(process.env.TEST_PG_PORT) || 54329;
const databaseDir = mkdtempSync(join(tmpdir(), 'rangoli-pg-'));
const server = new EmbeddedPostgres({ databaseDir, user: 'postgres', password: 'pw', port, persistent: false, onLog: () => undefined, onError: () => undefined });
let failed = false;
try {
  await server.initialise();
  await server.start();
  const url = (user, password, db) => `postgres://${user}:${password}@127.0.0.1:${port}/${db}`;
  const admin = new pg.Client({ connectionString: url('postgres', 'pw', 'postgres') });
  await admin.connect();
  await admin.query(`CREATE ROLE rds_master LOGIN PASSWORD 'masterpw' CREATEROLE CREATEDB NOSUPERUSER NOBYPASSRLS`);
  console.log((await admin.query('SHOW server_version')).rows[0].server_version, '— master account is not a superuser');
  for (const suite of ['rls', 'rls-matrix', 'access/capabilities', 'app']) {
    const db = `rangoli_${suite.replace(/[^a-z0-9]/g, '_')}`;
    await admin.query(`CREATE DATABASE ${db} OWNER rds_master`);
    const ownerUrl = url('rds_master', 'masterpw', db);
    // what the deployment does on first boot: migrate, then give the login role its password
    const { openDatabase } = await import('../packages/server/dist/app/db.js');
    const boot = await openDatabase({ url: ownerUrl, appPassword: 'apppw', appUrl: url('rangoli_login', 'apppw', db) });
    await boot.close();
    const r = spawnSync('npx', ['vitest', 'run', `packages/server/src/app/${suite}.test.ts`], {
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, TEST_DATABASE_URL: ownerUrl, TEST_APP_DATABASE_URL: url('rangoli_login', 'apppw', db) },
    });
    if (r.status !== 0) failed = true;
  }
  await admin.end();
} catch (e) {
  // a startup failure, such as the port already in use, must fail the run instead of passing silently
  console.error('test-postgres could not run:', e instanceof Error ? e.message : e);
  failed = true;
} finally {
  await server.stop().catch(() => undefined);
  rmSync(databaseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
process.exit(failed ? 1 : 0);
