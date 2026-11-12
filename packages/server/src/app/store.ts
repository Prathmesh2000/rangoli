import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssetMeta, ChangeEntry, DocumentData, Page, RangoliDocument, ReviewData } from '@rangoli/engine';
import { tokenActor, withUser, type Database, type Q } from './db.js';
import type { BlobStore } from './infra.js';
import type { AgentMode, DesignStore } from '../session.js';
import { designLogEnabled, hashJson, replayPage, rowScope, type CommitBatch, type DesignLog, type LoadedLog } from '../design/log.js';

/** The signed-in user behind the current request, so writes reach the database under their identity. */
export const actor = new AsyncLocalStorage<string>();

/**
 * Persists one project's design through RLS. Nothing here runs with elevated rights: a save is
 * attributed to whoever made the change, and the database decides whether that person may make it.
 */
export const projectBlobPrefix = (orgId: string, projectId: string): string => `orgs/${orgId}/projects/${projectId}/assets/`;

export class DbStore implements DesignStore {
  readonly location = '';
  private docActor: string | null = null;
  private reviewActor: string | null = null;
  private readonly bytes = new Map<string, Buffer>();
  private warmed = false;

  constructor(
    private readonly db: Database,
    private readonly projectId: string,
    private readonly orgId: string,
    /** the database refused a save, so memory no longer matches what is stored */
    private readonly onRejected: () => void,
    private readonly blobs?: BlobStore,
  ) {
    this.log = designLogEnabled() ? new DbDesignLog(db, projectId, orgId) : undefined;
  }

  /** set when the RANGOLI_DESIGN_LOG flag is on; without it, saves stay whole-blob */
  readonly log: DesignLog | undefined;

  /** The person behind the current change, so history and undo can be per-author. */
  readonly attribution = () => {
    const actorId = actor.getStore() ?? this.docActor ?? undefined;
    return actorId ? { actorId, tokenId: tokenActor.getStore() } : undefined;
  };

  noteLogRefused(): void {
    this.onRejected();
  }

  private key(file: string): string {
    return projectBlobPrefix(this.orgId, this.projectId) + file;
  }

  noteDocChange(): void {
    this.docActor = actor.getStore() ?? this.docActor;
  }

  noteReviewChange(): void {
    this.reviewActor = actor.getStore() ?? this.reviewActor;
  }

  private as<T>(fn: Parameters<typeof withUser<T>>[2], user = actor.getStore() ?? null): Promise<T> {
    return withUser(this.db, user, fn);
  }

  async saveDocument(doc: RangoliDocument): Promise<void> {
    const rows = await this.as(
      (q) => q(`UPDATE designs SET data = $1::json, updated_by = app_uid(), updated_at = clock_timestamp() WHERE project_id = $2 RETURNING 1`, [JSON.stringify(doc.data), this.projectId]),
      this.docActor,
    );
    if (!rows.length) this.onRejected();
  }

  async saveReviews(reviews: ReviewData & { agentMode: AgentMode }): Promise<void> {
    const rows = await this.as(
      (q) => q(`UPDATE design_reviews SET data = $1::json, updated_at = clock_timestamp() WHERE project_id = $2 RETURNING 1`, [JSON.stringify(reviews), this.projectId]),
      this.reviewActor,
    );
    if (!rows.length) this.onRejected();
  }

  async loadReviews() {
    const [row] = await this.as((q) => q<{ data: (Partial<ReviewData> & { agentMode?: AgentMode }) | null }>(`SELECT data FROM design_reviews WHERE project_id = $1`, [this.projectId]));
    return row?.data ?? null;
  }

  async putAsset(file: string, mime: string, buf: Buffer): Promise<void> {
    // the row goes first: RLS decides whether this person may store anything at all
    const inserted = await this.as((q) => q(`INSERT INTO design_assets (project_id, org_id, file, mime, bytes, storage, size) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING RETURNING 1`, [this.projectId, this.orgId, file, mime, this.blobs ? null : buf, this.blobs ? 's3' : 'db', buf.length]));
    if (this.blobs && inserted.length) {
      try {
        await this.blobs.put(this.key(file), buf, mime);
      } catch (e) {
        await this.as((q) => q(`DELETE FROM design_assets WHERE project_id = $1 AND file = $2`, [this.projectId, file]));
        throw e;
      }
    }
    this.bytes.set(file, buf);
  }

  async readAssetFile(file: string): Promise<Buffer | null> {
    // always asks the database, so access is decided per request and never by what is cached
    const [row] = await this.as((q) => q<{ bytes: Uint8Array | null; storage: string }>(`SELECT bytes, storage FROM design_assets WHERE project_id = $1 AND file = $2`, [this.projectId, file]));
    if (!row) return null;
    if (row.storage === 's3') return (await this.blobs?.get(this.key(file))) ?? null;
    return row.bytes ? Buffer.from(row.bytes) : null;
  }

  async warmAssets(): Promise<void> {
    if (this.warmed) return;
    const rows = await this.as((q) => q<{ file: string; bytes: Uint8Array | null; storage: string }>(`SELECT file, bytes, storage FROM design_assets WHERE project_id = $1`, [this.projectId]));
    for (const r of rows) if (r.bytes) this.bytes.set(r.file, Buffer.from(r.bytes));
    const remote = rows.filter((r) => r.storage === 's3' && !this.bytes.has(r.file));
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let r = remote.pop(); r; r = remote.pop()) {
        const buf = await this.blobs?.get(this.key(r.file));
        if (buf) this.bytes.set(r.file, buf);
      }
    }));
    this.warmed = true;
  }

  assetDataUri(meta: AssetMeta): string {
    const buf = this.bytes.get(meta.file);
    return buf ? `data:${meta.mime};base64,${buf.toString('base64')}` : '';
  }

  async putVersion(id: string, data: DocumentData): Promise<void> {
    await this.as((q) => q(`INSERT INTO design_versions (project_id, org_id, version_id, data) VALUES ($1, $2, $3, $4::json)`, [this.projectId, this.orgId, id, JSON.stringify(data)]));
  }

  async getVersion(id: string): Promise<DocumentData | null> {
    const [row] = await this.as((q) => q<{ data: DocumentData }>(`SELECT data FROM design_versions WHERE project_id = $1 AND version_id = $2`, [this.projectId, id]));
    return row?.data ?? null;
  }
}

/** The history window kept for undo beyond the checkpoint tail. */
const HISTORY_WINDOW = 200;

const SET_IDENTITY = `SELECT set_config('app.user_id', $1, true), set_config('app.token_id', $2, true)`;
const ROW_COLUMNS = `seq::float8 AS seq, actor_id, token_id, author, label, ops, inverse, touched, undo_of::float8 AS undo_of, redo_of::float8 AS redo_of, no_history, (extract(epoch FROM created_at) * 1000)::float8 AS time`;

interface OpRow {
  seq: number;
  actor_id: string | null;
  token_id: string | null;
  author: string;
  label: string | null;
  ops: ChangeEntry['ops'];
  inverse: ChangeEntry['inverse'];
  touched: string[];
  undo_of: number | null;
  redo_of: number | null;
  no_history: boolean;
  time: number;
}

const toEntry = (r: OpRow): ChangeEntry => ({
  seq: r.seq,
  author: r.author,
  ...(r.label === null ? {} : { label: r.label }),
  time: r.time,
  ops: r.ops,
  inverse: r.inverse,
  touched: r.touched,
  ...(r.actor_id ? { actorId: r.actor_id } : {}),
  ...(r.token_id ? { tokenId: r.token_id } : {}),
  ...(r.undo_of === null ? {} : { undoOf: r.undo_of }),
  ...(r.redo_of === null ? {} : { redoOf: r.redo_of }),
  ...(r.no_history ? { noHistory: true } : {}),
});

const verifyHash = (json: string, stored: string, scope: string): void => {
  if (hashJson(json) !== stored) throw new Error(`Checkpoint for scope "${scope}" failed its integrity check`);
};

/** One project's operation log in Postgres: every row goes through RLS as the person who made the change. */
export class DbDesignLog implements DesignLog {
  constructor(private readonly db: Database, private readonly projectId: string, private readonly orgId: string) {}

  private read<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return withUser(this.db, actor.getStore() ?? null, fn);
  }

  async load(): Promise<LoadedLog | null> {
    return this.read(async (q) => {
      const scopes = await q<{ page_id: string; seq: number; data: unknown; hash: string }>(`SELECT page_id, seq::float8 AS seq, data, hash FROM design_pages WHERE project_id = $1`, [this.projectId]);
      if (!scopes.length) return null;
      for (const s of scopes) verifyHash(JSON.stringify(s.data), s.hash, s.page_id);
      const lowest = Math.min(...scopes.map((s) => s.seq));
      const [head] = await q<{ n: number }>(`SELECT coalesce(max(seq), 0)::float8 AS n FROM design_ops WHERE project_id = $1`, [this.projectId]);
      const headSeq = Math.max(head!.n, lowest);
      const rows = await q<OpRow>(`SELECT ${ROW_COLUMNS} FROM design_ops WHERE project_id = $1 AND seq > LEAST($2::bigint, $3::bigint) ORDER BY seq`, [this.projectId, lowest, Math.max(0, headSeq - HISTORY_WINDOW)]);
      return { scopes: scopes.map((s) => ({ scope: s.page_id, seq: s.seq, data: s.data })), rows: rows.map(toEntry), headSeq };
    });
  }

  async loadPage(pageId: string) {
    return this.read(async (q) => {
      const [row] = await q<{ seq: number; data: Page; hash: string }>(`SELECT seq::float8 AS seq, data, hash FROM design_pages WHERE project_id = $1 AND page_id = $2`, [this.projectId, pageId]);
      if (!row) return null;
      verifyHash(JSON.stringify(row.data), row.hash, pageId);
      const tail = await q<OpRow>(`SELECT ${ROW_COLUMNS} FROM design_ops WHERE project_id = $1 AND seq > $2 AND page_id IN ($3, '*') ORDER BY seq`, [this.projectId, row.seq, pageId]);
      return { page: replayPage({ data: row.data, seq: row.seq }, tail.map(toEntry)), seq: row.seq };
    });
  }

  async append(batch: CommitBatch): Promise<void> {
    const first = batch.entries[0];
    await withUser(this.db, first?.actorId ?? null, async (q) => {
      // one transaction, but each row is checked as the person who made it
      let userId: string | undefined;
      let tokenId: string | undefined;
      for (const e of batch.entries) {
        if (userId !== e.actorId || tokenId !== e.tokenId) {
          userId = e.actorId;
          tokenId = e.tokenId;
          await q(SET_IDENTITY, [userId ?? '', tokenId ?? '']);
        }
        await q(
          `INSERT INTO design_ops (project_id, org_id, seq, page_id, actor_kind, actor_id, token_id, author, label, ops, inverse, touched, undo_of, redo_of, no_history)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::json, $11::json, $12, $13, $14, $15)`,
          [this.projectId, this.orgId, e.seq, rowScope(e), e.tokenId ? 'agent' : 'human', e.actorId ?? null, e.tokenId ?? null, e.author, e.label ?? null, JSON.stringify(e.ops), JSON.stringify(e.inverse), e.touched, e.undoOf ?? null, e.redoOf ?? null, e.noHistory ?? false],
        );
      }
      for (const c of batch.checkpoints) {
        await q(`INSERT INTO design_checkpoints (project_id, org_id, page_id, seq, data, hash) VALUES ($1, $2, $3, $4, $5::json, $6) ON CONFLICT DO NOTHING`, [this.projectId, this.orgId, c.scope, c.seq, c.json, c.hash]);
        await q(
          `INSERT INTO design_pages (project_id, org_id, page_id, data, seq, hash) VALUES ($1, $2, $3, $4::json, $5, $6)
           ON CONFLICT (project_id, page_id) DO UPDATE SET data = EXCLUDED.data, seq = EXCLUDED.seq, hash = EXCLUDED.hash, updated_at = clock_timestamp() WHERE design_pages.seq < EXCLUDED.seq`,
          [this.projectId, this.orgId, c.scope, c.json, c.seq, c.hash],
        );
      }
    });
  }
}
