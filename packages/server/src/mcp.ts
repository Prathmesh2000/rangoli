import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  applyRdl,
  compileRdl,
  contrastRatio,
  defaultTokens,
  diffDocuments,
  formatDiff,
  formatLint,
  previewScript,
  findIcon,
  iconReact,
  iconSprite,
  iconSvg,
  lintIcons,
  prototypeHtml,
  serializePrototype,
  generateCategorical,
  generateNeutralRamp,
  generateRamp,
  lint,
  MOTION_PRESETS,
  motionCss,
  parseMotionLines,
  renderDocument,
  sampleMotion,
  serializeMotion,
  type MotionSpec,
  serializeRdl,
  TokenResolver,
  tokensToCss,
  wcagLevel,
  type LintIssue,
  type RNode,
} from '@rangoli/engine';
import { INSTRUCTIONS, RDL_HELP } from './guide.js';
import { filmstrip, renderIcons, renderPng } from './shots.js';
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

  /** Validate on a copy, store as a pending change set, report lint of the would-be result. */
  const suggest = (script: string, label: string, parent?: string, page?: string): string => {
    const p = previewScript(doc, script, { parent, page });
    if (p.error) throw new Error(p.error);
    const cs = session.addChangeset({ author, label, script });
    const nodeIds = p.touched.filter((t) => !t.startsWith('$') && p.doc.findNode(t));
    const roots = new Set<string>();
    for (const id of nodeIds) {
      let n = p.doc.findNode(id)?.node;
      while (n?.parent) n = p.doc.findNode(n.parent)?.node;
      if (n) roots.add(n.id);
    }
    const issues = roots.size ? lint(p.doc, { page, roots: [...roots] }).filter((i) => i.severity !== 'P3') : [];
    return [
      `Saved as suggestion ${cs.id} — NOT applied. A human accepts or rejects it in the editor (Review tab).`,
      `Diff:\n${formatDiff(doc.data, p.doc.data, diffDocuments(doc.data, p.doc.data, page), page)}`,
      issues.length ? `Lint of the suggested result:\n${formatLint(issues)}` : 'Lint of the suggested result: clean (P0–P2).',
    ].join('\n');
  };

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
          opts.previewUrl ? `Clickable prototype: ${opts.previewUrl}play` : '',
          `History: ${doc.historyEntries.length} changes`,
          `Agent mode: ${session.agentMode}${session.agentMode === 'suggest' ? ' — rdl_apply creates suggestions for human approval' : ''}`,
          `Review: ${session.reviews.threads.filter((t) => !t.resolved).length} open threads, ${session.reviews.changesets.filter((c) => c.status === 'pending').length} pending suggestions, ${session.agentInbox().length} waiting for you (see inbox)`,
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
      if (session.agentMode === 'suggest') return text(suggest(script, label ?? 'agent suggestion', parent, page));
      const res = applyRdl(doc, script, { parent, page, author, label });
      // map touched entries to nodes: plain ids, and motion on "#id" targets
      const nodeIds = res.touched.flatMap((t) => (!t.startsWith('$') ? [t] : t.startsWith('$motion:#') ? [t.slice(9).replace(/\[.*$/, '')] : []));
      const componentMotion = res.touched.some((t) => t.startsWith('$motion:@'));
      const roots = rootsOf(nodeIds.filter((id) => doc.findNode(id)), page);
      const issues = roots.length ? lint(doc, { page, roots }) : [];
      if (componentMotion) for (const i of lint(doc, { page })) if (i.code.startsWith('M') && !issues.some((x) => x.code === i.code && x.node === i.node)) issues.push(i);
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
      description: 'Export: "html" (standalone page), "css-tokens" (CSS variables, light+dark), "css-motion" (transitions/keyframes + reduced motion), "tokens-json" (W3C DTCG). Writes to outFile.',
      inputSchema: { format: z.enum(['html', 'css-tokens', 'css-motion', 'tokens-json']), outFile: z.string().describe('absolute path'), roots: z.array(z.string()).optional(), mode: z.enum(['light', 'dark']).optional() },
    },
    safe(async ({ format, outFile, roots, mode }) => {
      const content =
        format === 'html'
          ? renderDocument(doc, { roots, mode })
          : format === 'css-tokens'
            ? tokensToCss(doc.data.tokens)
            : format === 'css-motion'
              ? motionCss(doc.data.motion, doc.data.tokens) + '\n'
              : JSON.stringify(doc.data.tokens, null, 2) + '\n';
      await writeFile(outFile, content);
      return text(`Wrote ${format} (${content.length} bytes) → ${outFile}`);
    }),
  );

  // ---------------------------------------------------------------- motion
  server.registerTool(
    'motion_get',
    { description: 'Read motion definitions as RDL (all, or for targets like "@Button", "#n7").', inputSchema: { targets: z.array(z.string()).optional() } },
    safe(({ targets }) => text(serializeMotion(doc.data.motion, targets) || 'No motion defined.')),
  );

  server.registerTool(
    'motion_curve',
    {
      description: 'See an animation as numbers: per-property value tables over time (you cannot watch video — use this to check feel). Optionally pass draft RDL lines instead of an existing target.',
      inputSchema: { target: z.string().optional().describe('"@Button[variant=primary]" or "#n7"'), trigger: z.enum(['hover', 'press', 'focus', 'disabled', 'selected', 'enter', 'exit']).optional(), draft: z.string().optional().describe('e.g. "enter opacity:0, y:md base out"'), steps: z.number().int().min(3).max(21).optional() },
    },
    safe(({ target, trigger, draft, steps }) => {
      let specs: MotionSpec[];
      if (draft) {
        const diag: { line: number; severity: 'error' | 'warning'; message: string }[] = [];
        specs = parseMotionLines(draft.split('\n').map((l, i) => ({ no: i + 1, toks: l.trim().split(/\s+/) })), diag);
        if (diag.length) throw new Error(diag.map((d) => d.message).join('\n'));
      } else {
        const def = target ? doc.data.motion?.[target] : undefined;
        if (!def) throw new Error(`No motion for ${target}. Known: ${Object.keys(doc.data.motion ?? {}).join(', ')}`);
        specs = def.specs;
      }
      const out = specs.filter((s) => !trigger || s.trigger === trigger).map((s) => {
        const r = sampleMotion(s, doc.data.tokens, steps ?? 6);
        return `${s.trigger} (${r.ms}ms, ${s.easing})\n  ${r.lines.join('\n  ')}`;
      });
      return text(out.join('\n') || 'Nothing to sample.');
    }),
  );

  server.registerTool(
    'motion_presets',
    { description: 'List motion presets (press, popover, modal, toast, listItem, fade, statusChange, drawer) with their RDL.', inputSchema: {} },
    safe(() => text(Object.entries(MOTION_PRESETS).map(([k, p]) => `${k} — ${p.description}\n  ${p.rdl.replace(/\n/g, '\n  ')}`).join('\n'))),
  );

  server.registerTool(
    'motion_preset',
    {
      description: 'Apply a motion preset to a target ("@Comp", "@Comp variant=x", or "#id"). Undoable; returns motion lint.',
      inputSchema: { target: z.string(), preset: z.enum(Object.keys(MOTION_PRESETS) as [string, ...string[]]) },
    },
    safe(({ target, preset }) => {
      const p = MOTION_PRESETS[preset]!;
      applyRdl(doc, `motion ${target}\n${p.rdl.split('\n').map((l) => '  ' + l).join('\n')}`, { author, label: `motion ${preset} → ${target}` });
      const issues = lint(doc).filter((i) => i.code.startsWith('M'));
      return text(`Applied ${preset} to ${target}.\n${issues.length ? formatLint(issues) : 'Motion lint: clean.'}`);
    }),
  );

  // ---------------------------------------------------------------- review & collaboration
  server.registerTool(
    'suggest',
    {
      description: 'Propose an RDL change WITHOUT applying it. It becomes a pending suggestion a human accepts/rejects in the editor. Use for anything subjective or large. (When the owner sets agent mode to "suggest", rdl_apply does this automatically.)',
      inputSchema: { script: z.string(), label: z.string().describe('one-line description for the reviewer'), parent: z.string().optional(), page: pageArg },
    },
    safe(({ script, label, parent, page }) => text(suggest(script, label, parent, page))),
  );

  server.registerTool(
    'suggestions_list',
    { description: 'List suggestions (change sets) and their status.', inputSchema: { status: z.enum(['pending', 'accepted', 'rejected']).optional() } },
    safe(({ status }) => {
      const list = session.reviews.changesets.filter((c) => !status || c.status === status);
      return text(list.length ? list.map((c) => `${c.id} [${c.status}] ${c.author}: ${c.label}${c.conflict ? ` (conflict: ${c.conflict.split('\n')[0]})` : ''}`).join('\n') : 'No suggestions.');
    }),
  );

  server.registerTool(
    'comments_list',
    {
      description: 'Comment threads and review pins on the design (open by default).',
      inputSchema: { includeResolved: z.boolean().optional(), node: z.string().optional() },
    },
    safe(({ includeResolved, node }) => {
      const list = session.reviews.threads.filter((t) => (includeResolved || !t.resolved) && (!node || t.node === node));
      if (!list.length) return text('No open threads.');
      return text(
        list
          .map((t) => {
            const head = `${t.id} ${t.kind === 'review' ? `[${t.severity ?? 'P2'} review] ` : ''}${t.node ? `#${t.node}` : '(page)'}${t.resolved ? ' (resolved)' : ''}${t.title ? ` — ${t.title}` : ''}`;
            const body = t.comments.map((c) => `  ${c.author}: ${c.body}`).join('\n');
            return `${head}\n${body}${t.fix ? `\n  fix: ${t.fix.replace(/\n/g, ' ; ')}` : ''}`;
          })
          .join('\n'),
      );
    }),
  );

  server.registerTool(
    'inbox',
    { description: 'Open threads where a human mentioned @agent / @claude / @cursor / @darshana and is waiting for your reply.', inputSchema: {} },
    safe(() => {
      const list = session.agentInbox();
      return text(list.length ? list.map((t) => `${t.id} ${t.node ? `#${t.node}` : '(page)'}\n${t.comments.map((c) => `  ${c.author}: ${c.body}`).join('\n')}`).join('\n') : 'Inbox empty.');
    }),
  );

  server.registerTool(
    'comment',
    {
      description: 'Add a comment thread on a node (or the page), reply to a thread, or resolve it.',
      inputSchema: {
        action: z.enum(['add', 'reply', 'resolve', 'reopen']),
        node: z.string().optional().describe('for add: node id without #'),
        thread: z.string().optional().describe('for reply/resolve: thread id like t3'),
        body: z.string().optional(),
      },
    },
    safe(({ action, node, thread, body }) => {
      if (action === 'add') {
        if (!body) throw new Error('body required');
        const t = session.addThread({ node: node ?? null, author, body });
        return text(`Added ${t.id}${node ? ` on #${node}` : ''}.`);
      }
      if (!thread) throw new Error('thread required');
      if (action === 'reply') {
        if (!body) throw new Error('body required');
        session.reply(thread, author, body);
        return text(`Replied on ${thread}.`);
      }
      session.resolveThread(thread, action === 'resolve');
      return text(`${thread} ${action === 'resolve' ? 'resolved' : 'reopened'}.`);
    }),
  );

  server.registerTool(
    'review_add',
    {
      description: 'Post design-review findings as pins on the canvas (e.g. from the darshana-thakur reviewer). Each finding may include a ready RDL fix the human can apply with one click.',
      inputSchema: {
        title: z.string().optional(),
        findings: z.array(z.object({ node: z.string().nullable(), severity: z.enum(['P0', 'P1', 'P2', 'P3']), message: z.string(), fix: z.string().optional() })).min(1).max(40),
      },
    },
    safe(({ title, findings }) => {
      const bad = findings.filter((f) => f.node && !doc.findNode(f.node));
      if (bad.length) throw new Error(`Unknown nodes: ${bad.map((f) => `#${f.node}`).join(', ')}`);
      for (const f of findings) {
        if (f.fix) {
          const p = previewScript(doc, f.fix);
          if (p.error) throw new Error(`Fix for #${f.node} is not valid RDL: ${p.error}`);
        }
      }
      const ids = findings.map((f) => session.addThread({ node: f.node, author, body: f.message, kind: 'review', severity: f.severity, fix: f.fix, title }).id);
      return text(`Posted ${ids.length} review pins: ${ids.join(' ')}`);
    }),
  );

  server.registerTool(
    'version_save',
    { description: 'Save a named version (full snapshot) to compare against later.', inputSchema: { name: z.string() } },
    safe(async ({ name }) => {
      const v = await session.saveVersion(name, author);
      return text(`Saved ${v.id} "${v.name}".`);
    }),
  );

  server.registerTool(
    'diff',
    {
      description: 'What changed: compare a saved version (or a pending suggestion) with the current design. Output is compact RDL with + - ~ markers.',
      inputSchema: { from: z.string().describe('version id like v2, or suggestion id like cs3 (shows what accepting it would change)'), page: pageArg },
    },
    safe(async ({ from, page }) => {
      if (/^cs\d+$/.test(from)) {
        const cs = session.changeset(from);
        const p = previewScript(doc, cs.script, { page });
        if (p.error) return text(`${from} no longer applies cleanly: ${p.error}`);
        return text(formatDiff(doc.data, p.doc.data, diffDocuments(doc.data, p.doc.data, page), page));
      }
      const before = await session.loadVersion(from);
      return text(formatDiff(before, doc.data, diffDocuments(before, doc.data, page), page));
    }),
  );

  server.registerTool(
    'versions_list',
    { description: 'Saved versions.', inputSchema: {} },
    safe(() => text(session.reviews.versions.map((v) => `${v.id} "${v.name}" by ${v.author} ${new Date(v.time).toISOString().slice(0, 16).replace('T', ' ')}`).join('\n') || 'No versions saved.')),
  );

  // ---------------------------------------------------------------- prototype & seeing
  const image = (png: Buffer, caption: string) => ({
    content: [
      { type: 'image' as const, data: png.toString('base64'), mimeType: 'image/png' },
      { type: 'text' as const, text: caption },
    ],
  });

  server.registerTool(
    'proto_get',
    { description: 'Read prototype interactions, start screen and timelines as RDL (all, or those involving given node ids).', inputSchema: { nodes: z.array(z.string()).optional() } },
    safe(({ nodes }) => text(serializePrototype(doc.data.prototype, doc.data.timelines, nodes) || 'No interactions or timelines yet.')),
  );

  server.registerTool(
    'prototype_export',
    {
      description: 'Export a standalone, dependency-free HTML prototype (all top-level frames as screens; clicks, overlays, swaps, timelines, smart animate). Writes to outFile.',
      inputSchema: { outFile: z.string().describe('absolute path ending in .html'), start: z.string().optional(), mode: z.enum(['light', 'dark']).optional() },
    },
    safe(async ({ outFile, start, mode }) => {
      const html = prototypeHtml(doc, { start, mode });
      await writeFile(outFile, html);
      return text(`Wrote prototype (${Math.round(html.length / 1024)} KB) → ${outFile}${opts.previewUrl ? `\nLive: ${opts.previewUrl}play` : ''}`);
    }),
  );

  server.registerTool(
    'render_png',
    {
      description: 'LOOK at the design: returns a PNG screenshot (reference renderer) of given roots or the whole page. Use after changes to check hierarchy, spacing and balance with your own eyes.',
      inputSchema: { roots: z.array(z.string()).optional(), mode: z.enum(['light', 'dark']).optional(), maxWidth: z.number().int().min(320).max(1600).optional() },
    },
    async ({ roots, mode, maxWidth }) => {
      try {
        const png = await renderPng(doc, { roots, mode, maxWidth });
        return image(png, `${roots?.length ? roots.map((r) => `#${r}`).join(' ') : 'page'} · ${mode ?? 'light'}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'motion_filmstrip',
    {
      description: 'WATCH an animation: frozen frames of an enter/exit animation ("#id") or a timeline ("timeline:name") side by side in one PNG, with timestamps. Use to judge choreography you cannot see live.',
      inputSchema: { target: z.string(), trigger: z.enum(['enter', 'exit']).optional(), frames: z.number().int().min(3).max(10).optional(), mode: z.enum(['light', 'dark']).optional() },
    },
    async ({ target, trigger, frames, mode }) => {
      try {
        const r = await filmstrip(doc, { target, trigger, frames, mode });
        return image(r.png, `${target} ${trigger ?? ''} · ${r.ms}ms · frames at ${r.times.join(', ')} ms`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  // ---------------------------------------------------------------- icons
  server.registerTool(
    'icon_list',
    { description: 'List icon sets and icon names (with set conventions: grid, stroke, caps).', inputSchema: { set: z.string().optional() } },
    safe(({ set }) => {
      const sets = Object.values(doc.data.icons ?? {}).filter((s) => !set || s.name === set);
      return text(sets.map((s) => `${s.name} (grid${s.grid} stroke${s.stroke} ${s.cap}): ${Object.keys(s.icons).join(' ')}`).join('\n') || 'No icon sets.');
    }),
  );

  server.registerTool(
    'icon_get',
    { description: 'Shape-language source of icons (to edit or base variants on).', inputSchema: { names: z.array(z.string()).describe('"clock" or "ui/clock"') } },
    safe(({ names }) =>
      text(
        names
          .map((n) => {
            const f = findIcon(doc.data.icons, n);
            if (!f) return `${n}: not found`;
            return `icon ${f.set.name}/${f.icon.name}${f.icon.stroke ? ` stroke${f.icon.stroke}` : ''}\n${f.icon.src.split('\n').map((l) => '  ' + l).join('\n')}`;
          })
          .join('\n'),
      ),
    ),
  );

  server.registerTool(
    'icon_render',
    {
      description: 'LOOK at icons: PNG with each icon at 16/20/24/32 px on light and dark, and in context (button, chip, table row). Create variants as drafts/<name>~1..4, render them together, then let the human keep one.',
      inputSchema: { names: z.array(z.string()).min(1).max(16) },
    },
    async ({ names }) => {
      try {
        const png = await renderIcons(doc, names);
        const issues = lintIcons(doc.data.icons, names.map((n) => { const f = findIcon(doc.data.icons, n); return f ? `${f.set.name}/${f.icon.name}` : n; }));
        return image(png, issues.length ? `Icon lint:\n${issues.map((i) => `[${i.severity}] ${i.code} ${i.icon} ${i.message}`).join('\n')}` : 'Icon lint: clean.');
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    'icon_export',
    {
      description: 'Export an icon set: "svg" (one file per icon), "react" (one .tsx component per icon + index.ts), or "sprite" (single SVG with <symbol>s). Writes into outDir.',
      inputSchema: { set: z.string(), format: z.enum(['svg', 'react', 'sprite']), outDir: z.string().describe('absolute directory path') },
    },
    safe(async ({ set, format, outDir }) => {
      const s = doc.data.icons?.[set];
      if (!s) throw new Error(`No icon set "${set}"`);
      await mkdir(outDir, { recursive: true });
      const icons = Object.values(s.icons);
      if (format === 'sprite') {
        await writeFile(join(outDir, `${set}-sprite.svg`), iconSprite(s));
        return text(`Wrote ${icons.length} symbols → ${join(outDir, `${set}-sprite.svg`)}`);
      }
      const pascal = (n: string) => n.replace(/(^|[-_~\s]+)(\w)/g, (_, __, c: string) => c.toUpperCase());
      for (const ic of icons) {
        if (format === 'svg') await writeFile(join(outDir, `${ic.name}.svg`), iconSvg(s, ic) + '\n');
        else await writeFile(join(outDir, `${pascal(ic.name)}Icon.tsx`), iconReact(s, ic));
      }
      if (format === 'react') await writeFile(join(outDir, 'index.ts'), icons.map((ic) => `export { ${pascal(ic.name)}Icon } from './${pascal(ic.name)}Icon';`).join('\n') + '\n');
      return text(`Wrote ${icons.length} ${format === 'svg' ? 'SVG files' : 'React components + index.ts'} → ${outDir}`);
    }),
  );

  server.registerTool(
    'selection_get',
    { description: 'Nodes the human currently has selected in the editor/preview ("fix this" context).', inputSchema: {} },
    safe(() => text(session.selection.length ? serializeRdl(doc, { roots: session.selection, detail: 'compact' }) : 'Nothing selected.')),
  );

  return server;
}
