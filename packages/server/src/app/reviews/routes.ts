/** Stage reviews: asking for one, withdrawing it, and the sign-off decision. */
import { z } from 'zod';
import { logger } from '../../telemetry/log.js';
import { audit } from '../access/audit.js';
import { requireCapability } from '../access/roles.js';
import type { Designs } from '../agents/designs.js';
import type { AppCore, Ctx } from '../http/context.js';
import { HttpError } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import type { JourneyAtStage, Lifecycle } from '../projects/journey.js';

export function registerReviewRoutes(router: Router, core: AppCore, designs: Designs, lifecycle: Lifecycle): void {
  const { notify, originOf } = core;
  const { loadForMove, assertStrict } = lifecycle;
  const on = router.on.bind(router);

  const stageLink = (c: Ctx, stage: string) => `${originOf(c.req)}/p/${c.p[0]!}/${stage}`;
  const reviewEvent = (c: Ctx, j: JourneyAtStage, kind: 'review_requested' | 'review_withdrawn', note: string) =>
    c.as(async (q) => {
      await q(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor, note) VALUES ($1, $2, $3, $4, $5, $5, $6, $7)`, [c.p[0], j.project.org_id, j.project.cycle, kind, j.project.stage, c.user.id, note]);
      await audit(q, c.user, j.project.org_id, c.p[0]!, `review.${kind}`, { stage: j.project.stage, note });
    });
  /** After commit: telling open pages to refresh never decides whether the request worked. */
  const broadcast = async (c: Ctx, orgId: string) => {
    try {
      (await designs.open(c.p[0]!, orgId, c.user.id)).routes.broadcast('journey', Date.now());
    } catch (err) {
      logger.error('could not announce a review change', { err });
    }
  };

  on('POST', `/api/projects/${U}/review/request`, async (c) => {
    const b = await c.body(z.object({ note: z.string().trim().max(2000).default('') }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    if (!j.stage.signoff.required) throw new HttpError(400, `${j.stage.name} does not need a review for ${j.workType.name} work.`);
    if (['in_review', 'approved'].includes(j.stage.signoff.status)) throw new HttpError(409, 'A review is already open on this stage.');
    // open checks never stop a review being asked for: the reviewer sees them as warnings
    const warnings = j.stage.checks.filter((x) => !x.ok).map((x) => x.label);
    await reviewEvent(c, j, 'review_requested', b.note);
    const people = await c.as((q) => q<{ email: string }>(`SELECT u.email FROM project_members pm JOIN users u ON u.id = pm.user_id WHERE pm.project_id = $1 AND u.id <> app_uid()`, [c.p[0]]));
    const open = warnings.length ? `\n\nStill open: ${warnings.join('; ')}.` : '';
    notify(people.map((p) => p.email), `Review requested: ${j.project.name} · ${j.stage.name}`, `${c.user.name} asked for a review of ${j.stage.name} on ${j.project.name}.${b.note ? `\n\n"${b.note}"` : ''}${open}\n\nReview it: ${stageLink(c, j.project.stage)}`);
    await broadcast(c, j.project.org_id);
    c.json(200, { ok: true, warnings });
  });

  on('POST', `/api/projects/${U}/review/withdraw`, async (c) => {
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    if (!j.stage.signoff.requestedBy) throw new HttpError(409, 'There is no open review to withdraw.');
    await reviewEvent(c, j, 'review_withdrawn', '');
    await broadcast(c, j.project.org_id);
    c.json(200, { ok: true });
  });

  on('POST', `/api/projects/${U}/signoff`, async (c) => {
    const b = await c.body(z.object({ decision: z.enum(['approved', 'changes_requested']), note: z.string().trim().max(2000).default('') }));
    if (b.decision === 'changes_requested' && !b.note) throw new HttpError(400, 'Say what needs to change.');
    const j = await loadForMove(c.user.id, c.p[0]!);
    if (!j.stage.signoff.required) throw new HttpError(400, `${j.stage.name} does not need a sign-off for ${j.workType.name} work.`);
    const requestedBy = j.stage.signoff.requestedBy;
    if (!requestedBy) throw new HttpError(409, 'Nobody has asked for a review of this stage yet.');
    if (requestedBy === c.user.id) throw new HttpError(403, 'You asked for this review, so someone else needs to make the decision.');
    requireCapability(j.can, 'approve', 'Only people named as approvers on this project can decide a review.');
    // strict mode: approving with failing checks needs an override, made in this round by someone other than the requester
    if (b.decision === 'approved') assertStrict(j, j.project.stage, 'approve', requestedBy, j.stage.signoff.roundStart);
    // approving over open checks lists them as exceptions on the record
    const exceptions = b.decision === 'approved' ? j.stage.checks.filter((x) => !x.ok).map((x) => x.label) : [];
    await c.as(async (q) => {
      await q(`INSERT INTO stage_signoffs (project_id, org_id, cycle, stage, decision, note, reviewer) VALUES ($1, $2, $3, $4, $5, $6, app_uid())`, [c.p[0], j.project.org_id, j.project.cycle, j.project.stage, b.decision, b.note]);
      await audit(q, c.user, j.project.org_id, c.p[0]!, `signoff.${b.decision}`, { stage: j.project.stage, note: b.note, exceptions });
    });
    const [requester] = await c.as((q) => q<{ email: string }>(`SELECT email FROM users WHERE id = $1 AND id <> app_uid()`, [requestedBy]));
    if (requester) notify([requester.email], `${b.decision === 'approved' ? 'Approved' : 'Changes requested'}: ${j.project.name} · ${j.stage.name}`, `${c.user.name} ${b.decision === 'approved' ? 'approved' : 'requested changes on'} ${j.stage.name}.${b.note ? `\n\n"${b.note}"` : ''}\n\nOpen it: ${stageLink(c, j.project.stage)}`);
    await broadcast(c, j.project.org_id);
    c.json(200, { ok: true, exceptions });
  });
}
