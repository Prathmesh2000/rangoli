/**
 * Named runs over the change history (PRD §11, ARCHITECTURE §4 "Whole-run undo").
 *
 * Every change an agent makes inside a run carries the run's id. A person can undo the whole run: its changes
 * are walked newest first and their inverses applied, except for any property somebody outside the run has
 * written since. Those are left as that person made them and counted, so the report can say "2 changes stayed".
 */
import { pathsOverlap, type ChangeEntry, type Op, type RangoliDocument } from '@rangoli/engine';

/** A change as the history stores it, with the run it belongs to (design_ops.run_id). */
export type RunTaggedEntry = ChangeEntry & { runId?: string };

export const runIdOf = (e: ChangeEntry): string | undefined => (e as RunTaggedEntry).runId;

/**
 * The recent changes of one open document, in order, including undos and changes that keep no undo step.
 * The engine's own history drops undone entries; whole-run undo and `changes_since` need every write.
 */
export class RunLedger {
  private entries: RunTaggedEntry[] = [];
  constructor(private readonly max = 20000) {}

  record(entry: ChangeEntry): void {
    const last = this.entries.at(-1);
    // a rollback renumbers: anything at or after a reused sequence number was never kept
    if (last && entry.seq <= last.seq) this.entries = this.entries.filter((e) => e.seq < entry.seq);
    this.entries.push(entry as RunTaggedEntry);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
  }

  /** Changes taken back because they never became durable. */
  forget(seqs: Iterable<number>): void {
    const gone = new Set(seqs);
    this.entries = this.entries.filter((e) => !gone.has(e.seq));
  }

  /** Every remembered change after `seq`, oldest first. */
  since(seq: number): RunTaggedEntry[] {
    return this.entries.filter((e) => e.seq > seq);
  }

  /** The oldest sequence number still remembered, or undefined when nothing is. */
  get oldest(): number | undefined {
    return this.entries[0]?.seq;
  }

  /** Changes in a run, oldest first. */
  ofRun(runId: string): RunTaggedEntry[] {
    return this.entries.filter((e) => e.runId === runId);
  }
}

/** One part of a run's undo that was left alone, and why. */
export interface StayedChange {
  seq: number;
  /** the layer id, "$tokens", "$component:…" and so on */
  target: string;
  path?: string[];
  /** the later change, by someone outside the run, that kept it */
  keptBy?: number;
}

export interface RunUndoPlan {
  /** inverse ops to apply, newest change first */
  ops: { op: Op; seq: number; target: string }[];
  stayed: StayedChange[];
  /** the run's own changes, counted */
  runChanges: number;
}

/** What each op addresses: '$tokens', '$component:id', a node id and so on. */
function targetOf(op: Op): string {
  switch (op.op) {
    case 'create':
      return op.node.id;
    case 'update':
    case 'patch':
    case 'delete':
    case 'move':
      return op.id;
    case 'restore':
      return op.nodes[0]?.id ?? '';
    case 'setTokens':
    case 'patchTokens':
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
  }
}

interface LaterWrites {
  /** every target written, with the latest seq */
  touched: Map<string, number>;
  /** property paths written, per target */
  paths: Map<string, { path: string[]; seq: number }[]>;
  /** nodes moved or deleted */
  moved: Map<string, number>;
}

function laterWrites(entries: readonly RunTaggedEntry[]): LaterWrites {
  const out: LaterWrites = { touched: new Map(), paths: new Map(), moved: new Map() };
  const path = (key: string, p: string[], seq: number) => {
    let list = out.paths.get(key);
    if (!list) out.paths.set(key, (list = []));
    list.push({ path: p, seq });
  };
  for (const e of entries) {
    for (const t of e.touched) out.touched.set(t, Math.max(out.touched.get(t) ?? 0, e.seq));
    for (const op of e.ops) {
      if (op.op === 'patch') for (const s of op.sets) path(op.id, s.path, e.seq);
      else if (op.op === 'patchTokens') for (const s of op.sets) path('$tokens', s.path, e.seq);
      else if (op.op === 'update') for (const k of Object.keys(op.patch)) path(op.id, [k], e.seq);
      else if (op.op === 'setTokens') path('$tokens', [], e.seq);
      else if (op.op === 'move' || op.op === 'delete') out.moved.set(op.id, Math.max(out.moved.get(op.id) ?? 0, e.seq));
    }
  }
  return out;
}

/**
 * Plan the undo of a whole run. `entries` is every change from the run's first one onwards, oldest first.
 * A part of the run stays when someone outside the run wrote the same property (or the same layer, for
 * structural changes) after the run's change: whatever they did later is theirs and is kept.
 */
export function planRunUndo(entries: readonly RunTaggedEntry[], runId: string, subtree: (id: string) => string[] = (id) => [id]): RunUndoPlan {
  const run = entries.filter((e) => e.runId === runId);
  const ops: RunUndoPlan['ops'] = [];
  const stayed: StayedChange[] = [];
  for (const entry of [...run].reverse()) {
    const after = laterWrites(entries.filter((e) => e.seq > entry.seq && e.runId !== runId));
    const writtenAfter = (key: string, p: string[]) => after.paths.get(key)?.find((w) => pathsOverlap(w.path, p))?.seq;
    for (const op of entry.inverse) {
      const target = targetOf(op);
      switch (op.op) {
        case 'patch':
        case 'patchTokens': {
          const key = op.op === 'patch' ? op.id : '$tokens';
          const kept: typeof op.sets = [];
          for (const s of op.sets) {
            const by = writtenAfter(key, s.path);
            if (by !== undefined) stayed.push({ seq: entry.seq, target: key, path: s.path, keptBy: by });
            else kept.push(s);
          }
          if (kept.length) ops.push({ op: { ...structuredClone(op), sets: structuredClone(kept) }, seq: entry.seq, target });
          break;
        }
        case 'delete': {
          // taking back a layer the run created: not if anyone outside the run has worked inside it since
          const by = subtree(op.id).map((id) => after.touched.get(id)).find((s) => s !== undefined);
          if (by !== undefined) stayed.push({ seq: entry.seq, target, keptBy: by });
          else ops.push({ op: structuredClone(op), seq: entry.seq, target });
          break;
        }
        case 'move': {
          const by = after.moved.get(op.id);
          if (by !== undefined) stayed.push({ seq: entry.seq, target, keptBy: by });
          else ops.push({ op: structuredClone(op), seq: entry.seq, target });
          break;
        }
        case 'restore':
        case 'create': {
          // bringing back what the run deleted: not over a layer someone has since made with the same id
          const by = after.touched.get(target);
          if (by !== undefined) stayed.push({ seq: entry.seq, target, keptBy: by });
          else ops.push({ op: structuredClone(op), seq: entry.seq, target });
          break;
        }
        default: {
          const by = after.touched.get(target) ?? after.paths.get(target)?.[0]?.seq;
          if (by !== undefined) stayed.push({ seq: entry.seq, target, keptBy: by });
          else ops.push({ op: structuredClone(op), seq: entry.seq, target });
        }
      }
    }
  }
  return { ops, stayed, runChanges: run.length };
}

export interface RunUndoReport {
  runId: string;
  /** parts of the run taken back */
  reverted: number;
  /** parts left as they are because someone else changed them later, or because they no longer apply */
  stayed: number;
  stayedDetails: StayedChange[];
  /** the change that did the undo, or null when there was nothing to take back */
  seq: number | null;
  message: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The sentence a person reads after Undo whole run. */
export function runUndoMessage(label: string, reverted: number, stayed: number): string {
  if (!reverted && !stayed) return `${label} had no changes to undo.`;
  const head = `Undid ${label}: ${plural(reverted, 'change')} taken back.`;
  return stayed ? `${head} ${plural(stayed, 'change')} stayed because someone changed ${stayed === 1 ? 'it' : 'them'} after the run.` : head;
}

/**
 * Apply a run's undo as one change by the person who asked for it. An inverse that no longer applies (its
 * layer is gone, say) also stays rather than failing the whole undo.
 */
export function undoRun(doc: RangoliDocument, entries: readonly RunTaggedEntry[], runId: string, opts: { author: string; label: string }): RunUndoReport {
  const subtree = (id: string): string[] => {
    const found = doc.findNode(id);
    if (!found) return [id];
    const out: string[] = [];
    const walk = (nid: string) => {
      const n = found.page.nodes[nid];
      if (!n) return;
      out.push(nid);
      for (const c of n.children ?? []) walk(c);
    };
    walk(id);
    return out;
  };
  const plan = planRunUndo(entries, runId, subtree);
  const stayed = [...plan.stayed];
  let reverted = 0;
  const before = doc.headSeq;
  doc.transact(() => {
    for (const { op, seq, target } of plan.ops) {
      try {
        doc.apply([op]);
        reverted += op.op === 'patch' || op.op === 'patchTokens' ? op.sets.length : 1;
      } catch {
        stayed.push({ seq, target });
      }
    }
  }, { author: opts.author, label: `undo ${opts.label}` });
  const stayedCount = stayed.length;
  return {
    runId,
    reverted,
    stayed: stayedCount,
    stayedDetails: stayed,
    seq: doc.headSeq > before ? doc.headSeq : null,
    message: runUndoMessage(opts.label, reverted, stayedCount),
  };
}

/** One change, as `changes_since` reports it. Labels and authors are people's text: untrusted. */
export interface ChangeSummary {
  seq: number;
  time: number;
  actor: 'person' | 'agent' | 'unknown';
  runId: string | null;
  touched: string[];
  undoOf?: number;
  untrusted: { author: string; label: string | null };
}

export function summarizeChange(e: RunTaggedEntry): ChangeSummary {
  return {
    seq: e.seq,
    time: e.time,
    actor: e.tokenId || e.runId || e.author.startsWith('agent') ? 'agent' : e.actorId || e.author.startsWith('human') ? 'person' : 'unknown',
    runId: e.runId ?? null,
    touched: e.touched.slice(0, 50),
    ...(e.undoOf === undefined ? {} : { undoOf: e.undoOf }),
    untrusted: { author: e.author, label: e.label ?? null },
  };
}
