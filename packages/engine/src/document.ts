import { IdGen } from './ids.js';
import type { ComponentDef, DocumentData, Page, RNode, TokenTree } from './model.js';
import type { MotionDef } from './motion.js';
import type { Interaction, Timeline } from './prototype.js';

/** Atomic edit operations. Every op is reversible. */
export type Op =
  | { op: 'create'; page?: string; node: RNode; parent?: string; index?: number }
  | { op: 'update'; page?: string; id: string; patch: Partial<Omit<RNode, 'id' | 'children' | 'parent'>> }
  | { op: 'delete'; page?: string; id: string }
  | { op: 'move'; page?: string; id: string; parent?: string; index?: number }
  | { op: 'setTokens'; tokens: TokenTree }
  | { op: 'setComponent'; component: ComponentDef }
  | { op: 'deleteComponent'; id: string }
  /** set (def) or remove (null) a motion definition */
  | { op: 'setMotion'; target: string; def: MotionDef | null }
  | { op: 'setInteractions'; node: string; list: Interaction[] | null }
  | { op: 'setProtoStart'; frame: string | null }
  | { op: 'setTimeline'; name: string; def: Timeline | null }
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
}

export class RangoliError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const clone = <T>(v: T): T => structuredClone(v);

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
  private redoStack: ChangeEntry[] = [];
  private seq = 0;
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
    const p = this.data.pages[id ?? this.defaultPageId];
    if (!p) throw new RangoliError('PAGE_NOT_FOUND', `Page ${id} not found`);
    return p;
  }

  node(id: string, pageId?: string): RNode {
    const n = this.page(pageId).nodes[id];
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
    };
    this.history.push(entry);
    this.redoStack = [];
    for (const l of this.listeners) l(entry);
    return result;
  }

  private tx: { ops: Op[]; inverse: Op[]; touched: Set<string> } | undefined;

  apply(ops: Op[], opts: { author?: string; label?: string; recordHistory?: boolean } = {}): ApplyResult {
    const inverse: Op[] = [];
    const touched = new Set<string>();
    const created: string[] = [];
    try {
      for (const op of ops) {
        const inv = this.applyOne(op, touched, created);
        inverse.unshift(...inv);
      }
    } catch (err) {
      // roll back what was applied
      for (const inv of inverse) this.applyOne(inv, new Set(), []);
      throw err;
    }
    if (this.tx) {
      this.tx.ops.push(...clone(ops));
      this.tx.inverse.unshift(...inverse);
      for (const t of touched) this.tx.touched.add(t);
      return { seq: this.seq + 1, touched: [...touched], created };
    }
    const entry: ChangeEntry = {
      seq: ++this.seq,
      author: opts.author ?? 'human',
      label: opts.label,
      time: Date.now(),
      ops: clone(ops),
      inverse,
      touched: [...touched],
    };
    if (opts.recordHistory !== false) {
      this.history.push(entry);
      this.redoStack = [];
    }
    for (const l of this.listeners) l(entry);
    return { seq: entry.seq, touched: entry.touched, created };
  }

  undo(): ChangeEntry | undefined {
    const entry = this.history.pop();
    if (!entry) return undefined;
    const t = new Set<string>();
    for (const inv of entry.inverse) this.applyOne(inv, t, []);
    this.redoStack.push(entry);
    for (const l of this.listeners) l({ ...entry, ops: entry.inverse, inverse: entry.ops, label: `undo ${entry.label ?? ''}`.trim() });
    return entry;
  }

  redo(): ChangeEntry | undefined {
    const entry = this.redoStack.pop();
    if (!entry) return undefined;
    const t = new Set<string>();
    const inverse: Op[] = [];
    for (const op of entry.ops) inverse.unshift(...this.applyOne(op, t, []));
    const redone = { ...entry, inverse };
    this.history.push(redone);
    for (const l of this.listeners) l(redone);
    return redone;
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
      case 'setTimeline': {
        const tl = (this.data.timelines ??= {});
        const prev = tl[op.name];
        if (op.def) tl[op.name] = clone(op.def);
        else delete tl[op.name];
        touched.add(`$timeline:${op.name}`);
        return [{ op: 'setTimeline', name: op.name, def: prev ? clone(prev) : null }];
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

  toJSON(): DocumentData {
    return clone(this.data);
  }
}

function canHaveChildren(n: RNode): boolean {
  return n.type === 'frame' || n.type === 'group' || n.type === 'instance';
}

function insertAt(list: string[], id: string, index?: number): void {
  if (index === undefined || index < 0 || index >= list.length) list.push(id);
  else list.splice(index, 0, id);
}
