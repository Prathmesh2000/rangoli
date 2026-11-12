/**
 * The operation log: an append-only record of every change to one project, plus per-page checkpoints so a
 * load is checkpoint + a short tail rather than a full replay. See docs/ARCHITECTURE.md sections 2-4.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open as openFile, readFile, rename, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { RangoliDocument, opScope, type ChangeEntry, type DocumentData, type Op, type Page } from '@rangoli/engine';

/** Row scope when a change spans more than one page, or a page and the document. */
export const MULTI_SCOPE = '*';

export const designLogEnabled = (): boolean => /^(1|true|on)$/i.test(process.env.RANGOLI_DESIGN_LOG ?? '');

export interface Checkpoint {
  /** a page id, or '' for everything outside pages */
  scope: string;
  seq: number;
  /** serialized on the writer's turn, so it is exactly the state at `seq` */
  json: string;
  hash: string;
}

export interface CommitBatch {
  entries: ChangeEntry[];
  checkpoints: Checkpoint[];
}

export interface StoredScope {
  scope: string;
  seq: number;
  data: unknown;
}

export interface LoadedLog {
  scopes: StoredScope[];
  /** oldest first: the tail of every scope, and the recent changes undo needs */
  rows: ChangeEntry[];
  headSeq: number;
}

/** Where a project's change log lives. One writer per project (ProjectActor); the seq primary key fences any other. */
export interface DesignLog {
  /** null when nothing was logged yet: the design still lives in its legacy store */
  load(): Promise<LoadedLog | null>;
  /** one atomic, durable append; resolves only once the commit is on disk */
  append(batch: CommitBatch): Promise<void>;
  /** one page as of its latest commit, without touching the rest of the document */
  loadPage(pageId: string): Promise<{ page: Page; seq: number } | null>;
  /** every stored change after `seq`, oldest first, with its run id: whole-run undo and changes_since */
  readSince?(seq: number): Promise<(ChangeEntry & { runId?: string })[]>;
}

export const hashJson = (json: string): string => createHash('sha256').update(json).digest('hex');

export function makeCheckpoint(scope: string, seq: number, data: unknown): Checkpoint {
  const json = JSON.stringify(data);
  return { scope, seq, json, hash: hashJson(json) };
}

/** Everything except the pages, which are stored one row each. */
export function documentScopeData(data: DocumentData): Omit<DocumentData, 'pages'> {
  const { pages: _pages, ...rest } = data;
  return rest;
}

/** The scopes an entry's ops write to. */
export function entryScopes(entry: { ops: readonly Op[] }): Set<string> {
  return new Set(entry.ops.map(opScope));
}

/** The single value stored in `page_id`. */
export function rowScope(entry: { ops: readonly Op[] }): string {
  const scopes = entryScopes(entry);
  if (scopes.size === 0) return '';
  return scopes.size === 1 ? [...scopes][0]! : MULTI_SCOPE;
}

export interface Materialized {
  doc: RangoliDocument;
  /** per scope, ops stored since its checkpoint */
  counters: Map<string, { ops: number; bytes: number }>;
}

const opBytes = (op: Op): number => JSON.stringify(op).length;

/** Rebuild the document: every scope from its own checkpoint, then the rows newer than it. */
export function materialize(log: LoadedLog): Materialized {
  const seqOf = new Map(log.scopes.map((s) => [s.scope, s.seq]));
  const base = log.scopes.find((s) => s.scope === '');
  if (!base) throw new Error('The operation log has no document checkpoint');
  const pages: Record<string, Page> = {};
  for (const s of log.scopes) if (s.scope !== '') pages[s.scope] = s.data as Page;
  const doc = new RangoliDocument({ ...(base.data as Omit<DocumentData, 'pages'>), pages });
  const counters = new Map<string, { ops: number; bytes: number }>();
  for (const row of log.rows) {
    for (const op of row.ops) {
      const scope = opScope(op);
      if (row.seq <= (seqOf.get(scope) ?? 0)) continue;
      doc.replay([op]);
      const c = counters.get(scope) ?? { ops: 0, bytes: 0 };
      c.ops += 1;
      c.bytes += opBytes(op);
      counters.set(scope, c);
    }
  }
  return { doc, counters };
}

/** One page rebuilt from its own checkpoint and tail. */
export function replayPage(checkpoint: { data: Page; seq: number }, tail: readonly ChangeEntry[]): Page {
  const doc = new RangoliDocument({ manifest: { format: 'rangoli@1', name: '', pages: [{ id: checkpoint.data.id, name: checkpoint.data.name }] }, tokens: {}, components: {}, pages: { [checkpoint.data.id]: checkpoint.data } });
  for (const row of tail) if (row.seq > checkpoint.seq) doc.replay(row.ops.filter((op) => opScope(op) === checkpoint.data.id));
  return doc.page(checkpoint.data.id);
}

const scopeFile = (scope: string) => `checkpoint.${scope === '' ? '_doc' : encodeURIComponent(scope)}.json`;

/**
 * The log for the local tool: JSON lines beside the document, fsynced before a change is acknowledged.
 * The folder format stays the human-readable copy; this is what survives a crash between saves.
 */
export class FileDesignLog implements DesignLog {
  private readonly dir: string;
  private readonly file: string;
  private prepared = false;

  constructor(location: string) {
    this.dir = join(location, '.oplog');
    this.file = join(this.dir, 'ops.jsonl');
  }

  private async prepare(): Promise<void> {
    if (this.prepared) return;
    await mkdir(this.dir, { recursive: true });
    this.prepared = true;
  }

  private async readRows(): Promise<ChangeEntry[]> {
    if (!existsSync(this.file)) return [];
    const text = await readFile(this.file, 'utf8');
    const rows: ChangeEntry[] = [];
    let offset = 0;
    while (offset < text.length) {
      const end = text.indexOf('\n', offset);
      if (end < 0) {
        // a torn final write was never acknowledged: drop it so the next append starts on a clean line
        await truncate(this.file, Buffer.byteLength(text.slice(0, offset)));
        break;
      }
      const line = text.slice(offset, end);
      offset = end + 1;
      try {
        rows.push(JSON.parse(line) as ChangeEntry);
      } catch {
        if (offset >= text.length) {
          await truncate(this.file, Buffer.byteLength(text.slice(0, end - line.length)));
          break;
        }
        throw new Error(`The operation log is damaged at line ${rows.length + 1}`);
      }
    }
    return rows;
  }

  private async readCheckpoint(scope: string): Promise<StoredScope | null> {
    const file = join(this.dir, scopeFile(scope));
    if (!existsSync(file)) return null;
    const { seq, hash, data } = JSON.parse(await readFile(file, 'utf8')) as { seq: number; hash: string; data: unknown };
    if (hashJson(JSON.stringify(data)) !== hash) throw new Error(`Checkpoint for scope "${scope}" failed its integrity check`);
    return { scope, seq, data };
  }

  async load(): Promise<LoadedLog | null> {
    const base = await this.readCheckpoint('');
    if (!base) return null;
    const rows = await this.readRows();
    const scopes: StoredScope[] = [base];
    const manifest = (base.data as { manifest?: { pages?: { id: string }[] } }).manifest;
    for (const p of manifest?.pages ?? []) {
      const s = await this.readCheckpoint(p.id);
      if (s) scopes.push(s);
    }
    return { scopes, rows, headSeq: rows.at(-1)?.seq ?? Math.max(...scopes.map((s) => s.seq)) };
  }

  async append(batch: CommitBatch): Promise<void> {
    await this.prepare();
    // the log goes first: a checkpoint must never describe changes the log does not have
    if (batch.entries.length) {
      const handle = await openFile(this.file, 'a');
      try {
        await handle.appendFile(batch.entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    for (const c of batch.checkpoints) {
      const file = join(this.dir, scopeFile(c.scope));
      const tmp = `${file}.tmp`;
      const handle = await openFile(tmp, 'w');
      try {
        await handle.writeFile(`{"seq":${c.seq},"hash":"${c.hash}","data":${c.json}}\n`);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    }
  }

  async readSince(seq: number): Promise<(ChangeEntry & { runId?: string })[]> {
    return (await this.readRows()).filter((r) => r.seq > seq);
  }

  async loadPage(pageId: string): Promise<{ page: Page; seq: number } | null> {
    const c = await this.readCheckpoint(pageId);
    if (!c) return null;
    return { page: replayPage({ data: c.data as Page, seq: c.seq }, await this.readRows()), seq: c.seq };
  }
}

