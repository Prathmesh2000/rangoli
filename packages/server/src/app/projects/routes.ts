/** Projects and their stage views: list, create, rename, delete, read the journey, advance, send back, next cycle. */
import { createDocument, DEFAULT_WORK_TYPE, isStrict, nextStage, signoffState, stagePolicy, STAGES, stageIndex, workTypeDef, WORK_TYPE_IDS, type ProjectCapability, type Signoff, type StageEvent, type StageId, type WorkType } from '@rangoli/engine';
import { z } from 'zod';
import { logger } from '../../telemetry/log.js';
import { audit } from '../access/audit.js';
import { orgAccessOf, requireCapability, requireOrgCapability } from '../access/roles.js';
import type { Designs } from '../agents/designs.js';
import type { AppCore } from '../http/context.js';
import { HttpError, notFound } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import { projectBlobPrefix } from '../store.js';
import type { JourneyAtStage, Lifecycle } from './journey.js';

const stageId = z.enum(STAGES.map((s) => s.id) as [StageId, ...StageId[]]);
const workType = z.enum(WORK_TYPE_IDS as [WorkType, ...WorkType[]]);

/** The open checks a move leaves behind: never a reason to refuse it, always on the record. */
const gaps = (j: JourneyAtStage) => [
  ...j.stage.warnings.map((w) => w.message),
  ...(j.stage.signoff.required && !j.stage.signoff.approved ? [`${j.stage.name}: not approved yet`] : []),
];

export function registerProjectRoutes(router: Router, core: AppCore, designs: Designs, lifecycle: Lifecycle): void {
  const { blobs } = core;
  const { journey, loadForMove, moveStage, afterStageChange, assertStrict } = lifecycle;
  const on = router.on.bind(router);

  on('GET', `/api/orgs/${U}/projects`, async (c) => {
    const { role, can } = await orgAccessOf(c, c.p[0]!);
    const { org, rows, events, signoffs } = await c.as(async (q) => {
      const [org] = await q<{ strict_mode: boolean }>(`SELECT strict_mode FROM orgs WHERE id = $1`, [c.p[0]]);
      // only projects this person can open; their review state comes from those projects alone
      const rows = await q<{ id: string; name: string; description: string; stage: StageId; cycle: number; updated_at: string; my_can: ProjectCapability[]; work_type: WorkType | null }>(
        `SELECT p.id, p.name, p.description, p.stage, p.cycle, p.updated_at, my_capabilities(p.id, 'project') AS my_can, w.work_type
         FROM projects p LEFT JOIN workstreams w ON w.project_id = p.id AND w.is_main AND w.status = 'active'
         WHERE p.org_id = $1 AND project_role_of(p.id) IS NOT NULL ORDER BY p.updated_at DESC`,
        [c.p[0]],
      );
      const ids = rows.map((r) => r.id);
      if (!ids.length) return { org, rows, events: [], signoffs: [] };
      return {
        org,
        rows,
        events: await q<StageEvent & { project_id: string }>(`SELECT e.project_id, e.id, e.cycle, e.kind, e.from_stage, e.to_stage, e.actor, e.note, e.created_at FROM stage_events e JOIN projects p ON p.id = e.project_id AND p.cycle = e.cycle AND p.stage = e.to_stage WHERE e.project_id = ANY($1::uuid[])`, [ids]),
        signoffs: await q<Signoff & { project_id: string }>(`SELECT f.project_id, f.id, f.cycle, f.stage, f.decision, f.note, coalesce(f.reviewer::text, 'former:' || f.id) AS reviewer, f.created_at FROM stage_signoffs f JOIN projects p ON p.id = f.project_id AND p.cycle = f.cycle AND p.stage = f.stage WHERE f.project_id = ANY($1::uuid[])`, [ids]),
      };
    });
    const strictMode = !!org?.strict_mode;
    const projects = rows.map(({ my_can, work_type, ...p }) => {
      const type = workTypeDef(work_type);
      const s = signoffState(p.stage, p.cycle, signoffs.filter((x) => x.project_id === p.id), events.filter((x) => x.project_id === p.id), stagePolicy(type, p.stage));
      const decided = s.decisions.some((d) => d.reviewer === c.user.id);
      const canDecide = s.requestedBy !== c.user.id;
      const attention = s.status === 'in_review' && canDecide && !decided ? 'review' : !my_can.includes('design.edit') ? null : s.status === 'changes_requested' ? 'fix' : s.status === 'approved' ? 'advance' : null;
      return { ...p, work_type: type.id, strict: isStrict(strictMode, type), review: s.required ? s.status : 'working', attention };
    });
    c.json(200, { role, can, strictMode, projects });
  });

  on('POST', `/api/orgs/${U}/projects`, async (c) => {
    const b = await c.body(z.object({ name: z.string().trim().min(1, 'Enter a name').max(120), description: z.string().trim().max(2000).default(''), workType: workType.default(DEFAULT_WORK_TYPE) }));
    const doc = createDocument(b.name);
    const [row] = await c.as(async (q) => {
      const rows = await q<{ id: string }>(`SELECT create_project($1, $2, $3, $4::json) AS id`, [c.p[0], b.name, b.description, JSON.stringify(doc.data)]);
      // the project starts with Main (made by the database); its work type is the creator's choice
      await q(`UPDATE workstreams SET work_type = $1, updated_at = clock_timestamp() WHERE project_id = $2 AND is_main AND status = 'active'`, [b.workType, rows[0]!.id]);
      await audit(q, c.user, c.p[0]!, rows[0]!.id, 'project.create', { name: b.name, workType: b.workType });
      return rows;
    });
    c.json(200, row);
  });

  /** Strict mode is an organization setting, off unless an admin turns it on. */
  on('PATCH', `/api/orgs/${U}/settings`, async (c) => {
    const b = await c.body(z.object({ strictMode: z.boolean() }));
    await requireOrgCapability(c, c.p[0]!, 'org.settings.manage');
    await c.as(async (q) => {
      // the column has no app grant: the function checks the caller and refuses API tokens
      const [row] = await q<{ ok: boolean }>(`SELECT org_set_strict_mode($1, $2) AS ok`, [c.p[0], b.strictMode]);
      if (!row?.ok) throw notFound();
      await audit(q, c.user, c.p[0]!, null, 'org.strict_mode', { on: b.strictMode });
    });
    c.json(200, { strictMode: b.strictMode });
  });

  // ---- projects & journey
  on('GET', `/api/projects/${U}/journey`, async (c) => c.json(200, await journey(c.user.id, c.p[0]!)));

  on('PATCH', `/api/projects/${U}`, async (c) => {
    const b = await c.body(z.object({ name: z.string().trim().min(1).max(120).optional(), description: z.string().trim().max(2000).optional(), workType: workType.optional() }));
    await c.as(async (q) => {
      const [project] = await q<{ org_id: string; role: string | null; can: ProjectCapability[] }>(`SELECT org_id, project_role_of(id) AS role, my_capabilities(id, 'project') AS can FROM projects WHERE id = $1`, [c.p[0]]);
      if (!project?.role) throw notFound();
      requireCapability(project.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
      const rows = await q(`UPDATE projects SET name = coalesce($1, name), description = coalesce($2, description), updated_at = clock_timestamp() WHERE id = $3 RETURNING 1`, [b.name ?? null, b.description ?? null, c.p[0]]);
      if (!rows.length) throw new HttpError(403, 'You cannot edit this project.');
      if (b.workType) await q(`UPDATE workstreams SET work_type = $1, updated_at = clock_timestamp() WHERE project_id = $2 AND is_main AND status = 'active'`, [b.workType, c.p[0]]);
      await audit(q, c.user, project.org_id, c.p[0]!, 'project.update', { name: b.name, workType: b.workType });
    });
    c.json(200, { ok: true });
  });

  on('DELETE', `/api/projects/${U}`, async (c) => {
    const [project] = await c.as((q) => q<{ org_id: string; name: string }>(`SELECT org_id, name FROM projects WHERE id = $1`, [c.p[0]]));
    if (!project) throw notFound();
    await requireOrgCapability(c, project.org_id, 'org.projects.delete', 'Only owners and admins can delete projects.');
    await c.as(async (q) => {
      await audit(q, c.user, project.org_id, null, 'project.delete', { name: project.name });
      await q(`DELETE FROM projects WHERE id = $1`, [c.p[0]]);
    });
    designs.evict(c.p[0]!);
    await blobs?.deletePrefix(projectBlobPrefix(project.org_id, c.p[0]!)).catch((err: unknown) => logger.error('could not delete stored images', { err }));
    c.json(200, { ok: true });
  });

  // ---- stages: moving is never refused for open checks; they come back as warnings and go on the record

  on('POST', `/api/projects/${U}/advance`, async (c) => {
    const b = await c.body(z.object({ override: z.string().trim().max(1000).optional() }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    const to = nextStage(j.project.stage);
    if (!to) throw new HttpError(400, 'This is the last stage. Start the next cycle instead.');
    if (b.override) requireCapability(j.can, 'override.strict', 'Only the project lead can record a skipped gate.');
    // leaving Handoff is the release: in strict mode it needs passing checks or someone else's override
    if (j.project.stage === 'handoff') assertStrict(j, 'handoff', 'release', c.user.id, null);
    const warnings = gaps(j);
    await c.as((q) => moveStage(q, c.user, j.project, b.override ? 'override' : 'advance', j.project.stage, to, b.override ?? '', j.project.cycle, { skipped: warnings }));
    const problems = await afterStageChange(c.p[0]!, j.project.org_id, c.user, j.project.stage, j.project.cycle);
    c.json(200, { stage: to, warnings, problems });
  });

  on('POST', `/api/projects/${U}/send-back`, async (c) => {
    const b = await c.body(z.object({ to: stageId, note: z.string().trim().min(1, 'Say why this is going back').max(2000) }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    if (stageIndex(b.to) >= stageIndex(j.project.stage)) throw new HttpError(400, 'A project can only be sent back to an earlier stage.');
    await c.as((q) => moveStage(q, c.user, j.project, 'send_back', j.project.stage, b.to, b.note));
    const problems = await afterStageChange(c.p[0]!, j.project.org_id, c.user, j.project.stage, j.project.cycle);
    c.json(200, { stage: b.to, problems });
  });

  on('POST', `/api/projects/${U}/next-cycle`, async (c) => {
    const b = await c.body(z.object({ promote: z.array(z.string().uuid()).max(200).default([]), override: z.string().trim().max(1000).optional() }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    if (j.project.stage !== 'launch') throw new HttpError(400, 'A new cycle starts after Post-launch.');
    if (b.override) requireCapability(j.can, 'override.strict', 'Only the project lead can record a skipped gate.');
    const warnings = gaps(j);
    const cycle = j.project.cycle + 1;
    await c.as(async (q) => {
      // the database closes this cycle's Main and opens the next one's
      await moveStage(q, c.user, j.project, 'new_cycle', 'launch', 'discovery', b.override ?? '', cycle, { skipped: warnings });
      // what people said after launch becomes the next cycle's research
      for (const id of b.promote) {
        const fb = j.items.find((i) => i.id === id && i.kind === 'feedback');
        if (!fb) continue;
        await q(`INSERT INTO items (project_id, org_id, kind, cycle, title, body, data, created_by) VALUES ($1, $2, 'research', $3, $4, $5, $6::jsonb, app_uid())`, [c.p[0], j.project.org_id, cycle, fb.title, fb.body, JSON.stringify({ method: 'feedback', fromFeedback: fb.id, source: fb.data.source ?? '' })]);
        await q(`UPDATE items SET status = 'promoted', updated_at = clock_timestamp() WHERE id = $1`, [fb.id]);
      }
    });
    const problems = await afterStageChange(c.p[0]!, j.project.org_id, c.user, null, cycle);
    c.json(200, { stage: 'discovery', cycle, warnings, problems });
  });

  /**
   * Strict-mode override: an admin's reason for approving or releasing with failing checks. It only counts for
   * someone else's action, so two people are always involved. The database refuses one from the review's requester.
   */
  on('POST', `/api/projects/${U}/overrides`, async (c) => {
    const b = await c.body(z.object({ action: z.enum(['approve', 'release']), reason: z.string().trim().min(1, 'Give the reason for the override').max(1000) }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'override.strict', 'Only the project lead can override strict mode.');
    if (!j.strict) throw new HttpError(400, 'Strict mode is off for this project, so nothing needs an override.');
    const stage: StageId = b.action === 'release' ? 'handoff' : j.project.stage;
    if (b.action === 'approve' && j.stage.signoff.requestedBy === c.user.id) throw new HttpError(403, 'You asked for this review, so someone else needs to override it.');
    const [row] = await c.as(async (q) => {
      const rows = await q<{ id: string }>(`INSERT INTO strict_overrides (project_id, org_id, cycle, stage, action, reason, actor) VALUES ($1, $2, $3, $4, $5, $6, app_uid()) RETURNING id`, [c.p[0], j.project.org_id, j.project.cycle, stage, b.action, b.reason]);
      await audit(q, c.user, j.project.org_id, c.p[0]!, `strict.override.${b.action}`, { stage, reason: b.reason });
      return rows;
    });
    try {
      (await designs.open(c.p[0]!, j.project.org_id, c.user.id)).routes.broadcast('journey', Date.now());
    } catch (err) {
      logger.error('could not announce an override', { err });
    }
    c.json(200, { id: row!.id, stage, action: b.action });
  });
}
