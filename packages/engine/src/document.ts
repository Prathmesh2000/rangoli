import { IdGen } from './ids.js';
import type { ComponentDef, DocumentData, Page, RNode, TokenTree } from './model.js';
import type { MotionDef } from './motion.js';
import type { Interaction, Timeline } from './prototype.js';
import type { IconDef, IconSet } from './icons.js';
import type { AssetMeta } from './images.js';
import { isSafeKey, isSafeNodeId, nodeFieldsError, tokenModeError, tokenPathError } from './safety.js';
import { tokenTreeError } from './tokens.js';
import { applySets, diffSets, pathsOverlap, unsafePathSegment, type PathSet } from './path-patch.js';

export * from './path-patch.js';

/** Atomic edit operations. Every op is reversible. */
export type Op =
  | { op: 'create'; page?: string; node: RNode; parent?: string; index?: number }
  | { op: 'update'; page?: string; id: string; patch: Partial<Omit<RNode, 'id' | 'children' | 'parent'>> }
  /** the stored form of an update: only the properties that changed */
  | { op: 'patch'; page?: string; id: string; sets: PathSet[] }
  | { op: 'delete'; page?: string; id: string }
  | { op: 'move'; page?: string; id: string; parent?: string; index?: number }
  | { op: 'setTokens'; tokens: TokenTree }
  /** the stored form of setTokens: only the tokens that changed */
  | { op: 'patchTokens'; sets: PathSet[] }
  | { op: 'setComponent'; component: ComponentDef }
  | { op: 'deleteComponent'; id: string }
  /** set (def) or remove (null) a motion definition */
  | { op: 'setMotion'; target: string; def: MotionDef | null }
  | { op: 'setInteractions'; node: string; list: Interaction[] | null }
  | { op: 'setProtoStart'; frame: string | null }
  | { op: 'setProtoVars'; vars: Record<string, string> | null }
  | { op: 'setTimeline'; name: string; def: Timeline | null }
  | { op: 'setIconSet'; name: string; def: IconSet | null }
  | { op: 'setIcon'; set: string; name: string; icon: IconDef | null }
  | { op: 'setAsset'; id: string; meta: AssetMeta | null }
  /** internal: restore a deleted subtree exactly */
  | { op: 'restore'; page: string; nodes: RNode[]; parent?: string; index: number };

export interface ChangeEntry {
  seq: number;
  author: string;
  label?: string;
  time: number;
  ops: Op[];
  inverse: Op[];
  /** ids touched by this change */
  touched: string[];
  /** who made it; absent in local mode, where one person owns the document */
  actorId?: string;
  tokenId?: string;
  /** this entry reverted change #undoOf */
  undoOf?: number;
  /** this entry re-applied the change whose undo was #redoOf */
  redoOf?: number;
  /** applied without an undo step */
  noHistory?: boolean;
  /** on the entry undo() or redo() returns: parts left alone because someone else changed them since */
  stayed?: number;
}

/** Who is making the current change; a host supplies this when several people share one document. */
export type Attribution = () => { actorId?: string; tokenId?: string } | undefined;

/** The page an op belongs to; '' is everything outside pages (tokens, components, assets). */
export function opScope(op: Op): string {
  switch (op.op) {
    case 'create':
    case 'update':
    case 'patch':
    case 'delete':
    case 'move':
    case 'restore':
      return op.page ?? '';
    default:
      return '';
  }
}

/** Fields that belong to the tree, which a property patch must never rewrite. */
const STRUCTURAL = new Set(['id', 'children', 'parent']);

export class RangoliError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const clone = <T>(v: T): T => structuredClone(v);

const reservedKey = (...keys: (string | null | undefined)[]): string | undefined => {
  const bad = keys.find((k) => typeof k === 'string' && !isSafeKey(k));
  return bad === undefined ? undefined : `"${bad}" is a reserved name`;
};

/** Why an incoming op cannot be applied. Undo and rollback replay earlier state and do not come through here. */
function opError(op: Op, doc: RangoliDocument): string | undefined {
  const tokens = doc.data.tokens;
  switch (op.op) {
    case 'create':
      if (op.node.id && !isSafeNodeId(op.node.id)) return `Invalid node id "${op.node.id.slice(0, 80)}"`;
      return reservedKey(op.page, op.parent) ?? nodeFieldsError(op.node);
    case 'update':
      return reservedKey(op.page, op.id, ...Object.keys(op.patch)) ?? nodeFieldsError(op.patch);
    case 'patch': {
      const bad = reservedKey(op.page, op.id) ?? op.sets.map(setPathError).find(Boolean);
      if (bad) return bad;
      if (op.sets.some((s) => !s.path.length || STRUCTURAL.has(s.path[0]!))) return "A patch can only change a layer's properties";
      const fields = doc.previewNodePatch(op);
      return fields ? nodeFieldsError(fields as Parameters<typeof nodeFieldsError>[0]) : undefined;
    }
    case 'patchTokens': {
      const bad = op.sets.map(setPathError).find(Boolean);
      if (bad) return bad;
      const holder = { tokens: clone(tokens) as unknown };
      applySets(holder, 'tokens', op.sets);
      return tokenTreeError(holder.tokens as TokenTree, tokens);
    }
    case 'delete':
      return reservedKey(op.page, op.id);
    case 'move':
      return reservedKey(op.page, op.id, op.parent);
    case 'restore':
      return reservedKey(op.page, op.parent, ...op.nodes.map((n) => n.id));
    case 'setTokens':
      return tokenTreeError(op.tokens, tokens);
    case 'setComponent': {
      const styles = [...op.component.styles.map((r) => ({ style: r.style })), ...Object.values(op.component.template?.nodes ?? {})];
      return reservedKey(op.component.id) ?? styles.map(nodeFieldsError).find(Boolean);
    }
    case 'deleteComponent':
    case 'setAsset':
      return reservedKey(op.id);
    case 'setMotion':
      return reservedKey(op.target);
    case 'setInteractions':
      return reservedKey(op.node);
    case 'setTimeline':
    case 'setIconSet':
      return reservedKey(op.name);
    case 'setIcon':
      return reservedKey(op.set, op.name);
    default:
      return undefined;
  }
}

function setPathError(s: PathSet): string | undefined {
  if (!Array.isArray(s.path)) return 'A patch path must be a list of keys';
  const bad = unsafePathSegment(s.path);
  return bad === undefined ? undefined : `"${String(bad).slice(0, 80)}" is a reserved name`;
}

export interface ApplyResult {
  seq: number;
  touched: string[];
  created: string[];
}

export type ChangeListener = (entry: ChangeEntry) => void;

export class RangoliDocument {
  readonly data: DocumentData;
  readonly ids = new IdGen('n');
  private history: ChangeEntry[] = [];
  private redoStack: (ChangeEntry & { undoneAt: number })[] = [];
  private seq = 0;
  /** set by a host that knows who is editing; undo and redo then stay within that person's own changes */
  attribution?: Attribution;
  private listeners = new Set<ChangeListener>();

  constructor(data: DocumentData) {
    this.data = data;
    for (const page of Object.values(data.pages)) for (const id of Object.keys(page.nodes)) this.ids.observe(id);
  }

  static empty(name = 'Untitled'): RangoliDocument {
    const pageId = 'p1';
    return new RangoliDocument({
      manifest: { format: 'rangoli@1', name, pages: [{ id: pageId, name: 'Page 1' }] },
      tokens: {},
      pages: { [pageId]: { id: pageId, name: 'Page 1', children: [], nodes: {} } },
      components: {},
      motion: {},
    });
  }

  // ---------- reading ----------
  get defaultPageId(): string {
    const first = this.data.manifest.pages[0];
    if (!first) throw new RangoliError('NO_PAGE', 'Document has no pages');
    return first.id;
  }

  page(id?: string): Page {
    const key = id ?? this.defaultPageId;
    const p = Object.hasOwn(this.data.pages, key) ? this.data.pages[key] : undefined;
    if (!p) throw new RangoliError('PAGE_NOT_FOUND', `Page ${id} not found`);
    return p;
  }

  node(id: string, pageId?: string): RNode {
    const { nodes } = this.page(pageId);
    const n = Object.hasOwn(nodes, id) ? nodes[id] : undefined;
    if (!n) throw new RangoliError('NODE_NOT_FOUND', `Node #${id} not found`);
    return n;
  }

  findNode(id: string): { page: Page; node: RNode } | undefined {
    for (const page of Object.values(this.data.pages)) {
      const node = page.nodes[id];
      if (node) return { page, node };
    }
    return undefined;
  }

  childrenOf(parent: string | undefined, pageId?: string): string[] {
    const page = this.page(pageId);
    return parent ? (this.node(parent, page.id).children ?? []) : page.children;
  }

  /** Depth-first walk. */
  *walk(rootIds?: string[], pageId?: string, depth = 0): Generator<{ node: RNode; depth: number }> {
    const page = this.page(pageId);
    for (const id of rootIds ?? page.children) {
      const node = page.nodes[id];
      if (!node) continue;
      yield { node, depth };
      if (node.children?.length) yield* this.walk(node.children, page.id, depth + 1);
    }
  }

  get historyEntries(): readonly ChangeEntry[] {
    return this.history;
  }

  /** Sequence number of the latest change, including undos. */
  get headSeq(): number {
    return this.seq;
  }

  onChange(fn: ChangeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // ---------- writing ----------
  /**
   * Apply ops atomically: either all succeed or none do.
   */
  /**
   * Group several apply() calls into ONE atomic, undoable change.
   * If fn throws, everything applied inside is rolled back.
   */
  transact<T>(fn: () => T, opts: { author?: string; label?: string } = {}): T {
    if (this.tx) return fn(); // nested: join outer transaction
    const tx = (this.tx = { ops: [] as Op[], inverse: [] as Op[], touched: new Set<string>() });
    let result: T;
    try {
      result = fn();
    } catch (err) {
      this.tx = undefined;
      for (const inv of tx.inverse) this.applyOne(inv, new Set(), []);
      throw err;
    }
    this.tx = undefined;
    if (!tx.ops.length) return result;
    const entry: ChangeEntry = {
      seq: ++this.seq,
      author: opts.author ?? 'human',
      label: opts.label,
      time: Date.now(),
      ops: tx.ops,
      inverse: tx.inverse,
      touched: [...tx.touched],
      ...this.attribution?.(),
    };
    this.history.push(entry);
    this.clearRedo(entry);
    for (const l of this.listeners) l(entry);
    return result;
  }

  private tx: { ops: Op[]; inverse: Op[]; touched: Set<string> } | undefined;

  apply(ops: Op[], opts: { author?: string; label?: string; recordHistory?: boolean } = {}): ApplyResult {
    const inverse: Op[] = [];
    const touched = new Set<string>();
    const created: string[] = [];
    const normal: Op[] = [];
    try {
      for (const op of ops) {
        const invalid = opError(op, this);
        if (invalid) throw new RangoliError('INVALID_OP', invalid);
        const stored = this.normalize(op);
        const inv = this.applyOne(stored, touched, created);
        normal.push(stored);
        inverse.unshift(...inv);
      }
    } catch (err) {
      // roll back what was applied
      for (const inv of inverse) this.applyOne(inv, new Set(), []);
      throw err;
    }
    if (this.tx) {
      this.tx.ops.push(...clone(normal));
      this.tx.inverse.unshift(...inverse);
      for (const t of touched) this.tx.touched.add(t);
      return { seq: this.seq + 1, touched: [...touched], created };
    }
    const entry: ChangeEntry = {
      seq: ++this.seq,
      author: opts.author ?? 'human',
      label: opts.label,
      time: Date.now(),
      ops: clone(normal),
      inverse,
      touched: [...touched],
      ...this.attribution?.(),
      ...(opts.recordHistory === false ? { noHistory: true } : {}),
    };
    if (opts.recordHistory !== false) {
      this.history.push(entry);
      this.clearRedo(entry);
    }
    for (const l of this.listeners) l(entry);
    return { seq: entry.seq, touched: entry.touched, created };
  }

  /** Set one token value, optionally for a mode. The path is checked before it is walked. */
  setToken(path: string, value: string | number, opts: { mode?: string; type?: string; author?: string } = {}): ApplyResult {
    const invalid = tokenPathError(path) ?? (opts.mode ? tokenModeError(opts.mode) : undefined);
    if (invalid) throw new RangoliError('INVALID_TOKEN', invalid);
    const tokens = clone(this.data.tokens) as unknown as Record<string, unknown>;
    const parts = path.split('.');
    let cur = tokens;
    for (const p of parts.slice(0, -1)) cur = (cur[p] ??= {}) as Record<string, unknown>;
    const key = parts[parts.length - 1]!;
    const leaf = ((cur[key] as Record<string, unknown>) ??= { $value: value, ...(opts.type ? { $type: opts.type } : {}) });
    if (opts.mode && opts.mode !== 'light') {
      const ext = (leaf.$extensions ??= {}) as Record<string, Record<string, Record<string, unknown>>>;
      ((ext.rangoli ??= {}).modes ??= {})[opts.mode] = value;
    } else leaf.$value = value;
    return this.apply([{ op: 'setTokens', tokens: tokens as unknown as TokenTree }], { author: opts.author, label: `token ${path}` });
  }

  private scopeOf(e: { actorId?: string; tokenId?: string }): string {
    return e.actorId ? `${e.actorId}|${e.tokenId ?? ''}` : '';
  }

  /** '' means no one is identified (local mode): undo stays a single stack over every change. */
  private currentScope(): string {
    const who = this.attribution?.();
    return who ? this.scopeOf(who) : '';
  }

  private clearRedo(entry: ChangeEntry): void {
    const scope = this.scopeOf(entry);
    this.redoStack = scope ? this.redoStack.filter((r) => this.scopeOf(r) !== scope) : [];
  }

  /** Revert the caller's latest change. Whatever someone else has changed since is left as they made it. */
  undo(): ChangeEntry | undefined {
    const scope = this.currentScope();
    let index = this.history.length - 1;
    while (index >= 0 && scope && this.scopeOf(this.history[index]!) !== scope) index--;
    if (index < 0) return undefined;
    const entry = this.history[index]!;
    const later = this.history.slice(index + 1);
    const { ops, stayed } = this.withoutConflicts(entry.inverse, later);
    const { inverse, touched } = this.runCompensation(ops);
    this.history.splice(index, 1);
    const undone: ChangeEntry = {
      seq: ++this.seq,
      author: entry.author,
      label: `undo ${entry.label ?? ''}`.trim(),
      time: Date.now(),
      ops,
      inverse,
      touched,
      ...this.attribution?.(),
      undoOf: entry.seq,
    };
    this.redoStack.push({ ...entry, ops: inverse, inverse: ops, undoneAt: undone.seq });
    for (const l of this.listeners) l(undone);
    return stayed ? { ...entry, stayed } : entry;
  }

  redo(): ChangeEntry | undefined {
    const scope = this.currentScope();
    let index = this.redoStack.length - 1;
    while (index >= 0 && scope && this.scopeOf(this.redoStack[index]!) !== scope) index--;
    if (index < 0) return undefined;
    const entry = this.redoStack[index]!;
    this.redoStack.splice(index, 1);
    const since = this.history.filter((e) => e.seq > entry.undoneAt && this.scopeOf(e) !== this.scopeOf(entry));
    const { ops, stayed } = this.withoutConflicts(entry.ops, since);
    const { inverse, touched } = this.runCompensation(ops);
    const { undoneAt, ...rest } = entry;
    const redone: ChangeEntry = { ...rest, seq: ++this.seq, ops, inverse, touched, time: Date.now(), redoOf: undoneAt, ...this.attribution?.() };
    this.history.push(redone);
    for (const l of this.listeners) l(redone);
    return stayed ? { ...redone, stayed } : redone;
  }

  private runCompensation(ops: readonly Op[]): { inverse: Op[]; touched: string[] } {
    const touched = new Set<string>();
    const inverse: Op[] = [];
    for (const op of ops) inverse.unshift(...this.applyOne(op, touched, []));
    return { inverse, touched: [...touched] };
  }

  /** The node and everything inside it, as it is now. */
  private subtreeIds(pageId: string | undefined, id: string): string[] {
    const key = pageId ?? this.defaultPageId;
    const page = Object.hasOwn(this.data.pages, key) ? this.data.pages[key] : undefined;
    if (!page) return [];
    const out: string[] = [];
    const walk = (nid: string) => {
      const n = Object.hasOwn(page.nodes, nid) ? page.nodes[nid] : undefined;
      if (!n) return;
      out.push(nid);
      for (const c of n.children ?? []) walk(c);
    };
    walk(id);
    return out;
  }

  /** Drop the parts of an undo that would overwrite what someone else has changed since. */
  private withoutConflicts(ops: readonly Op[], later: readonly ChangeEntry[]): { ops: Op[]; stayed: number } {
    if (!later.length) return { ops: clone(ops) as Op[], stayed: 0 };
    const paths = new Map<string, string[][]>();
    const moved = new Set<string>();
    const everything = new Set<string>();
    const note = (key: string, path: string[]) => {
      let list = paths.get(key);
      if (!list) paths.set(key, (list = []));
      list.push(path);
    };
    for (const e of later) {
      for (const t of e.touched) everything.add(t);
      for (const op of e.ops) {
        if (op.op === 'patch') for (const s of op.sets) note(op.id, s.path);
        else if (op.op === 'patchTokens') for (const s of op.sets) note('$tokens', s.path);
        else if (op.op === 'update') for (const k of Object.keys(op.patch)) note(op.id, [k]);
        else if (op.op === 'setTokens') note('$tokens', []);
        else if (op.op === 'move' || op.op === 'delete') moved.add(op.id);
      }
    }
    const blocked = (key: string, path: string[]) => (paths.get(key) ?? []).some((p) => pathsOverlap(p, path));
    const out: Op[] = [];
    let stayed = 0;
    for (const op of ops) {
      switch (op.op) {
        case 'patch':
        case 'patchTokens': {
          const key = op.op === 'patch' ? op.id : '$tokens';
          const sets = op.sets.filter((s) => !blocked(key, s.path));
          stayed += op.sets.length - sets.length;
          if (sets.length) out.push({ ...clone(op), sets: clone(sets) });
          break;
        }
        case 'delete':
          if (this.subtreeIds(op.page, op.id).some((id) => everything.has(id))) stayed++;
          else out.push(clone(op));
          break;
        case 'restore': {
          const page = Object.hasOwn(this.data.pages, op.page) ? this.data.pages[op.page] : undefined;
          if (!page || (op.parent && !page.nodes[op.parent]) || op.nodes.some((n) => page.nodes[n.id])) stayed++;
          else out.push(clone(op));
          break;
        }
        case 'move': {
          const page = this.page(op.page);
          if (moved.has(op.id) || !page.nodes[op.id] || (op.parent && !page.nodes[op.parent])) stayed++;
          else out.push(clone(op));
          break;
        }
        default: {
          const key = docLevelKey(op);
          if (key && (everything.has(key) || paths.has(key))) stayed++;
          else out.push(clone(op));
        }
      }
    }
    return { ops: out, stayed };
  }

  /** The node fields a patch would leave behind, for validation; undefined when the node is missing. */
  previewNodePatch(op: Extract<Op, { op: 'patch' }>): Record<string, unknown> | undefined {
    const page = this.page(op.page);
    const node = Object.hasOwn(page.nodes, op.id) ? page.nodes[op.id] : undefined;
    if (!node) return undefined;
    const copy: Record<string, unknown> = {};
    for (const k of new Set(op.sets.map((s) => s.path[0]!))) {
      if (Object.hasOwn(node, k)) copy[k] = clone((node as unknown as Record<string, unknown>)[k]);
    }
    applySets({ copy }, 'copy', op.sets);
    return copy;
  }

  /** The form a change is stored in: resolved page, and property-level patches instead of whole values. */
  private normalize(op: Op): Op {
    switch (op.op) {
      case 'update': {
        const page = this.page(op.page);
        const node = page.nodes[op.id];
        if (!node) throw new RangoliError('NODE_NOT_FOUND', `Node #${op.id} not found`);
        const sets: PathSet[] = [];
        for (const key of Object.keys(op.patch)) {
          const val = (op.patch as Record<string, unknown>)[key];
          const before = (node as unknown as Record<string, unknown>)[key];
          if (val === undefined || val === null) {
            if (before !== undefined) sets.push({ path: [key] });
          } else sets.push(...diffSets(before, val, { prefix: [key] }));
        }
        return { op: 'patch', page: page.id, id: op.id, sets };
      }
      case 'setTokens':
        return { op: 'patchTokens', sets: diffSets(this.data.tokens, op.tokens, { ordered: true }) };
      case 'create':
      case 'delete':
      case 'move':
      case 'patch':
        return { ...op, page: this.page(op.page).id };
      default:
        return op;
    }
  }

  // ---------- durable log ----------

  /** Apply stored ops to rebuild state. They were validated when first applied; paths are still checked. */
  replay(ops: readonly Op[]): void {
    for (const op of ops) this.applyOne(op, new Set(), []);
  }

  /** Apply one change that was already committed elsewhere, and record it. */
  applyCommitted(entry: ChangeEntry): void {
    this.replay(entry.ops);
    this.seq = Math.max(this.seq, entry.seq);
    this.record(entry);
  }

  /** Rebuild undo state from stored changes, oldest first, and continue numbering after `headSeq`. */
  restoreHistory(entries: readonly ChangeEntry[], headSeq: number): void {
    this.history = [];
    this.redoStack = [];
    this.seq = headSeq;
    for (const e of entries) this.record(e);
  }

  private record(entry: ChangeEntry): void {
    if (entry.undoOf !== undefined) {
      const at = this.history.findIndex((e) => e.seq === entry.undoOf);
      if (at >= 0) {
        const [orig] = this.history.splice(at, 1);
        this.redoStack.push({ ...orig!, ops: entry.inverse, inverse: entry.ops, undoneAt: entry.seq });
      }
    } else if (entry.redoOf !== undefined) {
      const at = this.redoStack.findIndex((e) => e.undoneAt === entry.redoOf);
      if (at >= 0) this.redoStack.splice(at, 1);
      this.history.push(entry);
    } else if (!entry.noHistory) {
      this.history.push(entry);
      this.clearRedo(entry);
    }
  }

  /** Take back changes that never reached durable storage, newest first. Numbering resumes where they began. */
  rollback(entries: readonly ChangeEntry[]): void {
    if (!entries.length) return;
    const seqs = new Set(entries.map((e) => e.seq));
    for (const entry of [...entries].reverse()) this.replay(entry.inverse);
    this.history = this.history.filter((e) => !seqs.has(e.seq));
    this.redoStack = this.redoStack.filter((e) => !seqs.has(e.undoneAt));
    this.seq = Math.min(...seqs) - 1;
  }

  private applyOne(op: Op, touched: Set<string>, created: string[]): Op[] {
    switch (op.op) {
      case 'create': {
        const page = this.page(op.page);
        // assign id on the op itself so history/redo replays with the same id
        if (!op.node.id) op.node.id = this.ids.make();
        const node = clone(op.node);
        if (page.nodes[node.id]) throw new RangoliError('DUPLICATE_ID', `Node #${node.id} already exists`);
        this.ids.observe(node.id);
        if (op.parent && !page.nodes[op.parent]) throw new RangoliError('NODE_NOT_FOUND', `Parent #${op.parent} not found`);
        node.parent = op.parent;
        node.children = node.children ?? (canHaveChildren(node) ? [] : undefined);
        // children listed on the incoming node must already be created separately; keep as given
        page.nodes[node.id] = node;
        const list = op.parent ? (page.nodes[op.parent]!.children ??= []) : page.children;
        insertAt(list, node.id, op.index);
        touched.add(node.id);
        created.push(node.id);
        if (op.parent) touched.add(op.parent);
        return [{ op: 'delete', page: page.id, id: node.id }];
      }
      case 'update': {
        const page = this.page(op.page);
        const node = page.nodes[op.id];
        if (!node) throw new RangoliError('NODE_NOT_FOUND', `Node #${op.id} not found`);
        const before: Record<string, unknown> = {};
        for (const key of Object.keys(op.patch) as (keyof typeof op.patch)[]) {
          before[key] = node[key] === undefined ? undefined : clone(node[key]);
          const val = op.patch[key];
          if (val === undefined || val === null) delete (node as unknown as Record<string, unknown>)[key];
          else (node as unknown as Record<string, unknown>)[key] = clone(val);
        }
        touched.add(node.id);
        return [{ op: 'update', page: page.id, id: node.id, patch: before as Partial<RNode> }];
      }
      case 'patch': {
        const page = this.page(op.page);
        const node = page.nodes[op.id];
        if (!node) throw new RangoliError('NODE_NOT_FOUND', `Node #${op.id} not found`);
        const sets = this.patchSets(() => applySets(page.nodes as unknown as Record<string, unknown>, node.id, op.sets));
        touched.add(node.id);
        return [{ op: 'patch', page: page.id, id: node.id, sets }];
      }
      case 'patchTokens': {
        const sets = this.patchSets(() => applySets(this.data as unknown as Record<string, unknown>, 'tokens', op.sets));
        touched.add('$tokens');
        return [{ op: 'patchTokens', sets }];
      }
      case 'delete': {
        const page = this.page(op.page);
        const node = page.nodes[op.id];
        if (!node) throw new RangoliError('NODE_NOT_FOUND', `Node #${op.id} not found`);
        const list = node.parent ? page.nodes[node.parent]?.children ?? [] : page.children;
        const index = list.indexOf(node.id);
        const removed: RNode[] = [];
        const collect = (id: string) => {
          const n = page.nodes[id];
          if (!n) return;
          removed.push(clone(n));
          for (const c of n.children ?? []) collect(c);
          delete page.nodes[id];
          touched.add(id);
        };
        collect(node.id);
        if (index >= 0) list.splice(index, 1);
        if (node.parent) touched.add(node.parent);
        return [{ op: 'restore', page: page.id, nodes: removed, parent: node.parent, index }];
      }
      case 'restore': {
        const page = this.page(op.page);
        for (const n of op.nodes) {
          page.nodes[n.id] = clone(n);
          touched.add(n.id);
        }
        const rootId = op.nodes[0]?.id;
        if (!rootId) return [];
        const list = op.parent ? (page.nodes[op.parent]!.children ??= []) : page.children;
        insertAt(list, rootId, op.index);
        return [{ op: 'delete', page: page.id, id: rootId }];
      }
      case 'move': {
        const page = this.page(op.page);
        const node = page.nodes[op.id];
        if (!node) throw new RangoliError('NODE_NOT_FOUND', `Node #${op.id} not found`);
        if (op.parent) {
          if (!page.nodes[op.parent]) throw new RangoliError('NODE_NOT_FOUND', `Parent #${op.parent} not found`);
          // prevent cycles
          let p: string | undefined = op.parent;
          while (p) {
            if (p === node.id) throw new RangoliError('CYCLE', `Cannot move #${node.id} into its own descendant`);
            p = page.nodes[p]?.parent;
          }
        }
        const fromList = node.parent ? page.nodes[node.parent]!.children ?? [] : page.children;
        const fromIndex = fromList.indexOf(node.id);
        const fromParent = node.parent;
        if (fromIndex >= 0) fromList.splice(fromIndex, 1);
        const toList = op.parent ? (page.nodes[op.parent]!.children ??= []) : page.children;
        insertAt(toList, node.id, op.index);
        node.parent = op.parent;
        touched.add(node.id);
        if (fromParent) touched.add(fromParent);
        if (op.parent) touched.add(op.parent);
        return [{ op: 'move', page: page.id, id: node.id, parent: fromParent, index: fromIndex }];
      }
      case 'setTokens': {
        const before = clone(this.data.tokens);
        this.data.tokens = clone(op.tokens);
        touched.add('$tokens');
        return [{ op: 'setTokens', tokens: before }];
      }
      case 'setComponent': {
        const prev = this.data.components[op.component.id];
        this.data.components[op.component.id] = clone(op.component);
        touched.add(`$component:${op.component.id}`);
        return prev ? [{ op: 'setComponent', component: clone(prev) }] : [{ op: 'deleteComponent', id: op.component.id }];
      }
      case 'setMotion': {
        const motion = (this.data.motion ??= {});
        const prev = motion[op.target];
        if (op.def) motion[op.target] = clone(op.def);
        else delete motion[op.target];
        touched.add(`$motion:${op.target}`);
        return [{ op: 'setMotion', target: op.target, def: prev ? clone(prev) : null }];
      }
      case 'setInteractions': {
        const p = (this.data.prototype ??= { interactions: {} });
        const prev = p.interactions[op.node];
        if (op.list && op.list.length) p.interactions[op.node] = clone(op.list);
        else delete p.interactions[op.node];
        touched.add(`$proto:${op.node}`);
        return [{ op: 'setInteractions', node: op.node, list: prev ? clone(prev) : null }];
      }
      case 'setProtoStart': {
        const p = (this.data.prototype ??= { interactions: {} });
        const prev = p.start ?? null;
        if (op.frame) p.start = op.frame;
        else delete p.start;
        touched.add('$proto:start');
        return [{ op: 'setProtoStart', frame: prev }];
      }
      case 'setProtoVars': {
        const p = (this.data.prototype ??= { interactions: {} });
        const prev = p.variables ?? null;
        if (op.vars) p.variables = clone(op.vars);
        else delete p.variables;
        touched.add('$proto:vars');
        return [{ op: 'setProtoVars', vars: prev ? clone(prev) : null }];
      }
      case 'setTimeline': {
        const tl = (this.data.timelines ??= {});
        const prev = tl[op.name];
        if (op.def) tl[op.name] = clone(op.def);
        else delete tl[op.name];
        touched.add(`$timeline:${op.name}`);
        return [{ op: 'setTimeline', name: op.name, def: prev ? clone(prev) : null }];
      }
      case 'setIconSet': {
        const sets = (this.data.icons ??= {});
        const prev = sets[op.name];
        if (op.def) sets[op.name] = clone(op.def);
        else delete sets[op.name];
        touched.add(`$iconset:${op.name}`);
        return [{ op: 'setIconSet', name: op.name, def: prev ? clone(prev) : null }];
      }
      case 'setIcon': {
        const set = this.data.icons?.[op.set];
        if (!set) throw new RangoliError('ICONSET_NOT_FOUND', `Icon set "${op.set}" not found`);
        const prev = set.icons[op.name];
        if (op.icon) set.icons[op.name] = clone(op.icon);
        else delete set.icons[op.name];
        touched.add(`$icon:${op.set}/${op.name}`);
        return [{ op: 'setIcon', set: op.set, name: op.name, icon: prev ? clone(prev) : null }];
      }
      case 'setAsset': {
        const assets = (this.data.assets ??= {});
        const prev = assets[op.id];
        if (op.meta) assets[op.id] = clone(op.meta);
        else delete assets[op.id];
        touched.add(`$asset:${op.id}`);
        return [{ op: 'setAsset', id: op.id, meta: prev ? clone(prev) : null }];
      }
      case 'deleteComponent': {
        const prev = this.data.components[op.id];
        if (!prev) throw new RangoliError('COMPONENT_NOT_FOUND', `Component ${op.id} not found`);
        delete this.data.components[op.id];
        touched.add(`$component:${op.id}`);
        return [{ op: 'setComponent', component: clone(prev) }];
      }
    }
  }

  private patchSets(run: () => PathSet[]): PathSet[] {
    try {
      return run();
    } catch (e) {
      throw new RangoliError('INVALID_OP', e instanceof Error ? e.message : String(e));
    }
  }

  toJSON(): DocumentData {
    return clone(this.data);
  }
}

/** What applyOne records as touched for ops outside the page tree. */
function docLevelKey(op: Op): string | undefined {
  switch (op.op) {
    case 'setTokens':
      return '$tokens';
    case 'setComponent':
      return `$component:${op.component.id}`;
    case 'deleteComponent':
      return `$component:${op.id}`;
    case 'setMotion':
      return `$motion:${op.target}`;
    case 'setInteractions':
      return `$proto:${op.node}`;
    case 'setProtoStart':
      return '$proto:start';
    case 'setProtoVars':
      return '$proto:vars';
    case 'setTimeline':
      return `$timeline:${op.name}`;
    case 'setIconSet':
      return `$iconset:${op.name}`;
    case 'setIcon':
      return `$icon:${op.set}/${op.name}`;
    case 'setAsset':
      return `$asset:${op.id}`;
    default:
      return undefined;
  }
}

function canHaveChildren(n: RNode): boolean {
  return n.type === 'frame' || n.type === 'group' || n.type === 'instance';
}

function insertAt(list: string[], id: string, index?: number): void {
  if (index === undefined || index < 0 || index >= list.length) list.push(id);
  else list.splice(index, 0, id);
}
