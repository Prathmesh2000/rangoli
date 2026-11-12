/** The UI/UX lifecycle of one project: its journey through the stage views, and moving between them. */
import {
  designFacts,
  evaluateStage,
  isStrict,
  signoffState,
  stageDef,
  stageIndex,
  stagePolicy,
  STAGES,
  stageWarnings,
  workTypeDef,
  type DesignFacts,
  type LifecycleItem,
  type ProjectCapability,
  type ProjectRole,
  type ScreenFrameLink,
  type Signoff,
  type StageEvent,
  type StageId,
  type StrictAction,
  type WorkType,
  type WorkTypeDef,
} from '@rangoli/engine';
import { logger } from '../../telemetry/log.js';
import { audit } from '../access/audit.js';
import type { Designs } from '../agents/designs.js';
import type { Q } from '../db.js';
import type { As, User } from '../http/context.js';
import { HttpError, notFound } from '../http/errors.js';
import { actor } from '../store.js';

export interface Workstream {
  id: string;
  name: string;
  is_main: boolean;
  cycle: number;
  work_type: WorkType;
  stage: StageId;
  status: 'active' | 'closed';
}

export interface StrictOverride {
  id: string;
  cycle: number;
  stage: StageId;
  action: StrictAction;
  reason: string;
  actor: string;
  actor_name: string;
  created_at: string;
}

const loadJourney = (q: Q, projectId: string) =>
  Promise.all([
    q<LifecycleItem & { workstream_id: string | null }>(`SELECT id, kind, cycle, title, body, data, status, created_by, created_at, updated_at, workstream_id FROM items WHERE project_id = $1 ORDER BY created_at`, [projectId]),
    q<StageEvent>(`SELECT id, cycle, kind, from_stage, to_stage, actor, note, created_at FROM stage_events WHERE project_id = $1 ORDER BY created_at`, [projectId]),
    // once an account is deleted its decisions have no reviewer id; each still counts as one person's decision
    q<Signoff & { reviewer_name: string }>(`SELECT id, cycle, stage, decision, note, coalesce(reviewer::text, 'former:' || id) AS reviewer, reviewer_name, created_at FROM stage_signoffs WHERE project_id = $1 ORDER BY created_at`, [projectId]),
    q<ScreenFrameLink>(`SELECT id, screen_id AS screen, frame_node AS frame, device, w, h, is_primary AS primary, linked_from AS "linkedFrom" FROM screen_frames WHERE project_id = $1 ORDER BY is_primary DESC, created_at`, [projectId]),
    q<Workstream>(`SELECT id, name, is_main, cycle, work_type, stage, status FROM workstreams WHERE project_id = $1 ORDER BY cycle DESC, created_at`, [projectId]),
    q<StrictOverride>(`SELECT id, cycle, stage, action, reason, coalesce(actor::text, 'former:' || id) AS actor, actor_name, created_at FROM strict_overrides WHERE project_id = $1 ORDER BY created_at`, [projectId]),
  ]);

const evaluate = (stage: StageId, cycle: number, type: WorkTypeDef, items: LifecycleItem[], signoffs: Signoff[], events: StageEvent[], facts: DesignFacts, frames: ScreenFrameLink[]) => {
  const policy = stagePolicy(type, stage);
  const checks = evaluateStage(stage, { cycle, items, design: facts, frames });
  const signoff = signoffState(stage, cycle, signoffs, events, policy);
  const checksOk = checks.every((c) => c.ok);
  return { checks, signoff, checksOk, inType: policy.inType, ready: checksOk && (!signoff.required || signoff.approved) };
};

/** An override that lets this action through: same cycle and stage, made in this round, by someone other than `notBy`. */
export const overrideFor = (overrides: StrictOverride[], cycle: number, stage: StageId, action: StrictAction, since: string | null, notBy: string): StrictOverride | undefined =>
  [...overrides].reverse().find((o) => o.cycle === cycle && o.stage === stage && o.action === action && o.actor !== notBy && (!since || new Date(o.created_at).getTime() >= new Date(since).getTime()));

export function createLifecycle(as: As, designs: Designs) {
  const design = designs.open;

  async function journey(userId: string, projectId: string) {
    const data = await as(userId, async (q) => {
      const [project] = await q<{ id: string; org_id: string; name: string; description: string; stage: StageId; cycle: number; role: ProjectRole; can: ProjectCapability[]; org_name: string; org_slug: string; org_strict: boolean }>(
        `SELECT p.id, p.org_id, p.name, p.description, p.stage, p.cycle, project_role_of(p.id) AS role, my_capabilities(p.id, 'project') AS can, o.name AS org_name, o.slug AS org_slug, o.strict_mode AS org_strict FROM projects p JOIN orgs o ON o.id = p.org_id WHERE p.id = $1`,
        [projectId],
      );
      if (!project?.role) throw notFound();
      const [items, events, signoffs, screenFrames, workstreams, overrides] = await loadJourney(q, projectId);
      const people = await q<{ id: string; name: string }>(`SELECT id, name FROM users`);
      // a decision keeps the name it was made with, even if that person can no longer be looked up
      for (const s of signoffs) if (!people.some((p) => p.id === s.reviewer)) people.push({ id: s.reviewer, name: s.reviewer_name });
      for (const o of overrides) if (!people.some((p) => p.id === o.actor)) people.push({ id: o.actor, name: o.actor_name });
      return { project, items, events, signoffs, screenFrames, workstreams, overrides, people };
    });
    const { project, items, events, signoffs, screenFrames, workstreams, overrides, people } = data;
    const workstream = workstreams.find((w) => w.is_main && w.status === 'active') ?? null;
    const workType = workTypeDef(workstream?.work_type);
    const strict = isStrict(project.org_strict, workType);
    const { session } = await design(projectId, project.org_id, userId);
    const facts = designFacts(session.doc);
    const currentIndex = stageIndex(project.stage);
    const stages = STAGES.map((s, i) => {
      const view = { ...s, current: i === currentIndex, state: i < currentIndex ? 'done' : i === currentIndex ? 'current' : 'upcoming', ...evaluate(s.id, project.cycle, workType, items, signoffs, events, facts, screenFrames) };
      // gaps in stages behind the project, or the one it is in, are warnings; nothing is ever locked
      return { ...view, warnings: i <= currentIndex ? stageWarnings(view) : [] };
    });
    const agent = { online: session.presenceList().some((p) => p.role === 'agent'), requests: session.reviews.requests.slice(-20) };
    return {
      agent,
      project: { ...project, strict },
      role: project.role,
      // what the caller may do here, from has_capability: the editor and the routes decide on this, not on role
      can: project.can,
      workstream,
      workstreams,
      workType,
      strict,
      stages,
      warnings: stages.flatMap((s) => s.warnings),
      items,
      events,
      signoffs,
      overrides: overrides.filter((o) => o.cycle === project.cycle),
      people,
      screenFrames,
      frames: facts.frames,
      blocking: facts.blocking,
      links: facts.links,
      start: facts.start,
    };
  }

  /**
   * Runs after commit (a nested transaction would deadlock on a single-connection database), so the stage has
   * already moved. Nothing here may fail the request: each step is caught and logged, and what did not happen
   * is returned for the response to report.
   */
  const afterStageChange = async (projectId: string, orgId: string, user: User, leaving: StageId | null, cycle: number): Promise<string[]> => {
    const problems: string[] = [];
    let entry: Awaited<ReturnType<typeof design>> | undefined;
    try {
      entry = await design(projectId, orgId, user.id);
    } catch (err) {
      logger.error('could not open the design after a stage change', { err, projectId });
      problems.push('The stage moved, but the design could not be opened to save a version.');
      return problems;
    }
    if (leaving && stageDef(leaving)?.designOpen) {
      try {
        await actor.run(user.id, () => entry.session.saveVersion(`${stageDef(leaving)!.name} · cycle ${cycle}`.slice(0, 32), `human:${user.name}`));
      } catch (err) {
        logger.error('could not save a version after a stage change', { err, projectId });
        problems.push('The stage moved, but the named version of the design could not be saved. Save one from the canvas.');
      }
    }
    try {
      entry.routes.broadcast('journey', Date.now());
    } catch (err) {
      logger.error('could not announce a stage change', { err, projectId });
    }
    return problems;
  };

  const moveStage = (q: Q, user: User, project: { id: string; org_id: string; cycle: number }, kind: StageEvent['kind'], from: StageId, to: StageId, note: string, cycle = project.cycle, detail: object = {}) =>
    (async () => {
      const moved = await q(`UPDATE projects SET stage = $1, cycle = $2, updated_at = clock_timestamp() WHERE id = $3 AND stage = $4 AND cycle = $5 RETURNING 1`, [to, cycle, project.id, from, project.cycle]);
      if (!moved.length) throw new HttpError(409, 'The project moved on while you were working. Reload and try again.');
      await q(`INSERT INTO stage_events (project_id, org_id, cycle, kind, from_stage, to_stage, actor, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [project.id, project.org_id, cycle, kind, from, to, user.id, note]);
      await audit(q, user, project.org_id, project.id, `stage.${kind}`, { from, to, note, ...detail });
    })();

  /** The journey plus its current stage, for routes that act on that stage. */
  const loadForMove = async (userId: string, projectId: string) => {
    const j = await journey(userId, projectId);
    const stage = j.stages.find((s) => s.current)!;
    return { ...j, stage };
  };

  /**
   * Strict mode: approval and release need every check to pass, or an admin's override with a reason, made by
   * someone other than `notBy` (the review's requester, or the person releasing). Off by default: warnings only.
   */
  const assertStrict = (j: Awaited<ReturnType<typeof journey>>, stageId: StageId, action: StrictAction, notBy: string, since: string | null): void => {
    const stage = j.stages.find((s) => s.id === stageId)!;
    if (!j.strict || stage.checksOk) return;
    if (overrideFor(j.overrides, j.project.cycle, stageId, action, since, notBy)) return;
    const what = action === 'approve' ? 'approved' : 'released';
    throw new HttpError(409, `Strict mode is on, so ${stage.name} cannot be ${what} while checks fail. An admin other than you can record an override with a reason.`, { checks: stage.checks, strict: true });
  };

  return { journey, afterStageChange, moveStage, loadForMove, assertStrict };
}

export type Lifecycle = ReturnType<typeof createLifecycle>;
export type Journey = Awaited<ReturnType<Lifecycle['journey']>>;
export type JourneyAtStage = Awaited<ReturnType<Lifecycle['loadForMove']>>;
