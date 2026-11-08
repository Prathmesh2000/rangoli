/**
 * Review & collaboration primitives (SPEC §11, Phase 3).
 * Reviews (comments, suggestions, versions) live OUTSIDE the design history:
 * undoing a design change never deletes a comment.
 */
import { RangoliDocument } from './document.js';
import type { DocumentData, RNode } from './model.js';
import { applyRdl, nodeLine } from './rdl.js';
import { TokenResolver } from './tokens.js';

import type { Severity } from './lint.js';

export interface Comment {
  id: string;
  author: string;
  body: string;
  time: number;
}

export interface Thread {
  id: string;
  /** anchored node (may be deleted later — thread stays, marked orphaned in UI) */
  node: string | null;
  kind: 'comment' | 'review';
  severity?: Severity;
  /** ready-to-apply RDL fix (review findings) */
  fix?: string;
  title?: string;
  resolved: boolean;
  comments: Comment[];
  time: number;
}

export interface ChangeSet {
  id: string;
  author: string;
  label: string;
  script: string;
  status: 'pending' | 'accepted' | 'rejected';
  time: number;
  /** history seq the suggestion was made against */
  baseSeq: number;
  decidedBy?: string;
  decidedAt?: number;
  /** conflict message if accepting failed */
  conflict?: string;
}

export interface VersionMeta {
  id: string;
  name: string;
  author: string;
  time: number;
  seq: number;
}

export interface ReviewData {
  threads: Thread[];
  changesets: ChangeSet[];
  versions: VersionMeta[];
}

export const emptyReviews = (): ReviewData => ({ threads: [], changesets: [], versions: [] });

/** Deep copy of a document (for previews and snapshots). */
export function cloneDocument(doc: RangoliDocument | DocumentData): RangoliDocument {
  const data = doc instanceof RangoliDocument ? doc.data : doc;
  return new RangoliDocument(structuredClone(data));
}

/** Apply an RDL script to a COPY — never touches the original. */
export function previewScript(doc: RangoliDocument, script: string, opts: { page?: string; parent?: string } = {}): { doc: RangoliDocument; created: string[]; touched: string[]; error?: string } {
  const copy = cloneDocument(doc);
  try {
    const r = applyRdl(copy, script, { ...opts, author: 'preview' });
    return { doc: copy, created: r.created, touched: r.touched };
  } catch (e) {
    return { doc: cloneDocument(doc), created: [], touched: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export interface DocDiff {
  added: string[];
  removed: string[];
  changed: { id: string; fields: string[] }[];
  tokens: boolean;
  motion: string[];
  components: string[];
}

const NODE_FIELDS: (keyof RNode)[] = ['type', 'name', 'role', 'parent', 'children', 'layout', 'size', 'position', 'style', 'text', 'vector', 'image', 'component', 'variant', 'props', 'hidden', 'locked'];

/** Structural diff between two documents (per page). */
export function diffDocuments(before: DocumentData, after: DocumentData, pageId?: string): DocDiff {
  const pid = pageId ?? after.manifest.pages[0]?.id ?? before.manifest.pages[0]?.id ?? 'p1';
  const a = before.pages[pid]?.nodes ?? {};
  const b = after.pages[pid]?.nodes ?? {};
  const added = Object.keys(b).filter((id) => !a[id]);
  const removed = Object.keys(a).filter((id) => !b[id]);
  const changed: DocDiff['changed'] = [];
  for (const id of Object.keys(b)) {
    const x = a[id], y = b[id];
    if (!x || !y) continue;
    const fields = NODE_FIELDS.filter((f) => JSON.stringify(x[f]) !== JSON.stringify(y[f]));
    if (fields.length) changed.push({ id, fields: fields as string[] });
  }
  const keys = (o?: Record<string, unknown>) => Object.keys(o ?? {});
  const motionKeys = new Set([...keys(before.motion), ...keys(after.motion)]);
  const compKeys = new Set([...keys(before.components), ...keys(after.components)]);
  return {
    added,
    removed,
    changed,
    tokens: JSON.stringify(before.tokens) !== JSON.stringify(after.tokens),
    motion: [...motionKeys].filter((k) => JSON.stringify(before.motion?.[k]) !== JSON.stringify(after.motion?.[k])),
    components: [...compKeys].filter((k) => JSON.stringify(before.components[k]) !== JSON.stringify(after.components[k])),
  };
}

export const isEmptyDiff = (d: DocDiff) => !d.added.length && !d.removed.length && !d.changed.length && !d.tokens && !d.motion.length && !d.components.length;

/** Compact, agent-readable diff: RDL lines prefixed with + - ~ */
export function formatDiff(before: DocumentData, after: DocumentData, d: DocDiff, pageId?: string): string {
  if (isEmptyDiff(d)) return 'No differences.';
  const docA = new RangoliDocument(before), docB = new RangoliDocument(after);
  const tA = new TokenResolver(before.tokens), tB = new TokenResolver(after.tokens);
  const pid = pageId ?? after.manifest.pages[0]?.id ?? 'p1';
  const line = (doc: RangoliDocument, t: TokenResolver, id: string) => {
    const n = doc.data.pages[pid]?.nodes[id];
    return n ? nodeLine(n, t, doc) : `#${id}`;
  };
  const out: string[] = [];
  // only list roots of added/removed subtrees
  const addedSet = new Set(d.added), removedSet = new Set(d.removed);
  for (const id of d.added) {
    const p = after.pages[pid]?.nodes[id]?.parent;
    if (!p || !addedSet.has(p)) out.push(`+ ${line(docB, tB, id)}${p ? `   (in #${p})` : ''}`);
  }
  for (const id of d.removed) {
    const p = before.pages[pid]?.nodes[id]?.parent;
    if (!p || !removedSet.has(p)) out.push(`- ${line(docA, tA, id)}`);
  }
  for (const c of d.changed) {
    const onlyChildren = c.fields.length === 1 && c.fields[0] === 'children';
    if (onlyChildren) { out.push(`~ #${c.id} children reordered/changed`); continue; }
    out.push(`~ #${c.id} [${c.fields.join(', ')}]\n    was: ${line(docA, tA, c.id)}\n    now: ${line(docB, tB, c.id)}`);
  }
  if (d.tokens) out.push('~ tokens changed');
  for (const m of d.motion) out.push(`~ motion ${m}`);
  for (const c of d.components) out.push(`~ component @${c}`);
  return out.join('\n');
}

/** Short unique id with prefix ("t", "cs", "v"). */
export function reviewId(prefix: string, existing: { id: string }[]): string {
  let n = existing.length + 1;
  const ids = new Set(existing.map((e) => e.id));
  while (ids.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** Mentions like @agent / @claude / @darshana in a comment body. */
export function mentions(body: string): string[] {
  return [...body.matchAll(/(^|\s)@([a-z][\w-]*)/gi)].map((m) => m[2]!.toLowerCase());
}
