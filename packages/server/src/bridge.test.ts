import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '../dist/cli.js');

describe('one process per document: agents attach to a running editor server', () => {
  let dir: string;
  let doc: string;
  let serve: ChildProcess;
  let base = '';

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rangoli-bridge-'));
    doc = join(dir, 'app.rangoli');
    spawnSync(process.execPath, [CLI, 'init', doc]);
    serve = spawn(process.execPath, [CLI, 'serve', doc, '--port', '4961'], { stdio: ['ignore', 'ignore', 'pipe'] });
    base = await new Promise<string>((res, rej) => {
      const t = setTimeout(() => rej(new Error('serve did not start')), 15000);
      serve.stderr!.on('data', (b: Buffer) => {
        const m = /editor: (http:\/\/127\.0\.0\.1:\d+\/)editor\//.exec(b.toString());
        if (m) {
          clearTimeout(t);
          res(m[1]!);
        }
      });
    });
  }, 30000);

  afterAll(async () => {
    serve?.kill();
    await new Promise((r) => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true });
  });

  it('a second serve on the same document is refused', () => {
    const r = spawnSync(process.execPath, [CLI, 'serve', doc, '--port', '4971'], { encoding: 'utf8', timeout: 15000 });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('already open in another Rangoli process');
  });

  it('rangoli mcp bridges to the running server: same document, same history, agent in presence', async () => {
    const client = new Client({ name: 'bridge-test', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', doc], stderr: 'pipe' }));
    try {
      expect(client.getInstructions()).toContain('RDL quick reference');
      const r = (await client.callTool({ name: 'rdl_apply', arguments: { script: 'Card col p4 fill:surface\n  Text body "via bridge"', label: 'bridged edit' } })) as { content: { text: string }[] };
      expect(r.content[0]!.text).toContain('created: #n1');
      // the edit landed in the SERVER process (single writer)
      const d = (await (await fetch(base + 'api/doc')).json()) as { data: { pages: { p1: { nodes: Record<string, { text?: string }> } } }; history: { label: string; author: string }[]; presence: { name: string }[] };
      expect(d.data.pages.p1.nodes.n2!.text).toBe('via bridge');
      expect(d.history.at(-1)).toMatchObject({ label: 'bridged edit', author: 'agent' });
      expect(d.presence.some((p) => p.name === 'Agent')).toBe(true);
      // human edits in the editor are visible to the agent immediately
      await fetch(base + 'api/rdl', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ script: 'set #n2 "edited by human"' }) });
      const g = (await client.callTool({ name: 'node_get', arguments: { ids: ['n2'] } })) as { content: { text: string }[] };
      expect(g.content[0]!.text).toContain('edited by human');
    } finally {
      await client.close();
    }
  }, 30000);

  it('/mcp rejects non-owner and cross-origin access', async () => {
    const r = await fetch(base + 'mcp', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    expect(r.status).toBe(403);
  });
});
