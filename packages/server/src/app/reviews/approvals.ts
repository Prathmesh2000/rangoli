/**
 * Approval records: a named person's decision on one snapshot (PRD §8.6 AP2, §10).
 *
 * The database is the boundary (migration-010: approval_decide policy and approval_decision_guard). These checks
 * come first so people get a clear answer: not your own review, only named approvers, open checks accepted with a
 * note, strict mode. Then a step-up: a second factor within five minutes, whose time is recorded with the decision.
 */
import type { StageId } from '@rangoli/engine';
import { z } from 'zod';
import { audit } from '../access/audit.js';
import { requireCapability } from '../access/roles.js';
import type { Q } from '../db.js';
import type { AppCore, Ctx } from '../http/context.js';
import { HttpError } from '../http/errors.js';
import type { JourneyAtStage, Lifecycle } from '../projects/journey.js';

export type ApprovalStatus = 'open' | 'approved' | 'changes_requested' | 'withdrawn';

export interface ApprovalRow {
  id: string;
  snapshot_id: string;
  cycle: number;
  stage: StageId;
  rule: 'any' | 'all';
  approvers: string[];
  note: string;
  requested_by: string | null;
  requested_by_name: string;
  withdrawn_at: string | null;
  created_at: string;
  status: ApprovalStatus;
}

export interface DecisionRow {
  id: string;
  approval_id: string;
  snapshot_id: string;
  content_hash: string;
  /** 'former:<id>' once the account is gone; approver_name still says who */
  approver: string;
  approver_name: string;
  decision: 'approved' | 'changes_requested';
  note: string;
  exceptions: { check: string; label: string; note: string }[];
  mfa_at: string | null;
  via: 'app' | 'link';
  created_at: string;
}

const APPROVAL_COLUMNS = `id, snapshot_id, cycle, stage, rule, approvers, note, requested_by, requested_by_name, withdrawn_at, created_at, approval_status(id) AS status`;

export const decisionBody = z.object({
  decision: z.enum(['approved', 'changes_requested']),
  note: z.string().trim().max(2000).default(''),
  /** a note for each open check accepted as an exception; the decision's note covers any left out */
  exceptions: z.array(z.object({ check: z.string().max(200), note: z.string().trim().max(1000) })).max(50).default([]),
});
export type DecisionBody = z.infer<typeof decisionBody>;

export const getApproval = async (q: Q, projectId: string, approvalId: string): Promise<ApprovalRow | null> =>
  (await q<ApprovalRow>(`SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE id = $1 AND project_id = $2`, [approvalId, projectId]))[0] ?? null;

/** The approval behind the review open on this stage now, if it was asked for with a snapshot. */
export const currentApproval = async (q: Q, j: JourneyAtStage): Promise<ApprovalRow | null> => {
  if (!j.stage.signoff.requestedBy) return null;
  const since = j.stage.signoff.roundStart;
  const [row] = await q<ApprovalRow>(
    `SELECT ${APPROVAL_COLUMNS} FROM approvals WHERE project_id = $1 AND cycle = $2 AND stage = $3 AND withdrawn_at IS NULL AND ($4::timestamptz IS NULL OR created_at >= $4::timestamptz) ORDER BY created_at DESC LIMIT 1`,
    [j.project.id, j.project.cycle, j.project.stage, since],
  );
  return row ?? null;
};

export const listApprovals = async (q: Q, projectId: string) => {
  const approvals = await q<ApprovalRow & { snapshot_name: string; content_hash: string }>(
    `SELECT a.id, a.snapshot_id, a.cycle, a.stage, a.rule, a.approvers, a.note, a.requested_by, a.requested_by_name, a.withdrawn_at, a.created_at, approval_status(a.id) AS status, s.name AS snapshot_name, s.content_hash
     FROM approvals a JOIN snapshots s ON s.id = a.snapshot_id WHERE a.project_id = $1 ORDER BY a.created_at DESC LIMIT 50`,
    [projectId],
  );
  const decisions = approvals.length
    ? await q<DecisionRow>(
        `SELECT id, approval_id, snapshot_id, content_hash, coalesce(approver_id::text, 'former:' || id) AS approver, approver_name, decision, note, exceptions, mfa_at, via, created_at
         FROM approval_decisions WHERE approval_id = ANY ($1::uuid[]) ORDER BY created_at`,
        [approvals.map((a) => a.id)],
      )
    : [];
  const named = [...new Set(approvals.flatMap((a) => a.approvers))];
  const names = named.length ? await q<{ id: string; name: string }>(`SELECT id, name FROM users WHERE id = ANY ($1::uuid[])`, [named]) : [];
  return approvals.map((a) => ({
    ...a,
    approverNames: a.approvers.map((id) => names.find((n) => n.id === id)?.name ?? 'Former member'),
    decisions: decisions.filter((d) => d.approval_id === a.id),
  }));
};
export type ApprovalView = Awaited<ReturnType<typeof listApprovals>>[number];

/** Open checks accepted as exceptions, each with its note. Approving over an open check without one is refused. */
export function exceptionsFor(j: JourneyAtStage, b: DecisionBody): DecisionRow['exceptions'] {
  if (b.decision !== 'approved') return [];
  const open = j.stage.checks.filter((x) => !x.ok);
  const out = open.map((chk) => {
    const given = b.exceptions.find((e) => e.check === chk.id || e.check === chk.label);
    return { check: chk.id, label: chk.label, note: (given?.note || b.note).trim() };
  });
  const missing = out.filter((e) => !e.note);
  if (missing.length) {
    throw new HttpError(400, `Approving with open checks lists them as exceptions. Add a note accepting: ${missing.map((e) => e.label).join('; ')}.`, { exceptions: open.map((x) => ({ check: x.id, label: x.label })) });
  }
  return out;
}

/**
 * Records a decision on the review open on the current stage. `approval` is that review's snapshot-bound record;
 * null only for a review asked for before snapshots existed, which is decided as a legacy stage sign-off.
 */
export async function decide(core: AppCore, lifecycle: Lifecycle, c: Ctx, j: JourneyAtStage, approval: ApprovalRow | null, b: DecisionBody, via: 'app' | 'link' = 'app') {
  if (b.decision === 'changes_requested' && !b.note) throw new HttpError(400, 'Say what needs to change.');
  if (!j.stage.signoff.required) throw new HttpError(400, `${j.stage.name} does not need a sign-off for ${j.workType.name} work.`);
  const requestedBy = approval ? approval.requested_by : j.stage.signoff.requestedBy;
  if (!j.stage.signoff.requestedBy) throw new HttpError(409, 'Nobody has asked for a review of this stage yet.');
  // every role, admins and leads included
  if (requestedBy === c.user.id || j.stage.signoff.requestedBy === c.user.id) throw new HttpError(403, 'You asked for this review, so someone else needs to make the decision.');
  requireCapability(j.can, 'approve', 'Only people named as approvers on this project can decide a review.');
  if (approval) {
    if (approval.status === 'withdrawn') throw new HttpError(409, 'This review was withdrawn, so there is nothing to decide.');
    if (approval.approvers.length && !approval.approvers.includes(c.user.id)) throw new HttpError(403, 'This review names its approvers, and you are not one of them.');
  }
  if (b.decision === 'approved') lifecycle.assertStrict(j, j.project.stage, 'approve', j.stage.signoff.requestedBy, j.stage.signoff.roundStart);
  const exceptions = exceptionsFor(j, b);
  // the person is at the keyboard now: a second factor within five minutes, recorded with the decision
  const { mfaAt } = await core.stepUp(c.req, { approval: true });
  const mfa = mfaAt ? new Date(mfaAt).toISOString() : null;
  const decided = await c.as(async (q) => {
    let row: { id: string; snapshot_id: string; content_hash: string } | undefined;
    if (approval) {
      [row] = await q<{ id: string; snapshot_id: string; content_hash: string }>(
        `INSERT INTO approval_decisions (approval_id, project_id, org_id, snapshot_id, content_hash, approver_id, decision, note, exceptions, mfa_at, via)
         SELECT a.id, a.project_id, a.org_id, a.snapshot_id, s.content_hash, app_uid(), $2, $3, $4::jsonb, $5, $6 FROM approvals a JOIN snapshots s ON s.id = a.snapshot_id WHERE a.id = $1
         RETURNING id, snapshot_id, content_hash`,
        [approval.id, b.decision, b.note, JSON.stringify(exceptions), mfa, via],
      );
    }
    // the stage's own record, which the journey reads
    await q(`INSERT INTO stage_signoffs (project_id, org_id, cycle, stage, decision, note, reviewer) VALUES ($1, $2, $3, $4, $5, $6, app_uid())`, [j.project.id, j.project.org_id, j.project.cycle, j.project.stage, b.decision, b.note]);
    await audit(q, c.user, j.project.org_id, j.project.id, `signoff.${b.decision}`, { stage: j.project.stage, note: b.note, exceptions, approval: approval?.id ?? null, snapshot: row?.snapshot_id ?? null, contentHash: row?.content_hash ?? null, mfaAt: mfa, via });
    const status = approval ? (await q<{ s: ApprovalStatus }>(`SELECT approval_status($1) AS s`, [approval.id]))[0]!.s : null;
    return { row, status };
  });
  return { exceptions, requestedBy: j.stage.signoff.requestedBy, decision: decided.row ?? null, status: decided.status, mfaAt: mfa, legacy: !approval };
}
