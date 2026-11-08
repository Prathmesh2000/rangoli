import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  applyRdl,
  compileRdl,
  contrastRatio,
  defaultTokens,
  formatLint,
  generateCategorical,
  generateNeutralRamp,
  generateRamp,
  lint,
  renderDocument,
  serializeRdl,
  TokenResolver,
  tokensToCss,
  wcagLevel,
  type LintIssue,
  type RNode,
} from '@rangoli/engine';
import { INSTRUCTIONS, RDL_HELP } from './guide.js';
import type { Session } from './session.js';

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const fail = (e: unknown) => ({ content: [{ type: 'text' as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

export interface McpOptions {
  previewUrl?: string;
  author?: string;
}

export function createMcpServer(session: Session, opts: McpOptions = {}): McpServer {
  const server = new McpServer({ name: 'rangoli', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const doc = session.doc;
  const author = opts.author ?? 'agent';

  const safe =
    <A>(fn: (args: A) => Promise<ReturnType<typeof text>> | ReturnType<typeof text>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (e) {
        return fail(e);
      }
    };

  /** root ancestors of nodes, for scoping lint */
  const rootsOf = (ids: string[], page?: string): string[] => {
    const p = doc.page(page);
    const roots = new Set<string>();
    for (const id of ids) {
      let n: RNode | undefined = p.nodes[id];
      while (n?.parent) n = p.nodes[n.parent];
      if (n) roots.add(n.id);
    }
    return [...roots];
  };

  const pageArg = z.string().optional().describe('page id (default: first page)');

  server.registerTool(
    'rdl_help',
    { description: 'Full RDL language reference and lint code list. Call once if unsure about syntax.', inputSchema: {} },
    safe(() => text(RDL_HELP)),
  );

  server.registerTool(
    'doc_info',
    { description: 'Document summary: pages, node counts, components, token groups, preview URL.', inputSchema: {} },
    safe(() => {
      const d = doc.data;
      const pages = d.manifest.pages.map((p) => `${p.id} "${p.name}" ${Object.keys(d.pages[p.id]?.nodes ?? {}).length} nodes, ${d.pages[p.id]?.children.length ?? 0} roots`);
      const groups = Object.keys(d.tokens).join(', ');
      return text(
        [
          `Document: ${d.manifest.name}  (${session.dir})`,
          `Pages: ${pages.join(' · ')}`,
          `Components: ${Object.values(d.components).map((c) => `@${c.name}(${Object.entries(c.axes).map(([k, v]) => `${k}:${v.join('|')}`).join(', ')})`).join(' ')}`,
          `Token groups: ${groups}`,
          opts.previewUrl ? `Live preview: ${opts.previewUrl}` : '',
          opts.previewUrl ? `Editor (for the human): ${opts.previewUrl}editor/` : '',
          `History: ${doc.historyEntries.length} changes`,
        ].filter(Boolean).join('\n'),
      );
    }),
  );

  server.registerTool(
    'doc_outline',
    {
      description: 'Cheapest read: tree of names/ids/types (≈5 tokens per node). Use before node_get.',
      inputSchema: { page: pageArg, depth: z.number().int().min(0).optional().describe('max depth (default all)') },
    },
    safe(({ page, depth }) => text(serializeRdl(doc, { page, detail: 'outline', depth }) || '(empty page)')),
  );

  server.registerTool(
    'node_get',
    {
      description: 'Read nodes as compact RDL (default) or raw JSON. Pass ids of subtrees to read.',
      inputSchema: {
        ids: z.array(z.string()).optional().describe('node ids without # (default: all roots)'),
        detail: z.enum(['outline', 'compact', 'json']).optional(),
        depth: z.number().int().min(0).optional(),
        page: pageArg,
      },
    },
    safe(({ ids, detail, depth, page }) => {
      if (detail === 'json') {
        const p = doc.page(page);
        const out: Record<string, RNode> = {};
        const collect = (id: string, d: number) => {
          const n = p.nodes[id];
          if (!n) throw new Error(`#${id} not found`);
          out[id] = n;
          if (depth === undefined || d < depth) for (const c of n.children ?? []) collect(c, d + 1);
        };
        for (const id of ids ?? p.children) collect(id, 0);
        return text(JSON.stringify(out));
      }
      return text(serializeRdl(doc, { roots: ids, page, detail: detail ?? 'compact', depth }) || '(nothing)');
    }),
  );

  server.registerTool(
    'search_nodes',
    {
      description: 'Find nodes by text/name substring, type, component or role. Returns outline lines.',
      inputSchema: {
        query: z.string().optional(),
        type: z.enum(['frame', 'text', 'vector', 'image', 'instance', 'group']).optional(),
        component: z.string().optional(),
        role: z.string().optional(),
        page: pageArg,
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    safe(({ query, type, component, role, page, limit }) => {
      const q = query?.toLowerCase();
      const hits: string[] = [];
      for (const { node: n } of doc.walk(undefined, page)) {
        if (type && n.type !== type) continue;
        if (component && n.component !== component) continue;
        if (role && n.role !== role) continue;
        if (q && !(`${n.name} ${n.text ?? ''} ${Object.values(n.props ?? {}).join(' ')}`.toLowerCase().includes(q))) continue;
        hits.push(serializeRdl(doc, { roots: [n.id], page, detail: 'outline', depth: 0 }));
        if (hits.length >= (limit ?? 50)) break;
      }
      return text(hits.length ? hits.join('\n') : 'No matches.');
    }),
  );

  server.registerTool(
    'rdl_apply',
    {
      description:
        'Create or edit design with an RDL script (atomic, one undo step). Plain node lines create new nodes (under `parent` if given); ' +
        'commands: set/insert/move/delete/replace. Returns created ids and lint issues for affected screens.',
      inputSchema: {
        script: z.string().describe('RDL script'),
        parent: z.string().optional().describe('parent id for top-level created nodes'),
        page: pageArg,
        label: z.string().optional().describe('short change description for history'),
      },
    },
    safe(({ script, parent, page, label }) => {
      const res = applyRdl(doc, script, { parent, page, author, label });
      const roots = rootsOf(res.touched.filter((t) => !t.startsWith('$')), page);
      const issues = roots.length ? lint(doc, { page, roots }) : [];
      const important = issues.filter((i) => i.severity === 'P0' || i.severity === 'P1' || i.severity === 'P2');
      return text(
        [
          `OK. ${res.created.length ? `created: ${res.created.map((c) => `#${c}`).join(' ')}` : 'no new nodes'} · touched ${res.touched.length}`,
          important.length ? `Lint (${important.length}):\n${formatLint(important)}` : 'Lint: clean (P0–P2).',
          opts.previewUrl ? `Preview: ${opts.previewUrl}` : '',
        ].filter(Boolean).join('\n'),
      );
    }),
  );

  server.registerTool(
    'rdl_check',
    { description: 'Dry run: validate an RDL script against the current document without applying it.', inputSchema: { script: z.string(), parent: z.string().optional(), page: pageArg } },
    safe(({ script, parent, page }) => {
      const res = compileRdl(doc, script, { parent, page });
      const errs = res.errors.filter((e) => e.severity === 'error');
      return text(errs.length ? errs.map((e) => `line ${e.line}: ${e.message}`).join('\n') : `Valid. Would apply ${res.ops.length} ops, create ${res.created.length} nodes.`);
    }),
  );

  server.registerTool(
    'undo',
    { description: 'Undo the last change (any author).', inputSchema: {} },
    safe(() => {
      const e = doc.undo();
      return text(e ? `Undid #${e.seq} ${e.label ?? ''} by ${e.author}` : 'Nothing to undo.');
    }),
  );

  server.registerTool(
    'redo',
    { description: 'Redo the last undone change.', inputSchema: {} },
    safe(() => {
      const e = doc.redo();
      return text(e ? `Redid #${e.seq} ${e.label ?? ''}` : 'Nothing to redo.');
    }),
  );

  server.registerTool(
    'history',
    { description: 'Recent changes with author and label.', inputSchema: { limit: z.number().int().min(1).max(100).optional() } },
    safe(({ limit }) => {
      const h = doc.historyEntries.slice(-(limit ?? 10));
      return text(h.length ? h.map((e) => `#${e.seq} ${new Date(e.time).toISOString().slice(11, 19)} ${e.author}: ${e.label ?? `${e.ops.length} ops`} (${e.touched.length} touched)`).join('\n') : 'No history.');
    }),
  );

  server.registerTool(
    'lint',
    {
      description: 'Deterministic design lint (AI-slop tells, tokens, spacing scale, contrast in light+dark, hierarchy, a11y). Issues include ready "fix:" RDL.',
      inputSchema: { roots: z.array(z.string()).optional(), page: pageArg, minSeverity: z.enum(['P0', 'P1', 'P2', 'P3']).optional() },
    },
    safe(({ roots, page, minSeverity }) => {
      const order = { P0: 0, P1: 1, P2: 2, P3: 3 } as const;
      const max = order[minSeverity ?? 'P3'];
      const issues: LintIssue[] = lint(doc, { page, roots }).filter((i) => order[i.severity] <= max);
      return text(formatLint(issues));
    }),
  );

  server.registerTool(
    'tokens_get',
    {
      description: 'List design tokens (resolved values) under a group, e.g. "color.status", "space", "textStyle". Without group: group summary.',
      inputSchema: { group: z.string().optional(), mode: z.string().optional().describe('light | dark | reduced …') },
    },
    safe(({ group, mode }) => {
      const r = new TokenResolver(doc.data.tokens);
      if (!group) {
        const counts = new Map<string, number>();
        for (const p of r.flat.keys()) {
          const g = p.split('.').slice(0, 2).join('.');
          counts.set(g, (counts.get(g) ?? 0) + 1);
        }
        return text([...counts].map(([g, c]) => `${g} (${c})`).join('\n'));
      }
      const lines = r.group(group).map((t) => {
        const v = r.resolve(t.path, mode ?? 'light');
        const alias = typeof t.value === 'string' && t.value.startsWith('{') ? ` ← ${t.value}` : '';
        return `${t.path} = ${typeof v === 'object' ? JSON.stringify(v) : String(v)}${alias}`;
      });
      return text(lines.length ? lines.join('\n') : `No tokens under "${group}".`);
    }),
  );

  server.registerTool(
    'tokens_set_brand',
    {
      description: 'Regenerate the whole token system (OKLCH ramps, tinted neutrals, semantic tokens, light/dark) from brand/status seed colors. Undoable.',
      inputSchema: {
        brand: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        success: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        warning: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
        error: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
      },
    },
    safe(({ brand, success, warning, error }) => {
      const tokens = defaultTokens({ brand, success, warning, error });
      doc.apply([{ op: 'setTokens', tokens }], { author, label: `brand ${brand}` });
      const r = new TokenResolver(tokens);
      const checks = ['light', 'dark'].map((m) => {
        const c = contrastRatio(r.resolve('color.text.onPrimary', m) as string, r.resolve('color.action.primary', m) as string);
        return `${m}: button text ${c.toFixed(2)}:1 ${wcagLevel(c)}`;
      });
      return text(`Tokens regenerated from ${brand}.\n${checks.join('\n')}`);
    }),
  );

  server.registerTool(
    'token_set',
    {
      description: 'Set one token value (optionally for a mode). Value may be an alias like "{color.neutral.600}".',
      inputSchema: { path: z.string(), value: z.union([z.string(), z.number()]), mode: z.string().optional(), type: z.string().optional() },
    },
    safe(({ path, value, mode, type }) => {
      const tokens = structuredClone(doc.data.tokens) as Record<string, unknown>;
      const parts = path.split('.');
      let cur = tokens;
      for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
      const key = parts[parts.length - 1]!;
      const leaf = ((cur[key] as Record<string, unknown>) ??= { $value: value, ...(type ? { $type: type } : {}) });
      if (mode && mode !== 'light') {
        const ext = ((leaf.$extensions ??= {}) as Record<string, Record<string, Record<string, unknown>>>);
        ((ext.rangoli ??= {}).modes ??= {})[mode] = value;
      } else leaf.$value = value;
      doc.apply([{ op: 'setTokens', tokens: tokens as never }], { author, label: `token ${path}` });
      return text(`Set ${path}${mode ? ` [${mode}]` : ''} = ${value}`);
    }),
  );

  server.registerTool(
    'palette_generate',
    { description: 'Preview (no changes): 50–950 OKLCH ramp, tinted neutral ramp and 8 categorical chart colors from a seed.', inputSchema: { seed: z.string().regex(/^#[0-9a-fA-F]{6}$/) } },
    safe(({ seed }) => {
      const ramp = generateRamp(seed), neutral = generateNeutralRamp(seed);
      return text(
        [
          `ramp: ${Object.entries(ramp).map(([k, v]) => `${k}:${v}`).join(' ')}`,
          `neutral: ${Object.entries(neutral).map(([k, v]) => `${k}:${v}`).join(' ')}`,
          `categorical: ${generateCategorical(seed).join(' ')}`,
        ].join('\n'),
      );
    }),
  );

  server.registerTool(
    'contrast_check',
    {
      description: 'WCAG contrast between two colors (hex or token paths/short names), in light and dark.',
      inputSchema: { fg: z.string(), bg: z.string(), large: z.boolean().optional() },
    },
    safe(({ fg, bg, large }) => {
      const r = new TokenResolver(doc.data.tokens);
      const hex = (v: string, mode: string) => {
        if (v.startsWith('#')) return v;
        const p = r.find(v, 'color');
        if (!p) throw new Error(`Unknown color "${v}"`);
        return r.resolve(p, mode) as string;
      };
      return text(
        ['light', 'dark']
          .map((m) => {
            const c = contrastRatio(hex(fg, m), hex(bg, m));
            return `${m}: ${c.toFixed(2)}:1 ${wcagLevel(c, large)} (${hex(fg, m)} on ${hex(bg, m)})`;
          })
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'render_preview',
    {
      description: 'Render to a standalone HTML file (reference renderer) and return its path + live URL. Open it to look at the result.',
      inputSchema: { roots: z.array(z.string()).optional(), mode: z.enum(['light', 'dark']).optional(), page: pageArg },
    },
    safe(async ({ roots, mode, page }) => {
      const html = renderDocument(doc, { roots, mode, page });
      const dir = join(session.dir, '..', '.rangoli-cache');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `preview-${mode ?? 'light'}.html`);
      await writeFile(file, html);
      return text(`Rendered ${html.length} bytes → ${file}${opts.previewUrl ? `\nLive: ${opts.previewUrl}${mode === 'dark' ? '?mode=dark' : ''}` : ''}`);
    }),
  );

  server.registerTool(
    'export',
    {
      description: 'Export: "html" (standalone page), "css-tokens" (CSS variables, light+dark), "tokens-json" (W3C DTCG). Writes to outFile.',
      inputSchema: { format: z.enum(['html', 'css-tokens', 'tokens-json']), outFile: z.string().describe('absolute path'), roots: z.array(z.string()).optional(), mode: z.enum(['light', 'dark']).optional() },
    },
    safe(async ({ format, outFile, roots, mode }) => {
      const content =
        format === 'html' ? renderDocument(doc, { roots, mode }) : format === 'css-tokens' ? tokensToCss(doc.data.tokens) : JSON.stringify(doc.data.tokens, null, 2) + '\n';
      await writeFile(outFile, content);
      return text(`Wrote ${format} (${content.length} bytes) → ${outFile}`);
    }),
  );

  server.registerTool(
    'selection_get',
    { description: 'Nodes the human currently has selected in the editor/preview ("fix this" context).', inputSchema: {} },
    safe(() => text(session.selection.length ? serializeRdl(doc, { roots: session.selection, detail: 'compact' }) : 'Nothing selected.')),
  );

  return server;
}
