/**
 * The single writer for one project: changes are applied in memory first (the 5 ms edit path), appended to the
 * log with a small group-commit window, and only then acknowledged and published. A commit that fails is
 * compensated by reverting everything not yet durable, so memory never runs ahead of the database for long.
 */
import { opScope, type ChangeEntry, type RangoliDocument } from '@rangoli/engine';
import { documentScopeData, makeCheckpoint, type Checkpoint, type DesignLog } from './log.js';

export interface ActorOptions {
  /** group-commit window; architecture target 10-25 ms */
  windowMs?: number;
  /** checkpoint a scope once this many ops or bytes have accumulated since its last checkpoint */
  checkpointOps?: number;
  checkpointBytes?: number;
  /** a change was written durably: acknowledged edits are published from here */
  onCommitted?: (entries: ChangeEntry[]) => void;
  /** the log refused a change or stayed unreachable; the in-memory state was rolled back */
  onRefused?: (error: unknown) => void;
  /** true when the log already holds a checkpoint for this project */
  bootstrapped?: boolean;
  /** ops stored since each scope's checkpoint, when reopening */
  counters?: Map<string, { ops: number; bytes: number }>;
}

interface Waiter {
  seq: number;
  resolve: () => void;
  reject: (e: unknown) => void;
}

const RETRY_DELAYS_MS = [50, 200];

/** A refusal the database will repeat: no permission, or another writer took this sequence number. */
const isPermanent = (e: unknown): boolean => {
  const code = (e as { code?: string } | null)?.code;
  return code === '42501' || code === '23505';
};

export class ProjectActor {
  private pending: ChangeEntry[] = [];
  private waiters: Waiter[] = [];
  private timer: NodeJS.Timeout | undefined;
  private draining: Promise<void> | undefined;
  private committed: number;
  private enqueued: number;
  private bootstrapped: boolean;
  private refusal: unknown;
  private readonly windowMs: number;
  private readonly checkpointOps: number;
  private readonly checkpointBytes: number;
  private readonly counters: Map<string, { ops: number; bytes: number }>;

  constructor(private readonly doc: RangoliDocument, private readonly log: DesignLog, private readonly opts: ActorOptions = {}) {
    this.committed = this.enqueued = doc.headSeq;
    this.bootstrapped = opts.bootstrapped ?? false;
    this.counters = new Map(opts.counters);
    this.windowMs = opts.windowMs ?? 10;
    this.checkpointOps = opts.checkpointOps ?? 500;
    this.checkpointBytes = opts.checkpointBytes ?? 5 * 1024 * 1024;
  }

  /** Runs synchronously from the document's change listener, so log order is edit order. */
  enqueue(entry: ChangeEntry): void {
    if (this.refusal !== undefined) {
      // this writer has stopped: a change made after the refusal cannot be kept either
      this.doc.rollback([entry]);
      return;
    }
    this.pending.push(entry);
    this.enqueued = entry.seq;
    this.schedule();
  }

  /** Resolves once every change made so far is durable; rejects if any of them was rolled back. */
  commit(): Promise<void> {
    if (this.refusal !== undefined) return Promise.reject(this.refusal);
    if (this.enqueued <= this.committed) return Promise.resolve();
    const seq = this.enqueued;
    return new Promise((resolve, reject) => {
      this.waiters.push({ seq, resolve, reject });
      this.schedule();
    });
  }

  /** The window is what lets a burst of edits share one disk flush. */
  private schedule(): void {
    if (this.timer || this.draining || !this.pending.length) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.draining = this.drain().finally(() => {
        this.draining = undefined;
        this.schedule();
      });
    }, this.windowMs);
  }

  private checkpointsFor(batch: ChangeEntry[]): Checkpoint[] {
    for (const entry of batch) {
      for (const op of entry.ops) {
        const scope = opScope(op);
        const c = this.counters.get(scope) ?? { ops: 0, bytes: 0 };
        c.ops += 1;
        c.bytes += JSON.stringify(op).length;
        this.counters.set(scope, c);
      }
    }
    const seq = batch.at(-1)!.seq;
    const data = this.doc.data;
    const scopes = !this.bootstrapped
      ? ['', ...Object.keys(data.pages)]
      : [...this.counters].filter(([, c]) => c.ops >= this.checkpointOps || c.bytes >= this.checkpointBytes).map(([s]) => s);
    return scopes
      .filter((s) => s === '' || Object.hasOwn(data.pages, s))
      .map((scope) => {
        this.counters.delete(scope);
        return makeCheckpoint(scope, seq, scope === '' ? documentScopeData(data) : data.pages[scope]);
      });
  }

  private async drain(): Promise<void> {
    while (this.pending.length) {
      // all of it, in one go: memory holds exactly up to the last entry, which is what a checkpoint must describe
      const batch = this.pending;
      this.pending = [];
      const last = batch.at(-1)!.seq;
      let checkpoints: Checkpoint[];
      try {
        checkpoints = this.checkpointsFor(batch);
      } catch (error) {
        this.refuse(batch, error);
        return;
      }
      try {
        await this.appendWithRetry({ entries: batch, checkpoints });
      } catch (error) {
        this.refuse(batch, error);
        return;
      }
      this.bootstrapped = true;
      this.committed = last;
      for (const w of this.waiters.filter((x) => x.seq <= last)) w.resolve();
      this.waiters = this.waiters.filter((x) => x.seq > last);
      this.opts.onCommitted?.(batch);
    }
  }

  private async appendWithRetry(batch: Parameters<DesignLog['append']>[0]): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.log.append(batch);
        return;
      } catch (error) {
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay === undefined || isPermanent(error)) throw error;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private refuse(batch: ChangeEntry[], error: unknown): void {
    const lost = [...batch, ...this.pending];
    this.pending = [];
    this.refusal = error ?? new Error('The change could not be saved');
    this.doc.rollback(lost);
    const waiters = this.waiters;
    this.waiters = [];
    for (const w of waiters) w.reject(this.refusal);
    this.opts.onRefused?.(this.refusal);
  }

  /** Scopes this writer would checkpoint next, for tests and diagnostics. */
  get pendingCounts(): ReadonlyMap<string, { ops: number; bytes: number }> {
    return this.counters;
  }
}

