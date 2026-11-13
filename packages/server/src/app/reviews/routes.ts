/**
 * Stage reviews: asking for one (which takes a snapshot and binds an approval to it), withdrawing it, and deciding.
 * Editing continues while a review is open; the decision is on the snapshot, not on whatever the canvas holds now.
 */
import { z } from 'zod';
import { logger } from '../../telemetry/log.js';
import { audit } from '../access/audit.js';
import { requireCapability } from '../access/roles.js';
import type { Designs } from '../agents/designs.js';
import type { AppCore, Ctx } from '../http/context.js';
import { HttpError, notFound } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import type { Lifecycle } from '../projects/journey.js';
import type { Snapshots } from '../snapshots/snapshots.js';
import { currentApproval, decide, decisionBody, getApproval } from './approvals.js';

export function registerReviewRoutes(router: Router, core: AppCore, designs: Designs, lifecycle: Lifecycle, snapshots: Snapshots): void {
  const { notify, originOf } = core;
  const { loadForMove } = lifecycle;
  const on = router.on.bind(router);

  const stageLink = (c: Ctx, stage: string) => `${originOf(c.req)}/p/${c.p[0]!}/${stage}`;
  /** After commit: telling open pages to refresh never decides whether the request worked. */
  const broadcast = async (c: Ctx, orgId: string) => {
    try {
      (await designs.open(c.p[0]!, orgId, c.user.id)).routes.broadcast('journey', Date.now());
    } catch (err) {
      logger.error('could not announce a review change', { err });
    }
  };

  on('POST', `/api/projects/${U}/review/request`, async (c) => {
    const b = await c.body(z.object({
      note: z.string().trim().max(2000).default(''),
      /** named approvers; none means any approver on the project */
      approvers: z.array(z.string().uuid()).max(20).default([]),
      /** with named approvers: one of them (any) or every one (all) */
      rule: z.enum(['any', 'all']).default('any'),
    }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    if (!j.stage.signoff.required) throw new HttpError(400, `${j.stage.name} does not need a review for ${j.workType.name} work.`);
    if (['in_review', 'approved'].includes(j.stage.signoff.status)) throw new HttpError(409, 'A review is already open on this stage.');
    const approvers = [...new Set(b.approvers)];
    if (b.rule === 'all' && !approvers.length) throw new HttpError(400, 'Name the approvers who all need to approve.');
    if (approvers.includes(c.user.id)) throw new HttpError(400, 'You cannot approve your own review. Name someone else.');
    if (approvers.length) {
      const found = await c.as((q) => q<{ user_id: string }>(`SELECT user_id FROM project_members WHERE project_id = $1 AND is_approver AND user_id = ANY ($2::uuid[])`, [c.p[0], approvers]));
      if (found.length !== approvers.length) throw new HttpError(400, 'Everyone you name has to be an approver on this project.');
    }
    // open checks never stop a review being asked for: the reviewer sees them as warnings
    const warnings = j.stage.checks.filter((x) => !x.ok).map((x) => x.label);
    const captured = await snapshots.capture(c.user.id, j);
    const { snapshot, approvalId } = await c.as(async (q) => {
      const snapshot = await snapshots.insert(q, c.user, j, captured, { kind: 'review', name: `${j.stage.name} review · cycle ${j.project.cycle}` });
      await q(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor, note) VALUES ($1, $2, $3, 'review_requested', $4, $4, $5, $6)`, [c.p[0], j.project.org_id, j.project.cycle, j.project.stage, c.user.id, b.note]);
      const [a] = await q<{ id: string }>(
        `INSERT INTO approvals (project_id, org_id, snapshot_id, cycle, stage, rule, approvers, note, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8, app_uid()) RETURNING id`,
        [c.p[0], j.project.org_id, snapshot.id, j.project.cycle, j.project.stage, b.rule, approvers, b.note],
      );
      await audit(q, c.user, j.project.org_id, c.p[0]!, 'review.review_requested', { stage: j.project.stage, note: b.note, snapshot: snapshot.id, contentHash: snapshot.content_hash, approvers, rule: b.rule });
      return { snapshot, approvalId: a!.id };
    });
    const people = await c.as((q) => q<{ email: string }>(
      `SELECT u.email FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 AND u.id <> app_uid() AND (cardinality($2::uuid[]) = 0 OR u.id = ANY ($2::uuid[]))`,
      [c.p[0], approvers],
    ));
    const open = warnings.length ? `\n\nStill open: ${warnings.join('; ')}.` : '';
    notify(people.map((p) => p.email), `Review requested: ${j.project.name} · ${j.stage.name}`, `${c.user.name} asked for a review of ${j.stage.name} on ${j.project.name}.${b.note ? `\n\n"${b.note}"` : ''}${open}\n\nThe decision is on the version saved now (${snapshot.content_hash.slice(0, 12)}); editing can continue.\n\nReview it: ${stageLink(c, j.project.stage)}`);
    await broadcast(c, j.project.org_id);
    c.json(200, { ok: true, warnings, snapshot: { id: snapshot.id, name: snapshot.name, contentHash: snapshot.content_hash }, approval: { id: approvalId }, snapshotWarnings: captured.warnings });
  });

  on('POST', `/api/projects/${U}/review/withdraw`, async (c) => {
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    if (!j.stage.signoff.requestedBy) throw new HttpError(409, 'There is no open review to withdraw.');
    await c.as(async (q) => {
      await q(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor, note) VALUES ($1, $2, $3, 'review_withdrawn', $4, $4, $5, '')`, [c.p[0], j.project.org_id, j.project.cycle, j.project.stage, c.user.id]);
      // an approved snapshot stays approved: that decision was made, and releases may rely on it
      await q(
        `UPDATE approvals SET withdrawn_at = clock_timestamp(), withdrawn_by = app_uid() WHERE project_id = $1 AND cycle = $2 AND stage = $3 AND withdrawn_at IS NULL AND approval_status(id) <> 'approved'`,
        [c.p[0], j.project.cycle, j.project.stage],
      );
      await audit(q, c.user, j.project.org_id, c.p[0]!, 'review.review_withdrawn', { stage: j.project.stage });
    });
    await broadcast(c, j.project.org_id);
    c.json(200, { ok: true });
  });

  const respond = async (c: Ctx, j: Awaited<ReturnType<typeof loadForMove>>, r: Awaited<ReturnType<typeof decide>>, decision: string, note: string) => {
    const [requester] = await c.as((q) => q<{ email: string }>(`SELECT email FROM users WHERE id = $1 AND id <> app_uid()`, [r.requestedBy]));
    if (requester) notify([requester.email], `${decision === 'approved' ? 'Approved' : 'Changes requested'}: ${j.project.name} · ${j.stage.name}`, `${c.user.name} ${decision === 'approved' ? 'approved' : 'requested changes on'} ${j.stage.name}.${note ? `\n\n"${note}"` : ''}\n\nOpen it: ${stageLink(c, j.project.stage)}`);
    await broadcast(c, j.project.org_id);
    c.json(200, { ok: true, exceptions: r.exceptions, status: r.status, decision: r.decision, mfaAt: r.mfaAt, legacy: r.legacy });
  };

  /** The decision on whatever review is open on the current stage. */
  on('POST', `/api/projects/${U}/signoff`, async (c) => {
    const b = await c.body(decisionBody);
    const j = await loadForMove(c.user.id, c.p[0]!);
    const approval = await c.as((q) => currentApproval(q, j));
    const r = await decide(core, lifecycle, c, j, approval, b);
    await respond(c, j, r, b.decision, b.note);
  });

  /** The decision on one approval, by id: from the review page, or after following a stakeholder link and signing in. */
  on('POST', `/api/projects/${U}/approvals/${U}/decisions`, async (c) => {
    const b = await c.body(decisionBody.extend({ via: z.enum(['app', 'link']).default('app') }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    const approval = await c.as((q) => getApproval(q, c.p[0]!, c.p[1]!));
    if (!approval) throw notFound();
    if (approval.cycle !== j.project.cycle || approval.stage !== j.project.stage) throw new HttpError(409, 'This review is for a stage the project has left. Ask for a new review.');
    const open = await c.as((q) => currentApproval(q, j));
    if (open?.id !== approval.id) throw new HttpError(409, 'A newer review replaced this one. Decide that one instead.');
    const r = await decide(core, lifecycle, c, j, approval, b, b.via);
    await respond(c, j, r, b.decision, b.note);
  });
}
