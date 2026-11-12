import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import S3rver from 's3rver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from './db.js';
import { s3Blobs } from './infra.js';
import { startApp, type AppServer } from './server.js';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const credentials = { accessKeyId: 'S3RVER', secretAccessKey: 'S3RVER' };

async function filesUnder(dir: string): Promise<string[]> {
  const out = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return out.filter((e) => e.isFile() && !e.name.startsWith('.') && e.name.includes('.png')).map((e) => e.name);
}

describe('images in S3', () => {
  let dir = '';
  let s3: S3rver;
  let endpoint = '';
  let db: Database;
  let app: AppServer;
  let base = '';
  let org = '';
  let project = '';
  let cookie = '';

  const call = async (method: string, path: string, body?: unknown, c = cookie) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const set = r.headers.get('set-cookie');
    return { status: r.status, set, body: (await r.json().catch(() => null)) as any, r }; // eslint-disable-line @typescript-eslint/no-explicit-any
  };
  const signup = async (email: string) => (await call('POST', '/api/auth/signup', { email, name: 'N', password: 'correct horse battery' }, '')).set!.split(';')[0]!;
  const upload = () => call('POST', `/d/${project}/api/assets`, { name: 'a', dataUrl: PNG });

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rangoli-s3-'));
    s3 = new S3rver({ port: 0, address: '127.0.0.1', silent: true, directory: dir, configureBuckets: [{ name: 'designs', configs: [] }] });
    const { port } = (await s3.run()) as unknown as { port: number };
    endpoint = `http://127.0.0.1:${port}`;
    db = await openDatabase();
    app = await startApp({ db, port: 0, blobs: await s3Blobs({ bucket: 'designs', endpoint, credentials, region: 'us-east-1' }) });
    base = app.url.replace(/\/$/, '');
    cookie = await signup('a@x.io');
    org = (await call('POST', '/api/orgs', { name: 'A' })).body.id;
    project = (await call('POST', `/api/orgs/${org}/projects`, { name: 'P' })).body.id;
    await db.tx((q) => q(`UPDATE projects SET stage = 'visual' WHERE id = $1`, [project]));
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await db?.close();
    await s3?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('stores the bytes in S3 under the tenant, and only metadata in Postgres', async () => {
    const up = await upload();
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    const [row] = await db.tx((q) => q(`SELECT bytes, storage, size FROM design_assets WHERE project_id = $1`, [project]));
    expect(row).toMatchObject({ bytes: null, storage: 's3' });
    expect(row.size).toBeGreaterThan(0);
    const direct = await s3Blobs({ bucket: 'designs', endpoint, credentials, region: 'us-east-1' });
    expect(await direct.get(`orgs/${org}/projects/${project}/assets/${up.body.file}`)).toBeInstanceOf(Buffer);
  });

  it('serves it through the app, and the database still decides who gets it', async () => {
    const file = (await upload()).body.file;
    const ok = await fetch(`${base}/d/${project}/assets/${file}`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toMatch(/^private/);
    expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(0);
    const outsider = await signup('b@x.io');
    expect((await fetch(`${base}/d/${project}/assets/${file}`, { headers: { cookie: outsider } })).status).toBe(404);
    expect((await fetch(`${base}/d/${project}/assets/${file}`)).status).toBe(401);
  });

  it('embeds S3 images in the sandboxed prototype', async () => {
    const meta = (await upload()).body;
    await call('POST', `/d/${project}/api/rdl`, { script: `Frame name:Hero w200 h200\n  Image asset:${meta.id} fit:cover alt:"x" w100 h100` });
    const html = await (await fetch(`${base}/d/${project}/`, { headers: { cookie } })).text();
    expect(html).toContain('data:image/png;base64');
  });

  it('survives a restart with a cold cache', async () => {
    await new Promise((r) => setTimeout(r, 300));
    await app.close();
    app = await startApp({ db, port: 0, blobs: await s3Blobs({ bucket: 'designs', endpoint, credentials, region: 'us-east-1' }) });
    base = app.url.replace(/\/$/, '');
    const html = await (await fetch(`${base}/d/${project}/`, { headers: { cookie } })).text();
    expect(html).toContain('data:image/png;base64');
  });

  it('keeps reading images stored before S3 was switched on', async () => {
    await db.tx((q) => q(`INSERT INTO design_assets (project_id, org_id, file, mime, bytes) VALUES ($1, $2, 'aaaaaaaaaaaa.png', 'image/png', $3)`, [project, org, Buffer.from([9, 9])]));
    const old = await fetch(`${base}/d/${project}/assets/aaaaaaaaaaaa.png`, { headers: { cookie } });
    expect(old.status).toBe(200);
    expect([...new Uint8Array(await old.arrayBuffer())]).toEqual([9, 9]);
  });

  it('removes the row again if S3 refuses the upload', async () => {
    const broken = await startApp({ db, port: 0, blobs: { put: async () => { throw new Error('S3 down'); }, get: async () => null, deletePrefix: async () => undefined } });
    const other = (await fetch(broken.url + `api/orgs/${org}/projects`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'Q' }) }).then((r) => r.json()) as { id: string }).id;
    await db.tx((q) => q(`UPDATE projects SET stage = 'visual' WHERE id = $1`, [other]));
    const r = await fetch(`${broken.url}d/${other}/api/assets`, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ name: 'a', dataUrl: PNG }) });
    expect(r.status).toBe(400);
    expect(await db.tx((q) => q(`SELECT 1 FROM design_assets WHERE project_id = $1`, [other]))).toHaveLength(0);
    await broken.close();
  });

  it('deleting a project deletes its images from S3', async () => {
    expect((await filesUnder(dir)).length).toBeGreaterThan(0);
    expect((await call('DELETE', `/api/projects/${project}`)).status).toBe(200);
    const direct = await s3Blobs({ bucket: 'designs', endpoint, credentials, region: 'us-east-1' });
    const files = await db.tx((q) => q(`SELECT 1 FROM design_assets WHERE project_id = $1`, [project]));
    expect(files).toHaveLength(0);
    expect(await direct.get(`orgs/${org}/projects/${project}/assets/nope.png`)).toBeNull();
    expect((await filesUnder(dir)).length).toBe(0);
  });
});
