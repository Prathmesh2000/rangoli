/**
 * Snapshots: an immutable, hashed and signed copy of a project's design, items, annotations and screen frames.
 *
 * Capturing reads the open design in memory (so it includes edits not yet flushed), works out which images the
 * screens use and hashes their bytes, then hashes every screen with packages/engine/src/snapshot-hash.ts. Writing
 * happens inside the caller's transaction, so a review request, its snapshot and its approval commit together.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  annotationsOf,
  cloneDocument,
  hashSnapshot,
  listScreens,
  screenDepsScanner,
  type AssetMeta,
  type DocumentData,
  type LifecycleItem,
  type ScreenFrameLink,
  type ScreenHash,
  type ScreenRef,
  type SnapshotHashes,
} from '@rangoli/engine';
import type { Designs } from '../agents/designs.js';
import type { Q } from '../db.js';
import type { BlobStore } from '../infra.js';
import type { User } from '../http/context.js';
import { notFound } from '../http/errors.js';
import { actor, projectBlobPrefix } from '../store.js';
import type { Journey } from '../projects/journey.js';
import type { SignedClaim, Signer } from './signing.js';

/** The engine release that produced a snapshot's hashes, recorded beside the canonical-form version. */
export const ENGINE_VERSION: string = (() => {
  try {
    // src/app/snapshots and dist/app/snapshots both sit four levels below packages/
    const pkg = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../../../engine/package.json');
    return `@rangoli/engine@${(JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version}`;
  } catch {
    return '@rangoli/engine@unknown';
  }
})();

export type SnapshotKind = 'review' | 'baseline' | 'release' | 'manual';

export interface SnapshotRow {
  id: string;
  project_id: string;
  org_id: string;
  cycle: number;
  stage: string;
  kind: SnapshotKind;
  name: string;
  seq: number;
  content_hash: string;
  library_hash: string;
  canon_version: string;
  engine_version: string;
  signature: string;
  signing_key: string;
  created_by: string | null;
  created_by_name: string;
  created_at: string;
}

export interface FrozenSnapshot extends SnapshotRow {
  data: DocumentData;
  items: LifecycleItem[];
  annotations: { n: number; node: string; body: string; author: string }[];
  frames: ScreenFrameLink[];
}

export interface ScreenRow {
  screen_key: string;
  screen_id: string | null;
  name: string;
  page_id: string;
  device: string | null;
  screen_hash: string;
  root_hash: string;
}

export interface AssetRow {
  file: string;
  sha256: string;
  mime: string;
  size: number | null;
}

/** One screen as hashed: the frame, the lifecycle screen it belongs to, and what it is called. */
export interface ScreenState {
  key: string;
  screenId: string | null;
  name: string;
  page: string;
  device: string | null;
  hash: string;
  rootHash: string;
  deps: ScreenHash['deps'];
}

export interface Hashed {
  hashes: SnapshotHashes;
  screens: ScreenState[];
  assets: (AssetRow & { id: string })[];
  warnings: string[];
}

export interface Captured extends Hashed {
  data: DocumentData;
  items: LifecycleItem[];
  annotations: FrozenSnapshot['annotations'];
  frames: ScreenFrameLink[];
  seq: number;
}

export const SNAPSHOT_COLUMNS = `id, project_id, org_id, cycle, stage, kind, name, seq::float8 AS seq, content_hash, library_hash, canon_version, engine_version, signature, signing_key, created_by, created_by_name, created_at`;

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** Every top-level frame is a screen, keyed by its node id, with the lifecycle screen and device it is linked to. */
export function screenRefs(data: DocumentData, frames: readonly ScreenFrameLink[]): (ScreenRef & { screenId: string | null; name: string })[] {
  const byFrame = new Map(frames.map((f) => [f.frame, f]));
  return listScreens(data).map((s) => {
    const link = byFrame.get(s.root);
    const node = data.pages[s.page]?.nodes[s.root];
    return { id: s.root, page: s.page, root: s.root, device: link?.device, screenId: link?.screen ?? null, name: (node?.name ?? s.root).slice(0, 200) };
  });
}

/** The asset metadata each screen's dependencies name, by asset id. */
export function usedAssets(data: DocumentData, refs: readonly ScreenRef[]): AssetMeta[] {
  const scan = screenDepsScanner(data);
  const ids = new Set<string>();
  for (const r of refs) for (const id of scan(r).assets) ids.add(id);
  return [...ids].map((id) => data.assets?.[id]).filter((m): m is AssetMeta => !!m);
}

/** Hashes a design as it stands, given the full SHA-256 of each image it uses. */
export function hashDesign(data: DocumentData, frames: readonly ScreenFrameLink[], assets: readonly (AssetRow & { id: string })[]): Omit<Hashed, 'warnings'> {
  const refs = screenRefs(data, frames);
  const assetHashes = Object.fromEntries(assets.map((a) => [a.id, a.sha256]));
  const hashes = hashSnapshot(data, { assetHashes, screens: refs });
  const meta = new Map(refs.map((r) => [r.id, r]));
  const screens = hashes.screens.map((s): ScreenState => ({
    key: s.id,
    screenId: meta.get(s.id)?.screenId ?? null,
    name: meta.get(s.id)?.name ?? s.id,
    page: s.page,
    device: s.device ?? null,
    hash: s.hash,
    rootHash: s.rootHash,
    deps: s.deps,
  }));
  return { hashes, screens, assets: [...assets] };
}

export const claimOf = (row: Pick<SnapshotRow, 'id' | 'project_id' | 'content_hash' | 'library_hash' | 'canon_version' | 'engine_version' | 'created_by'>, screens: { key: string; hash: string }[], assets: { file: string; sha256: string }[]): SignedClaim => ({
  snapshot: row.id,
  project: row.project_id,
  contentHash: row.content_hash,
  libraryHash: row.library_hash,
  canonVersion: row.canon_version,
  engineVersion: row.engine_version,
  screens: screens.map((s) => [s.key, s.hash]),
  assets: assets.map((a) => [a.file, a.sha256]),
  createdBy: row.created_by ?? '',
});

export function createSnapshots(designs: Designs, signer: Signer, blobs?: BlobStore) {
  /** project/file -> SHA-256. A file name is content-addressed and never rewritten, so this never goes stale. */
  const shaCache = new Map<string, string>();

  /** The full SHA-256 of each image the screens use, read as the person asking. Missing bytes become warnings. */
  const assetHashes = async (projectId: string, userId: string, metas: AssetMeta[], read: (m: AssetMeta) => Promise<Buffer>) => {
    const out: (AssetRow & { id: string })[] = [];
    const warnings: string[] = [];
    for (const m of metas) {
      const key = `${projectId}/${m.file}`;
      let sha = shaCache.get(key);
      if (!sha) {
        try {
          sha = sha256(await actor.run(userId, () => read(m)));
          shaCache.set(key, sha);
        } catch {
          warnings.push(`The image "${m.name}" is missing its file, so the snapshot cannot protect it.`);
          continue;
        }
      }
      out.push({ id: m.id, file: m.file, sha256: sha, mime: m.mime, size: m.bytes ?? null });
    }
    return { assets: out, warnings };
  };

  /** Copies the open design, its items, annotations and frame links, and hashes it. Nothing is written. */
  const capture = async (userId: string, j: Journey): Promise<Captured> => {
    const { session } = await designs.open(j.project.id, j.project.org_id, userId);
    const data = cloneDocument(session.doc).data;
    const frames = j.screenFrames.map((f) => ({ ...f }));
    const refs = screenRefs(data, frames);
    const { assets, warnings } = await assetHashes(j.project.id, userId, usedAssets(data, refs), (m) => session.readAsset(m));
    const hashed = hashDesign(data, frames, assets);
    const annotations = annotationsOf(session.reviews).map(({ n, node, body, author }) => ({ n, node, body, author }));
    return { ...hashed, warnings, data, items: j.items.map((i) => ({ ...i })), annotations, frames, seq: session.doc.headSeq };
  };

  /** The open design's hashes now, for "Changed since approved". Reuses the cached image hashes. */
  const current = async (userId: string, j: Journey): Promise<Hashed> => {
    const { session } = await designs.open(j.project.id, j.project.org_id, userId);
    const data = session.doc.data;
    const refs = screenRefs(data, j.screenFrames);
    const { assets, warnings } = await assetHashes(j.project.id, userId, usedAssets(data, refs), (m) => session.readAsset(m));
    return { ...hashDesign(data, j.screenFrames, assets), warnings };
  };

  /**
   * Writes a captured snapshot in the caller's transaction (running as `user`): the row, its screens and the
   * assets it uses, signed. Returns the row.
   */
  const insert = async (q: Q, user: User, j: Journey, cap: Captured, opts: { kind: SnapshotKind; name: string }): Promise<SnapshotRow> => {
    const id = randomUUID();
    const base = { id, project_id: j.project.id, content_hash: cap.hashes.contentHash, library_hash: cap.hashes.libraryHash, canon_version: cap.hashes.canonVersion, engine_version: ENGINE_VERSION, created_by: user.id };
    const { signature, keyId } = signer.sign(claimOf(base, cap.screens, cap.assets));
    const [row] = await q<SnapshotRow>(
      `INSERT INTO snapshots (id, project_id, org_id, cycle, stage, kind, name, seq, data, items, annotations, frames, content_hash, library_hash, canon_version, engine_version, signature, signing_key, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::json, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, $15, $16, $17, $18, app_uid())
       RETURNING ${SNAPSHOT_COLUMNS}`,
      [id, j.project.id, j.project.org_id, j.project.cycle, j.project.stage, opts.kind, opts.name.slice(0, 120), cap.seq, JSON.stringify(cap.data), JSON.stringify(cap.items), JSON.stringify(cap.annotations), JSON.stringify(cap.frames), base.content_hash, base.library_hash, base.canon_version, base.engine_version, signature, keyId],
    );
    for (const s of cap.screens) {
      await q(
        `INSERT INTO snapshot_screens (snapshot_id, project_id, org_id, screen_key, screen_id, name, page_id, device, screen_hash, root_hash, deps) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::json)`,
        [id, j.project.id, j.project.org_id, s.key, s.screenId, s.name, s.page, s.device, s.hash, s.rootHash, JSON.stringify(s.deps)],
      );
    }
    // only images whose row exists can be protected; the hash still covers the rest
    const stored = new Set((await q<{ file: string }>(`SELECT file FROM design_assets WHERE project_id = $1 AND file = ANY ($2::text[])`, [j.project.id, cap.assets.map((a) => a.file)])).map((r) => r.file));
    for (const a of cap.assets) {
      if (!stored.has(a.file)) continue;
      await q(`INSERT INTO snapshot_assets (snapshot_id, project_id, org_id, file, sha256, mime, size) VALUES ($1, $2, $3, $4, $5, $6, $7)`, [id, j.project.id, j.project.org_id, a.file, a.sha256, a.mime, a.size]);
    }
    return row!;
  };

  const load = async (q: Q, projectId: string, snapshotId: string): Promise<FrozenSnapshot> => {
    const [row] = await q<FrozenSnapshot>(`SELECT ${SNAPSHOT_COLUMNS}, data, items, annotations, frames FROM snapshots WHERE id = $1 AND project_id = $2`, [snapshotId, projectId]);
    if (!row) throw notFound();
    return row;
  };

  const screensOf = (q: Q, snapshotId: string) => q<ScreenRow>(`SELECT screen_key, screen_id, name, page_id, device, screen_hash, root_hash FROM snapshot_screens WHERE snapshot_id = $1 ORDER BY page_id, screen_key`, [snapshotId]);
  const assetsOf = (q: Q, snapshotId: string) => q<AssetRow>(`SELECT file, sha256, mime, size FROM snapshot_assets WHERE snapshot_id = $1 ORDER BY file`, [snapshotId]);

  /** The most recently taken snapshot with an approved review, if any. */
  const latestApproved = async (q: Q, projectId: string): Promise<(SnapshotRow & { approval_id: string }) | null> => {
    const [row] = await q<SnapshotRow & { approval_id: string }>(
      `SELECT ${SNAPSHOT_COLUMNS.split(', ').map((c) => `s.${c}`).join(', ')}, a.id AS approval_id
       FROM snapshots s JOIN approvals a ON a.snapshot_id = s.id
       WHERE s.project_id = $1 AND approval_status(a.id) = 'approved'
       ORDER BY s.created_at DESC, a.created_at DESC LIMIT 1`,
      [projectId],
    );
    return row ?? null;
  };

  /**
   * Recomputes a stored snapshot's hashes from what it froze, and checks its signature. intact: the design and
   * images still hash to what was recorded; signed: the record is what this deployment signed.
   */
  const verify = async (q: Q, snap: FrozenSnapshot) => {
    const [screens, assets] = await Promise.all([screensOf(q, snap.id), assetsOf(q, snap.id)]);
    const ids = new Map(Object.values(snap.data.assets ?? {}).map((m) => [m.file, m.id]));
    const recomputed = hashDesign(snap.data, snap.frames, assets.map((a) => ({ ...a, id: ids.get(a.file) ?? a.file })));
    const mismatched = screens.filter((s) => recomputed.screens.find((r) => r.key === s.screen_key)?.hash !== s.screen_hash).map((s) => s.screen_key);
    const intact = recomputed.hashes.contentHash === snap.content_hash && recomputed.hashes.libraryHash === snap.library_hash && mismatched.length === 0 && recomputed.screens.length === screens.length;
    const signed = signer.verify(claimOf(snap, screens.map((s) => ({ key: s.screen_key, hash: s.screen_hash })), assets), snap.signature, snap.signing_key);
    return { intact, signed, keyId: snap.signing_key, mismatched, contentHash: snap.content_hash, recomputed: recomputed.hashes.contentHash };
  };

  /** The bytes of a snapshot's images, read as the person asking (RLS decides), as data URIs by file name. */
  const assetUris = async (q: Q, orgId: string, projectId: string, snapshotId: string): Promise<Map<string, string>> => {
    const rows = await q<{ file: string; mime: string; storage: string; bytes: Uint8Array | null }>(
      `SELECT a.file, a.mime, d.storage, d.bytes FROM snapshot_assets a JOIN design_assets d ON d.project_id = a.project_id AND d.file = a.file WHERE a.snapshot_id = $1`,
      [snapshotId],
    );
    return dataUris(rows, orgId, projectId);
  };

  const dataUris = async (rows: { file: string; mime: string; storage: string; bytes: Uint8Array | null }[], orgId: string, projectId: string) => {
    const out = new Map<string, string>();
    for (const r of rows) {
      const buf = r.storage === 's3' ? await blobs?.get(projectBlobPrefix(orgId, projectId) + r.file).catch(() => null) : r.bytes ? Buffer.from(r.bytes) : null;
      if (buf) out.set(r.file, `data:${r.mime};base64,${buf.toString('base64')}`);
    }
    return out;
  };

  return { capture, current, insert, load, screensOf, assetsOf, latestApproved, verify, assetUris, dataUris };
}

export type Snapshots = ReturnType<typeof createSnapshots>;

/** Screen by screen: what changed since a snapshot (normally the latest approved one). */
export function compareScreens(now: ScreenState[], then: ScreenRow[] | null) {
  const before = new Map((then ?? []).map((s) => [s.screen_key, s]));
  const screens = now.map((s) => {
    const was = before.get(s.key);
    return { key: s.key, screenId: s.screenId, name: s.name, device: s.device, hash: s.hash, approvedHash: was?.screen_hash ?? null, changed: !!then && was?.screen_hash !== s.hash, added: !!then && !was };
  });
  const keys = new Set(now.map((s) => s.key));
  const removed = (then ?? []).filter((s) => !keys.has(s.screen_key)).map((s) => ({ key: s.screen_key, screenId: s.screen_id, name: s.name, approvedHash: s.screen_hash }));
  return { screens, removed };
}
