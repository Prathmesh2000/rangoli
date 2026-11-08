import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPreview, type PreviewServer } from './http.js';
import { Session } from './session.js';

/**
 * Connect via this machine's LAN address: the server sees a non-loopback client,
 * exactly like a teammate on the network. Skipped when there is no LAN interface.
 */
describe('sharing & roles', () => {
  let dir: string;
  let session: Session;
  let srv: PreviewServer;
  let lanBase = '';
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rangoli-roles-'));
    session = await Session.create(join(dir, 'd.rangoli'), 'Roles');
    session.doc.apply([{ op: 'create', node: { id: '', type: 'frame', name: 'Card' } }]);
    srv = await startPreview(session, { port: 4931, share: true });
    lanBase = srv.lanUrls[0] ?? '';
    for (const r of ['editor', 'reviewer', 'viewer'] as const) tokens[r] = session.createShareToken(r);
  });
  afterAll(async () => {
    await srv?.close();
    await session?.flush();
    await rm(dir, { recursive: true, force: true });
  });

  const req = (path: string, token?: string, body?: unknown) =>
    fetch(lanBase + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { cookie: `rangoli_t=${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('requires an invite for network clients', async () => {
    if (!lanBase) return;
    expect((await req('api/doc')).status).toBe(401);
    expect((await req('api/doc', 'not-a-token')).status).toBe(401);
    // ?t= sets an HttpOnly, SameSite=Strict cookie
    const r = await fetch(`${lanBase}editor/?t=${tokens.viewer}`);
    expect(r.headers.get('set-cookie')).toMatch(/rangoli_t=.+; HttpOnly; SameSite=Strict/);
  });

  it('viewer can read but not comment or edit', async () => {
    if (!lanBase) return;
    const doc = (await (await req('api/doc', tokens.viewer)).json()) as { role: string; dir: string };
    expect(doc.role).toBe('viewer');
    expect(doc.dir).toBe(''); // file paths are never exposed to guests
    expect((await req('api/threads', tokens.viewer, { node: 'n1', body: 'hi' })).status).toBe(403);
    expect((await req('api/rdl', tokens.viewer, { script: 'set #n1 gap3' })).status).toBe(403);
  });

  it('reviewer can comment and suggest, not edit or decide', async () => {
    if (!lanBase) return;
    expect((await req('api/threads', tokens.reviewer, { node: 'n1', body: 'looks good' })).status).toBe(200);
    expect((await req('api/changesets', tokens.reviewer, { script: 'set #n1 gap3', label: 'tighten' })).status).toBe(200);
    expect((await req('api/rdl', tokens.reviewer, { script: 'set #n1 gap3' })).status).toBe(403);
    expect((await req('api/changesets/cs1/accept', tokens.reviewer, {})).status).toBe(403);
  });

  it('editor can edit and accept, but not change agent mode or see invites', async () => {
    if (!lanBase) return;
    expect((await req('api/rdl', tokens.editor, { script: 'set #n1 gap2' })).status).toBe(200);
    expect((await req('api/changesets/cs1/accept', tokens.editor, {})).status).toBe(200);
    expect(session.doc.node('n1').layout?.gap).toEqual({ token: 'space.3' });
    expect((await req('api/mode', tokens.editor, { mode: 'suggest' })).status).toBe(403);
    expect((await req('api/share', tokens.editor)).status).toBe(403);
    // edits are attributed by name
    await fetch(lanBase + 'api/rdl', { method: 'POST', headers: { cookie: `rangoli_t=${tokens.editor}`, 'content-type': 'application/json', 'x-rangoli-name': 'Asha' }, body: JSON.stringify({ script: 'set #n1 gap4', label: 'more air' }) });
    expect(session.doc.historyEntries.at(-1)!.author).toBe('human:Asha');
  });

  it('owner on loopback sees invite links', async () => {
    const share = (await (await fetch(srv.url + 'api/share')).json()) as { sharing: boolean; links: { role: string; urls: string[] }[] };
    expect(share.sharing).toBe(true);
    expect(share.links.map((l) => l.role).sort()).toEqual(['editor', 'reviewer', 'viewer']);
  });

  it('cross-origin writes are rejected even with a valid token', async () => {
    if (!lanBase) return;
    const r = await fetch(lanBase + 'api/rdl', { method: 'POST', headers: { cookie: `rangoli_t=${tokens.editor}`, 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ script: 'delete #n1' }) });
    expect(r.status).toBe(403);
  });
});
