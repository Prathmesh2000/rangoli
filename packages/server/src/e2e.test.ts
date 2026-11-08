import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI = resolve(__dirname, '../dist/cli.js');

describe('MCP end-to-end (real stdio process)', () => {
  let dir: string;
  let client: Client;
  let previewUrl = '';
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: !!r.isError };
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'rangoli-e2e-'));
    const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp', join(dir, 'app.rangoli'), '--port', '4917'], stderr: 'pipe' });
    client = new Client({ name: 'test-agent', version: '1.0.0' });
    await client.connect(transport);
  }, 30000);

  afterAll(async () => {
    await client?.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('exposes instructions and the tool surface', async () => {
    expect(client.getInstructions()).toContain('RDL quick reference');
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ['doc_info', 'doc_outline', 'node_get', 'rdl_apply', 'rdl_check', 'lint', 'tokens_get', 'tokens_set_brand', 'render_preview', 'undo', 'export', 'selection_get']) expect(names).toContain(n);
  });

  it('agent designs a screen, gets lint feedback, fixes it, previews it', async () => {
    const info = await call('doc_info');
    previewUrl = /Live preview: (\S+)/.exec(info.text)?.[1] ?? '';
    expect(previewUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const created = await call('rdl_apply', {
      label: 'test runs screen',
      script: `
Runs col gap6 p6 w960 fill:canvas
  Header row between center
    Text headline "Test runs"
    @Button variant=primary "New run"
  Card col gap3 p4 fill:surface stroke:border r3
    Row row between center
      Text title-sm "Login smoke test"
      @Chip variant=success "Passed"
    Text body-sm muted "Last run 2 hours ago"
    @Button variant=primary size=sm "Run again"`,
    });
    expect(created.isError).toBe(false);
    expect(created.text).toContain('created: #n1');
    expect(created.text).toContain('D09'); // two primary buttons flagged immediately
    const fix = /fix: (set #\S+ variant=secondary)/.exec(created.text)?.[1];
    expect(fix).toBeTruthy();

    const fixed = await call('rdl_apply', { script: fix! });
    expect(fixed.text).toContain('Lint: clean');

    const outline = await call('doc_outline');
    expect(outline.text.split('\n')[0]).toBe('Runs#n1 frame');

    const compact = await call('node_get', { ids: ['n5'] });
    expect(compact.text.split('\n')[0]).toBe('Card#n5 gap3 p4 fill:surface stroke:border r3');
    expect(compact.text).toContain('@Button#na variant=secondary size=sm "Run again"');

    const bad = await call('rdl_apply', { script: 'set #n99 gap3' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('#n99 not found');

    const preview = await call('render_preview', { mode: 'dark' });
    const file = /→ (.+preview-dark\.html)/.exec(preview.text)?.[1];
    expect(await readFile(file!, 'utf8')).toContain('data-mode="dark"');

    // live preview server serves the design
    const html = await (await fetch(previewUrl)).text();
    expect(html).toContain('Test runs');
    expect(html).toContain('data-rid="n1"');

    // human selects a node in the browser → agent sees it
    const jsonHeaders = { 'content-type': 'application/json' };
    await fetch(previewUrl + 'select', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ ids: ['n9'] }) });
    const selection = await call('selection_get');
    expect(selection.text).toContain('#n9');

    // security: cross-site and non-JSON writes are rejected
    const evil = await fetch(previewUrl + 'api/rdl', { method: 'POST', headers: { ...jsonHeaders, origin: 'https://evil.example' }, body: JSON.stringify({ script: 'delete #n1' }) });
    expect(evil.status).toBe(403);
    const simple = await fetch(previewUrl + 'api/rdl', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ script: 'delete #n1' }) });
    expect(simple.status).toBe(403);

    // human edit through the editor API shares history with the agent
    const human = await fetch(previewUrl + 'api/rdl', { method: 'POST', headers: jsonHeaders, body: JSON.stringify({ script: 'set #n3 "Test runs (human)"', label: 'rename' }) });
    expect(human.status).toBe(200);
    const docRes = (await (await fetch(previewUrl + 'api/doc')).json()) as { data: { pages: Record<string, { nodes: Record<string, { text?: string }> }> }; history: { author: string }[] };
    expect(docRes.data.pages.p1!.nodes.n3!.text).toBe('Test runs (human)');
    expect(docRes.history.at(-1)!.author).toBe('human');
    await fetch(previewUrl + 'api/undo', { method: 'POST', headers: jsonHeaders, body: '{}' });

    // undo / history
    const hist = await call('history');
    expect(hist.text).toContain('agent: test runs screen');
    await call('undo'); // reverts the lint fix
    const after = await call('node_get', { ids: ['na'] });
    expect(after.text).toContain('@Button#na variant=primary');
  }, 30000);

  it('rebrands the token system and keeps contrast', async () => {
    const r = await call('tokens_set_brand', { brand: '#0f766e' });
    expect(r.text).toMatch(/light: button text \d+\.\d+:1 (AA|AAA)/);
    expect(r.text).toMatch(/dark: button text \d+\.\d+:1 (AA|AAA)/);
    const c = await call('contrast_check', { fg: 'text.secondary', bg: 'surface' });
    expect(c.text).toMatch(/light: \d+\.\d+:1 (AA|AAA)/);
  });

  it('persists to disk (autosave)', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const page = JSON.parse(await readFile(join(dir, 'app.rangoli', 'pages', 'p1.json'), 'utf8')) as { nodes: Record<string, unknown> };
    expect(Object.keys(page.nodes).length).toBeGreaterThan(5);
  });
});
