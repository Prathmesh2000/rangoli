/**
 * Snapshots, approval status, "Changed since approved", static renders, the HTML export and share links.
 *
 * Everything that hands a design to someone outside the canvas reads a named snapshot, by default the latest
 * approved one. Output from the working copy says Unapproved, in the file and in a header.
 */
import { randomBytes } from 'node:crypto';
import type { AssetMeta } from '@rangoli/engine';
import { z } from 'zod';
import { tokenHash } from '../auth.js';
import { audit } from '../access/audit.js';
import { requireCapability } from '../access/roles.js';
import type { Designs } from '../agents/designs.js';
import type { Q } from '../db.js';
import type { AppCore, Ctx } from '../http/context.js';
import { HttpError, notFound } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import type { Journey, Lifecycle } from '../projects/journey.js';
import { listApprovals } from '../reviews/approvals.js';
import { actor } from '../store.js';
import { renderStatic, sendStaticPage } from './render.js';
import { compareScreens, SNAPSHOT_COLUMNS, usedAssets, screenRefs, type Snapshots, type SnapshotRow } from './snapshots.js';

const SHARE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const newShareToken = () => randomBytes(32).toString('base64url');
export const isShareToken = (t: string) => SHARE_TOKEN.test(t);

/** `snapshot` query value: a snapshot id, "working" for the working copy, or nothing for the latest approved. */
const snapshotParam = (url: URL): string | 'working' | null => {
  const v = url.searchParams.get('snapshot');
  if (!v) return null;
  if (v === 'working') return 'working';
  if (!z.string().uuid().safeParse(v).success) throw new HttpError(400, 'That snapshot id is not valid.');
  return v;
};

export function registerSnapshotRoutes(router: Router, core: AppCore, designs: Designs, lifecycle: Lifecycle, snapshots: Snapshots): void {
  const { journey } = lifecycle;
  const on = router.on.bind(router);

  /** The working copy's images as data URIs, read as the person asking. */
  const workingAssets = async (c: Ctx, j: Journey): Promise<Map<string, string>> => {
    const { session } = await designs.open(j.project.id, j.project.org_id, c.user.id);
    const out = new Map<string, string>();
    for (const m of usedAssets(session.doc.data, screenRefs(session.doc.data, j.screenFrames)) as AssetMeta[]) {
      const buf = await actor.run(c.user.id, () => session.readAsset(m)).catch(() => null);
      if (buf) out.set(m.file, `data:${m.mime};base64,${buf.toString('base64')}`);
    }
    return out;
  };

  /** Who approved a snapshot, from its approvals' latest decisions. */
  const approvedBy = (q: Q, snapshotId: string) =>
    q<{ name: string; at: string }>(
      `SELECT d.approver_name AS name, d.created_at AS at FROM approval_decisions d JOIN approvals a ON a.id = d.approval_id
       WHERE a.snapshot_id = $1 AND d.decision = 'approved' AND approval_status(a.id) = 'approved' ORDER BY d.created_at`,
      [snapshotId],
    );

  /** Everything the review and release page shows, in one read. */
  on('GET', `/api/projects/${U}/review`, async (c) => {
    const j = await journey(c.user.id, c.p[0]!);
    const data = await c.as(async (q) => {
      const [{ solo } = { solo: false }] = await q<{ solo: boolean }>(`SELECT org_is_solo($1) AS solo`, [j.project.org_id]);
      const latest = await snapshots.latestApproved(q, c.p[0]!);
      return {
        solo,
        latest,
        latestScreens: latest ? await snapshots.screensOf(q, latest.id) : null,
        latestBy: latest ? await approvedBy(q, latest.id) : [],
        approvals: await listApprovals(q, c.p[0]!),
        snapshots: await q<SnapshotRow & { status: string | null }>(
          `SELECT ${SNAPSHOT_COLUMNS}, (SELECT approval_status(a.id) FROM approvals a WHERE a.snapshot_id = snapshots.id ORDER BY a.created_at DESC LIMIT 1) AS status FROM snapshots WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [c.p[0]],
        ),
        shareLinks: await q(`SELECT id, snapshot_id, kind, label, created_by, expires_at, revoked_at, created_at, (revoked_at IS NULL AND expires_at > now()) AS live FROM share_links WHERE project_id = $1 ORDER BY created_at DESC LIMIT 50`, [c.p[0]]),
        releases: await q(
          `SELECT r.id, r.snapshot_id, s.name AS snapshot_name, s.content_hash, r.basis, r.approval_id, r.override_id, r.fix_id, r.checklist, r.notes, coalesce(r.released_by::text, 'former:' || r.id) AS released_by, r.released_by_name, r.cycle, r.created_at
           FROM releases r JOIN snapshots s ON s.id = r.snapshot_id WHERE r.project_id = $1 ORDER BY r.created_at DESC LIMIT 50`,
          [c.p[0]],
        ),
        fixes: await q(
          `SELECT f.id, f.release_id, f.snapshot_id, f.frame_node, f.screen_id, f.before_hash, f.note, f.workstream_id, f.created_by_name, f.created_at,
                  EXISTS (SELECT 1 FROM releases r WHERE r.fix_id = f.id) AS released
           FROM fixes f WHERE f.project_id = $1 ORDER BY f.created_at DESC LIMIT 50`,
          [c.p[0]],
        ),
        approvers: await q<{ id: string; name: string }>(`SELECT u.id, u.name FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 AND pm.is_approver ORDER BY u.name`, [c.p[0]]),
      };
    });
    const now = await snapshots.current(c.user.id, j);
    const changes = compareScreens(now.screens, data.latestScreens);
    const stage = j.stages.find((s) => s.current)!;
    c.json(200, {
      me: c.user.id,
      can: j.can,
      solo: data.solo,
      strict: j.strict,
      project: { id: j.project.id, name: j.project.name, stage: j.project.stage, cycle: j.project.cycle },
      stage: { id: stage.id, name: stage.name, checks: stage.checks, signoff: stage.signoff },
      handoffChecks: j.stages.find((s) => s.id === 'handoff')?.checks ?? [],
      latestApproved: data.latest ? { ...data.latest, approvedBy: data.latestBy } : null,
      changes,
      current: { contentHash: now.hashes.contentHash, warnings: now.warnings },
      approvals: data.approvals,
      snapshots: data.snapshots,
      shareLinks: data.shareLinks,
      releases: data.releases,
      fixes: data.fixes,
      approvers: data.approvers.filter((a) => a.id !== c.user.id),
      overrides: j.overrides.filter((o) => o.action === 'release'),
    });
  });

  /** A named snapshot taken by hand, for a baseline or before a big change. */
  on('POST', `/api/projects/${U}/snapshots`, async (c) => {
    const b = await c.body(z.object({ name: z.string().trim().min(1, 'Name the snapshot').max(120), kind: z.enum(['manual', 'baseline']).default('manual') }));
    const j = await journey(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can view snapshots, but not take them.');
    const captured = await snapshots.capture(c.user.id, j);
    const row = await c.as(async (q) => {
      const row = await snapshots.insert(q, c.user, j, captured, { kind: b.kind, name: b.name });
      await audit(q, c.user, j.project.org_id, c.p[0]!, 'snapshot.create', { snapshot: row.id, name: b.name, contentHash: row.content_hash });
      return row;
    });
    c.json(200, { ...row, warnings: captured.warnings });
  });

  on('GET', `/api/projects/${U}/snapshots/${U}`, async (c) => {
    const out = await c.as(async (q) => {
      const [row] = await q<SnapshotRow>(`SELECT ${SNAPSHOT_COLUMNS} FROM snapshots WHERE id = $1 AND project_id = $2`, [c.p[1], c.p[0]]);
      if (!row) throw notFound();
      return { ...row, screens: await snapshots.screensOf(q, row.id), assets: await snapshots.assetsOf(q, row.id), approvedBy: await approvedBy(q, row.id) };
    });
    c.json(200, out);
  });

  /** Recomputes the hashes from what the snapshot froze, and checks the signature. */
  on('GET', `/api/projects/${U}/snapshots/${U}/verify`, async (c) => {
    const out = await c.as(async (q) => snapshots.verify(q, await snapshots.load(q, c.p[0]!, c.p[1]!)));
    c.json(200, out);
  });

  /** A snapshot (or one frame of it) as a static page: for before and after, and for looking at an old version. */
  on('GET', `/api/projects/${U}/snapshots/${U}/render`, async (c) => {
    const frame = c.url.searchParams.get('frame') ?? undefined;
    const { snap, assets, name } = await c.as(async (q) => {
      const snap = await snapshots.load(q, c.p[0]!, c.p[1]!);
      const [p] = await q<{ name: string }>(`SELECT name FROM projects WHERE id = $1`, [c.p[0]]);
      return { snap, assets: await snapshots.assetUris(q, snap.org_id, c.p[0]!, snap.id), name: p?.name ?? '' };
    });
    sendStaticPage(c.res, renderStatic(snap.data, { title: `${name} · ${snap.name}`, frames: frame ? [frame] : undefined, assets, heading: { project: name, label: snap.name, hash: snap.content_hash } }), { embeddable: true });
  });

  /** The working copy (or one frame of it) as a static page, marked Unapproved. */
  on('GET', `/api/projects/${U}/render`, async (c) => {
    const frame = c.url.searchParams.get('frame') ?? undefined;
    const j = await journey(c.user.id, c.p[0]!);
    const { session } = await designs.open(j.project.id, j.project.org_id, c.user.id);
    const assets = await workingAssets(c, j);
    sendStaticPage(c.res, renderStatic(session.doc.data, { title: `${j.project.name} · working copy`, frames: frame ? [frame] : undefined, assets, heading: { project: j.project.name, label: 'Working copy', unapproved: true } }), { embeddable: true, approval: 'Unapproved' });
  });

  /** The design as one HTML file: the latest approved snapshot, a named one, or the working copy marked Unapproved. */
  on('GET', `/api/projects/${U}/export\\.html`, async (c) => {
    const j = await journey(c.user.id, c.p[0]!);
    requireCapability(j.can, 'export.run', 'Your role in this project cannot export.');
    const which = snapshotParam(c.url);
    const picked = which === 'working' ? null : await c.as(async (q) => {
      const id = which ?? (await snapshots.latestApproved(q, c.p[0]!))?.id;
      if (!id) return null;
      const snap = await snapshots.load(q, c.p[0]!, id);
      const status = (await q<{ s: string | null }>(`SELECT (SELECT approval_status(a.id) FROM approvals a WHERE a.snapshot_id = $1 AND approval_status(a.id) = 'approved' LIMIT 1) AS s`, [id]))[0]?.s;
      return { snap, approved: status === 'approved', assets: await snapshots.assetUris(q, snap.org_id, c.p[0]!, snap.id) };
    });
    if (picked) {
      const { snap, approved, assets } = picked;
      const html = renderStatic(snap.data, { title: `${j.project.name} · ${snap.name}`, assets, heading: { project: j.project.name, label: snap.name, hash: snap.content_hash, lines: [approved ? 'Approved version' : 'Named snapshot, not approved'] } });
      await c.as((q) => audit(q, c.user, j.project.org_id, j.project.id, 'export.html', { snapshot: snap.id, approved }));
      return sendStaticPage(c.res, html, { filename: `${j.project.name}-${snap.name}.html`, approval: approved ? 'Approved' : 'Snapshot' });
    }
    const { session } = await designs.open(j.project.id, j.project.org_id, c.user.id);
    const html = renderStatic(session.doc.data, { title: `${j.project.name} · working copy (unapproved)`, assets: await workingAssets(c, j), heading: { project: j.project.name, label: 'Working copy', unapproved: true } });
    await c.as((q) => audit(q, c.user, j.project.org_id, j.project.id, 'export.html', { snapshot: null, approved: false }));
    sendStaticPage(c.res, html, { filename: `${j.project.name}-unapproved.html`, approval: 'Unapproved' });
  });

  // ---- share links: snapshot-only, hashed, expiring, revocable

  on('POST', `/api/projects/${U}/share-links`, async (c) => {
    const b = await c.body(z.object({
      snapshot: z.string().uuid(),
      kind: z.enum(['stakeholder', 'developer']).default('stakeholder'),
      days: z.number().int().min(1).max(365).default(30),
      label: z.string().trim().max(120).default(''),
    }));
    const j = await journey(c.user.id, c.p[0]!);
    requireCapability(j.can, b.kind === 'developer' ? 'export.run' : 'design.edit', b.kind === 'developer' ? 'Your role cannot hand designs to developers.' : 'Your role cannot share this project.');
    const token = newShareToken();
    const row = await c.as(async (q) => {
      const [snap] = await q<{ id: string }>(`SELECT id FROM snapshots WHERE id = $1 AND project_id = $2`, [b.snapshot, c.p[0]]);
      if (!snap) throw notFound();
      const [row] = await q<{ id: string; expires_at: string }>(
        `INSERT INTO share_links (project_id, org_id, snapshot_id, kind, token_hash, label, created_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, app_uid(), clock_timestamp() + make_interval(days => $7)) RETURNING id, expires_at`,
        [c.p[0], j.project.org_id, b.snapshot, b.kind, tokenHash(token), b.label, b.days],
      );
      await audit(q, c.user, j.project.org_id, c.p[0]!, 'share_link.create', { link: row!.id, snapshot: b.snapshot, kind: b.kind, days: b.days });
      return row!;
    });
    // the token is shown once: only its hash is stored
    c.json(200, { id: row.id, expires_at: row.expires_at, url: `${core.originOf(c.req)}/s/${token}` });
  });

  on('DELETE', `/api/projects/${U}/share-links/${U}`, async (c) => {
    const j = await journey(c.user.id, c.p[0]!);
    await c.as(async (q) => {
      const rows = await q(`UPDATE share_links SET revoked_at = clock_timestamp(), revoked_by = app_uid() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL RETURNING id`, [c.p[1], c.p[0]]);
      if (!rows.length) throw new HttpError(404, 'That link is already revoked, or you cannot revoke it.');
      await audit(q, c.user, j.project.org_id, c.p[0]!, 'share_link.revoke', { link: c.p[1] });
    });
    c.json(200, { ok: true });
  });
}
