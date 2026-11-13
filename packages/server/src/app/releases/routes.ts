/**
 * Releases and fixes (PRD §8.6 AP6, AP7; journeys 4 and 9).
 *
 * A release records what shipped: a snapshot, a checklist and notes.
 *  - Solo organization: "Released by" a person, never "approved"; the snapshot is the one named, or the working
 *    copy frozen now.
 *  - Team: the latest approved snapshot (or a named approved one). Without one, an accepted exception: a release
 *    override by someone other than the person releasing, with the working copy frozen now. Strict mode refuses
 *    anything else; outside it the release is recorded as unapproved.
 * The database checks the basis again (migration-010 release_guard), so these rules hold whatever calls it.
 *
 * A fix starts from a frame in a released snapshot with a note. It opens a Fix workstream and keeps the frame's
 * released hash as "before"; "after" is the same frame now.
 */
import { z } from 'zod';
import { audit } from '../access/audit.js';
import { requireCapability } from '../access/roles.js';
import type { Q } from '../db.js';
import { HttpError, notFound } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import { overrideFor, type Lifecycle } from '../projects/journey.js';
import type { Snapshots, SnapshotRow } from '../snapshots/snapshots.js';

type Basis = 'approval' | 'exception' | 'solo' | 'unapproved';

const approvedApproval = async (q: Q, snapshotId: string) =>
  (await q<{ id: string }>(`SELECT id FROM approvals WHERE snapshot_id = $1 AND approval_status(id) = 'approved' ORDER BY created_at DESC LIMIT 1`, [snapshotId]))[0]?.id ?? null;

export function registerReleaseRoutes(router: Router, lifecycle: Lifecycle, snapshots: Snapshots): void {
  const { journey } = lifecycle;
  const on = router.on.bind(router);

  on('POST', `/api/projects/${U}/releases`, async (c) => {
    const b = await c.body(z.object({
      /** a named snapshot; by default the latest approved one (team) or the working copy now (solo, exception) */
      snapshot: z.string().uuid().optional(),
      notes: z.string().trim().max(4000).default(''),
      /** extra checklist lines beyond the Handoff checks */
      checklist: z.array(z.object({ label: z.string().trim().min(1).max(200), done: z.boolean() })).max(50).default([]),
      fix: z.string().uuid().optional(),
    }));
    const j = await journey(c.user.id, c.p[0]!);
    requireCapability(j.can, 'release', 'Your role in this project cannot release.');
    const handoff = j.stages.find((s) => s.id === 'handoff')!;
    const checklist = [...handoff.checks.map((x) => ({ check: x.id, label: x.label, done: x.ok })), ...b.checklist.map((x) => ({ check: null, label: x.label, done: x.done }))];
    const warnings: string[] = [];

    const plan = await c.as(async (q) => {
      const [{ solo } = { solo: false }] = await q<{ solo: boolean }>(`SELECT org_is_solo($1) AS solo`, [j.project.org_id]);
      if (b.fix) {
        const [fix] = await q(`SELECT id FROM fixes WHERE id = $1 AND project_id = $2`, [b.fix, c.p[0]]);
        if (!fix) throw new HttpError(404, 'That fix does not exist.');
      }
      if (b.snapshot) {
        const [snap] = await q<SnapshotRow>(`SELECT id FROM snapshots WHERE id = $1 AND project_id = $2`, [b.snapshot, c.p[0]]);
        if (!snap) throw notFound();
        if (solo) return { solo, basis: 'solo' as Basis, snapshot: snap.id, approval: null, override: null };
        const approval = await approvedApproval(q, snap.id);
        if (approval) return { solo, basis: 'approval' as Basis, snapshot: snap.id, approval, override: null };
        throw new HttpError(409, 'That snapshot is not approved. Release the latest approved snapshot, or ask for a review of this one.');
      }
      if (solo) return { solo, basis: 'solo' as Basis, snapshot: null, approval: null, override: null };
      const latest = await snapshots.latestApproved(q, c.p[0]!);
      if (latest) return { solo, basis: 'approval' as Basis, snapshot: latest.id, approval: latest.approval_id, override: null };
      // no approved version: an exception someone else accepted, made this cycle
      const ov = overrideFor(j.overrides, j.project.cycle, 'handoff', 'release', null, c.user.id);
      if (ov) return { solo, basis: 'exception' as Basis, snapshot: null, approval: null, override: ov.id };
      if (j.strict) throw new HttpError(409, 'Strict mode is on: a team release needs an approved snapshot, or an exception accepted by someone other than you.', { strict: true });
      warnings.push('Nothing approved was found, so this release is recorded as unapproved.');
      return { solo, basis: 'unapproved' as Basis, snapshot: null, approval: null, override: null };
    });

    // releasing the working copy freezes it first
    const captured = plan.snapshot ? null : await (async () => {
      const cap = await snapshots.capture(c.user.id, j);
      warnings.push(...cap.warnings);
      return cap;
    })();
    const release = await c.as(async (q) => {
      const snapshot = plan.snapshot ?? (await snapshots.insert(q, c.user, j, captured!, { kind: 'release', name: `Release · cycle ${j.project.cycle}` })).id;
      const [row] = await q<{ id: string; released_by_name: string; created_at: string }>(
        `INSERT INTO releases (project_id, org_id, cycle, snapshot_id, basis, approval_id, override_id, fix_id, checklist, notes, released_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, app_uid()) RETURNING id, released_by_name, created_at`,
        [c.p[0], j.project.org_id, j.project.cycle, snapshot, plan.basis, plan.approval, plan.override, b.fix ?? null, JSON.stringify(checklist), b.notes],
      );
      await audit(q, c.user, j.project.org_id, c.p[0]!, 'release.create', { release: row!.id, snapshot, basis: plan.basis, approval: plan.approval, override: plan.override, fix: b.fix ?? null });
      return { ...row!, snapshot };
    });
    c.json(200, { id: release.id, snapshot: release.snapshot, basis: plan.basis, releasedBy: release.released_by_name, label: plan.basis === 'solo' ? `Released by ${release.released_by_name}` : plan.basis === 'approval' ? 'Approved and released' : plan.basis === 'exception' ? 'Released on an accepted exception' : 'Released without approval', checklist, warnings });
  });

  /** Start a fix from a frame of a released snapshot: a note, a Fix workstream, and the released hash as "before". */
  on('POST', `/api/projects/${U}/releases/${U}/fixes`, async (c) => {
    const b = await c.body(z.object({ frame: z.string().min(1).max(200), note: z.string().trim().min(1, 'Say what the fix changes').max(2000) }));
    const j = await journey(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project cannot start a fix.');
    const out = await c.as(async (q) => {
      const [release] = await q<{ id: string; snapshot_id: string }>(`SELECT id, snapshot_id FROM releases WHERE id = $1 AND project_id = $2`, [c.p[1], c.p[0]]);
      if (!release) throw notFound();
      const [screen] = await q<{ screen_key: string; screen_id: string | null; name: string; screen_hash: string }>(`SELECT screen_key, screen_id, name, screen_hash FROM snapshot_screens WHERE snapshot_id = $1 AND screen_key = $2`, [release.snapshot_id, b.frame]);
      if (!screen) throw new HttpError(400, 'That frame is not in the released version.');
      const [ws] = await q<{ id: string }>(
        `INSERT INTO workstreams (project_id, org_id, name, is_main, cycle, work_type, stage, created_by) VALUES ($1, $2, $3, false, $4, 'fix', 'visual', app_uid()) RETURNING id`,
        [c.p[0], j.project.org_id, `Fix: ${screen.name}`.slice(0, 120), j.project.cycle],
      );
      const [fix] = await q<{ id: string; created_at: string }>(
        `INSERT INTO fixes (project_id, org_id, workstream_id, release_id, snapshot_id, frame_node, screen_id, before_hash, note, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, app_uid()) RETURNING id, created_at`,
        [c.p[0], j.project.org_id, ws!.id, release.id, release.snapshot_id, screen.screen_key, screen.screen_id, screen.screen_hash, b.note],
      );
      await audit(q, c.user, j.project.org_id, c.p[0]!, 'fix.create', { fix: fix!.id, release: release.id, frame: b.frame, note: b.note });
      return { id: fix!.id, workstream: ws!.id, release: release.id, snapshot: release.snapshot_id, frame: screen.screen_key, beforeHash: screen.screen_hash };
    });
    c.json(200, out);
  });

  /** A fix's before and after: the frame as released, and as it is now. */
  on('GET', `/api/projects/${U}/fixes/${U}`, async (c) => {
    const j = await journey(c.user.id, c.p[0]!);
    const fix = await c.as(async (q) => {
      const [f] = await q<{ id: string; release_id: string; snapshot_id: string; frame_node: string; screen_id: string | null; before_hash: string; note: string; created_by_name: string; created_at: string; released: boolean }>(
        `SELECT id, release_id, snapshot_id, frame_node, screen_id, before_hash, note, created_by_name, created_at, EXISTS (SELECT 1 FROM releases r WHERE r.fix_id = fixes.id) AS released FROM fixes WHERE id = $1 AND project_id = $2`,
        [c.p[1], c.p[0]],
      );
      if (!f) throw notFound();
      return f;
    });
    const now = await snapshots.current(c.user.id, j);
    const after = now.screens.find((s) => s.key === fix.frame_node) ?? null;
    c.json(200, {
      ...fix,
      before: { hash: fix.before_hash, url: `/api/projects/${c.p[0]}/snapshots/${fix.snapshot_id}/render?frame=${encodeURIComponent(fix.frame_node)}` },
      after: after ? { hash: after.hash, changed: after.hash !== fix.before_hash, url: `/api/projects/${c.p[0]}/render?frame=${encodeURIComponent(fix.frame_node)}` } : null,
    });
  });
}
