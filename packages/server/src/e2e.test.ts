import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('motion: preset, curve as numbers, lint, export', async () => {
    const preset = await call('motion_preset', { target: '#n5', preset: 'listItem' });
    expect(preset.isError).toBe(false);
    expect(preset.text).toContain('Motion lint: clean');
    const curve = await call('motion_curve', { target: '#n5', trigger: 'enter' });
    expect(curve.text).toMatch(/enter \(200ms, out\)\n {2}opacity: 0 [\d. ]+ 1\n {2}y: 4 [\d. ]+ 0\n {2}t\(ms\): 0 40 80 120 160 200/);
    const draft = await call('motion_curve', { draft: 'enter opacity:0 base spring:snappy' });
    expect(draft.text).toMatch(/enter \(\d+ms, spring:snappy\)/);
    const slop = await call('rdl_apply', { script: 'motion #n5\n  hover y:-4, shadow:lg 300ms out' });
    expect(slop.text).toContain('M11');
    const get = await call('motion_get', { targets: ['#n5'] });
    expect(get.text).toContain('motion #n5');
    const out = join(dir, 'motion.css');
    await call('export', { format: 'css-motion', outFile: out });
    expect(await readFile(out, 'utf8')).toContain('@keyframes rg-n5-enter');
  });

  it('collaboration: suggest mode, accept/reject, inbox, review pins, versions + diff', async () => {
    const H = { 'content-type': 'application/json' };
    const post = (p: string, b: unknown) => fetch(previewUrl + p, { method: 'POST', headers: H, body: JSON.stringify(b) });

    const v1 = await call('version_save', { name: 'before review' });
    expect(v1.text).toContain('Saved v1');

    // owner switches agent to suggest mode → rdl_apply no longer changes the design
    expect((await post('api/mode', { mode: 'suggest' })).status).toBe(200);
    const sug = await call('rdl_apply', { script: 'set #n3 "Test runs (suggested)"', label: 'rename title' });
    expect(sug.text).toContain('Saved as suggestion cs1 — NOT applied');
    expect(sug.text).toContain('~ #n3 [text]');
    expect((await call('node_get', { ids: ['n3'] })).text).toContain('"Test runs"');

    const sug2 = await call('suggest', { script: 'set #n6 fill:subtle', label: 'quieter card' });
    expect(sug2.text).toContain('cs2');
    const d = await call('diff', { from: 'cs2' });
    expect(d.text).toContain('~ #n6 [style]');

    // human accepts cs1, rejects cs2
    expect((await post('api/changesets/cs1/accept', {})).status).toBe(200);
    expect((await call('node_get', { ids: ['n3'] })).text).toContain('Test runs (suggested)');
    expect((await post('api/changesets/cs2/reject', {})).status).toBe(200);
    expect((await call('suggestions_list', {})).text).toMatch(/cs1 \[accepted\][\s\S]*cs2 \[rejected\]/);
    // accepted change is one undoable step attributed to the human + agent
    expect((await call('history', { limit: 1 })).text).toContain('accepted agent');
    await post('api/mode', { mode: 'direct' });

    // human mentions @agent → inbox → agent replies → inbox clears
    const th = (await (await post('api/threads', { node: 'n5', body: '@agent can this card be less boxy?' })).json()) as { id: string };
    expect((await call('inbox')).text).toContain(th.id);
    await call('comment', { action: 'reply', thread: th.id, body: 'Suggest removing the border and using spacing instead.' });
    expect((await call('inbox')).text).toBe('Inbox empty.');

    // reviewer posts findings with fixes; invalid fix is rejected up front
    const bad = await call('review_add', { findings: [{ node: 'n5', severity: 'P2', message: 'x', fix: 'set #n5 gap99' }] });
    expect(bad.isError).toBe(true);
    const rv = await call('review_add', { title: 'Darshana review', findings: [{ node: 'n5', severity: 'P2', message: 'Card border + fill is heavy; rely on spacing', fix: 'set #n5 stroke:none' }] });
    expect(rv.text).toMatch(/Posted 1 review pins: t\d+/);
    const reviews = (await (await fetch(previewUrl + 'api/reviews')).json()) as { threads: { kind: string; fix?: string }[] };
    expect(reviews.threads.some((t) => t.kind === 'review' && t.fix === 'set #n5 stroke:none')).toBe(true);

    // diff against the saved version shows the accepted rename
    const dv = await call('diff', { from: 'v1' });
    expect(dv.text).toContain('now: Text#n3 headline "Test runs (suggested)"');
  });

  it('prototype: interactions, timeline, export, /play, and the agent can SEE (png + filmstrip)', async () => {
    // invalid target → whole script rejected atomically
    const bad = await call('rdl_apply', { script: 'proto #na\n  click navigate #nope smart' });
    expect(bad.isError).toBe(true);
    const created = await call('rdl_apply', { script: 'Detail col w480 h320 p6 fill:canvas\n  Title text headline "Login smoke test"' });
    const detail = /created: #(\w+)/.exec(created.text)![1]!;
    const ok = await call('rdl_apply', { script: `timeline intro\n  #n7 0 opacity:0, y:sm base out\nproto start #n1\nproto #na\n  click navigate #${detail} smart base out\nproto #n7\n  click play timeline:intro` });
    expect(ok.isError).toBe(false);
    expect((await call('proto_get')).text).toContain(`click navigate #${detail} smart base out`);

    const out = join(dir, 'proto.html');
    const exp = await call('prototype_export', { outFile: out });
    expect(exp.text).toMatch(/Wrote prototype \(\d+ KB\)/);
    expect(await readFile(out, 'utf8')).toContain('window.__RP__=');
    const play = await (await fetch(previewUrl + 'play')).text();
    expect(play).toContain(`data-screen="${detail}"`);

    const png = (await client.callTool({ name: 'render_png', arguments: { roots: ['n1'] } })) as { content: { type: string; data?: string; mimeType?: string }[] };
    expect(png.content[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(png.content[0]!.data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
    await call('rdl_apply', { script: 'motion #n5\n  enter opacity:0, y:md base out' });
    const film = (await client.callTool({ name: 'motion_filmstrip', arguments: { target: '#n5', frames: 4 } })) as { content: { type: string; text?: string }[] };
    expect(film.content[0]!.type).toBe('image');
    expect(film.content[1]!.text).toContain('frames at 0, 67, 133, 200 ms');
    const tlFilm = (await client.callTool({ name: 'motion_filmstrip', arguments: { target: 'timeline:intro' } })) as { content: { type: string }[] };
    expect(tlFilm.content[0]!.type).toBe('image');
  }, 60000);

  it('icons: list, draft variants, render sheet with lint, use in design, export', async () => {
    expect((await call('icon_list')).text).toMatch(/^ui \(grid24 stroke1\.5 round\): search plus close/);
    const got = await call('icon_get', { names: ['clock'] });
    expect(got.text).toBe('icon ui/clock\n  circle 12 12 8.5\n  polyline 12 7.5 12 12 15 14');
    const drafts = await call('rdl_apply', { script: 'icon drafts/run~1\n  path M8 5.5 L18.5 12 L8 18.5 Z\nicon drafts/run~2 stroke2\n  path M7 4 L20 12 L7 20 Z' });
    expect(drafts.isError).toBe(false);
    const sheet = (await client.callTool({ name: 'icon_render', arguments: { names: ['drafts/run~1', 'drafts/run~2'] } })) as { content: { type: string; text?: string }[] };
    expect(sheet.content[0]!.type).toBe('image');
    expect(sheet.content[1]!.text).toContain('I03 drafts/run~2 stroke 2 differs'); // lint travels with the picture
    const use = await call('rdl_apply', { script: 'insert #na start\n  Icon icon:retry w16 h16' });
    expect(use.text).toMatch(/created: #\w+/);
    expect(use.text).not.toContain('D16'); // icon reference resolves
    const outDir = join(dir, 'icons-react');
    expect((await call('icon_export', { set: 'ui', format: 'react', outDir })).text).toContain('React components + index.ts');
    expect(await readFile(join(outDir, 'ClockIcon.tsx'), 'utf8')).toContain('export function ClockIcon(');
    expect(await readFile(join(outDir, 'index.ts'), 'utf8')).toContain("export { RetryIcon } from './RetryIcon';");
  }, 60000);

  it('images: upload, edit to webp, use with alt lint, compose + export, served safely', async () => {
    // make a real PNG with the tool itself
    const shot = (await client.callTool({ name: 'render_png', arguments: { roots: ['n1'] } })) as { content: { data: string }[] };
    const pngPath = join(dir, 'runs-screen.png');
    await writeFile(pngPath, Buffer.from(shot.content[0]!.data, 'base64'));

    const up = await call('asset_upload', { path: pngPath, name: 'runs-screen.png' });
    const id = /Asset (\w{12}) "runs-screen.png" (\d+)×(\d+)/.exec(up.text);
    expect(id).toBeTruthy();
    const [, assetId, w, h] = id!;
    expect((await call('asset_upload', { path: join(dir, 'app.rangoli', 'manifest.json') })).isError).toBe(true); // images only
    // same bytes → same asset (content-addressed)
    expect((await call('asset_upload', { path: pngPath })).text).toContain(assetId!);

    const edited = (await client.callTool({ name: 'image_edit', arguments: { asset: assetId, ops: [{ op: 'crop', x: 0, y: 0, w: Math.floor(+w! / 2), h: Math.floor(+h! / 2) }, { op: 'resize', w: 300 }], format: 'webp', quality: 80 } })) as { content: { type: string; text?: string }[] };
    expect(edited.content[0]!.type).toBe('image');
    const editedId = /New asset (\w{12}) ".*-edit\.webp" 300×\d+/.exec(edited.content[1]!.text!)?.[1];
    expect(editedId).toBeTruthy();
    expect((await call('asset_list')).text).toContain(`${editedId} "runs-screen-edit.webp" 300×`);

    const used = await call('rdl_apply', { script: `insert #n1 end\n  Image asset:${editedId} w300 h150 fit:cover` });
    expect(used.text).toContain('A01'); // no alt
    const node = /created: #(\w+)/.exec(used.text)![1]!;
    expect((await call('rdl_apply', { script: `set #${node} alt:"Cropped test runs table"` })).text).not.toContain('A01');

    const tpl = await call('image_template', { kind: 'social-card', title: 'Rangoli' });
    const frame = /Created #(\w+)/.exec(tpl.text)![1]!;
    const exp = (await client.callTool({ name: 'image_export', arguments: { frame, format: 'png', scale: 1, saveAsAsset: true, outFile: join(dir, 'og.png') } })) as { content: { type: string; text?: string }[] };
    expect(exp.content[0]!.type).toBe('image');
    expect(exp.content[1]!.text).toMatch(/^1200×630 [\d.]+ KB png · → .*og\.png · asset \w{12}$/);

    const meta = Object.values(((await (await fetch(previewUrl + 'api/doc')).json()) as { data: { assets: Record<string, { file: string; id: string }> } }).data.assets).find((a) => a.id === editedId)!;
    const served = await fetch(previewUrl + 'assets/' + meta.file);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await fetch(previewUrl + 'assets/..%2Fmanifest.json')).status).toBe(404);
  }, 90000);

  it('persists to disk (autosave)', async () => {
    await new Promise((r) => setTimeout(r, 400));
    const page = JSON.parse(await readFile(join(dir, 'app.rangoli', 'pages', 'p1.json'), 'utf8')) as { nodes: Record<string, unknown> };
    expect(Object.keys(page.nodes).length).toBeGreaterThan(5);
  });
});
