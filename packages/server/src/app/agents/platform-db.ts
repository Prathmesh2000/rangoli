/**
 * Notes, tasks, job leases and named runs in Postgres (migration 011). Every call runs as the person behind the
 * request and, for an agent, through its token, so the database's functions and policies decide: only a person
 * with `task.create` leaves a request, only a token with the `jobs` scope claims one, leases are taken with
 * `FOR UPDATE SKIP LOCKED`, and Undo whole run is a person's.
 */
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { NOTE_TASK_STATUS_LABELS, type ChangeEntry, type NoteTaskKind, type NoteTaskStatus } from '@rangoli/engine';
import {
  connectionState,
  DEFAULT_LIMITS,
  LEASE_MS,
  type AgentIdentity,
  type AgentPlatform,
  type AgentPlatformEvents,
  type ConnectionView,
  type FinishOutcome,
  type JobLease,
  type NewTask,
  type RunView,
  type TaskView,
  type UsageLimits,
} from '../../design/agent-platform.js';
import { logger } from '../../telemetry/log.js';
import { tokenActor, withUser, type Database, type Q } from '../db.js';
import { actor } from '../store.js';

interface TaskRow {
  id: string;
  kind: NoteTaskKind;
  page_id: string | null;
  target_node: string | null;
  author: string | null;
  author_name: string;
  body: string;
  status: NoteTaskStatus;
  agent_name: string | null;
  picked_up_at: number | null;
  run_id: string | null;
  run_no: number | null;
  last_write_at: number | null;
  failure_reason: string | null;
  screen: { id: string; name: string } | null;
  asset: string | null;
  device: TaskView['device'] | null;
  frame: string | null;
  created_at: number;
}

interface RunRow {
  id: string;
  no: number;
  agent_name: string;
  token_id: string | null;
  authorized_by: string | null;
  authorized_name: string | null;
  intent: string;
  task_id: string | null;
  job_id: string | null;
  status: RunView['status'];
  start_seq: number;
  end_seq: number | null;
  started_at: number;
  ended_at: number | null;
  last_write_at: number | null;
  writes: number;
  summary: string | null;
  undone_by_name: string | null;
  undo_report: RunView['undoReport'];
}

const ms = (col: string) => `(extract(epoch FROM ${col}) * 1000)::float8`;
const TASK_COLUMNS = `t.id, t.kind, t.page_id, t.target_node, t.author, t.author_name, t.body, t.status, t.agent_name, ${ms('t.picked_up_at')} AS picked_up_at,
  t.run_id, r.no AS run_no, ${ms('r.last_write_at')} AS last_write_at, t.failure_reason, t.screen, t.asset, t.device, t.frame, ${ms('t.created_at')} AS created_at`;
const TASKS_FROM = `agent_tasks t LEFT JOIN agent_runs r ON r.id = t.run_id`;
const RUN_COLUMNS = `id, no, agent_name, token_id, authorized_by, authorized_name, intent, task_id, job_id, status, start_seq::float8 AS start_seq, end_seq::float8 AS end_seq,
  ${ms('started_at')} AS started_at, ${ms('ended_at')} AS ended_at, ${ms('last_write_at')} AS last_write_at, writes, summary, undone_by_name, undo_report`;

const toTask = (r: TaskRow): TaskView => ({
  id: r.id,
  kind: r.kind,
  status: r.status,
  statusLabel: NOTE_TASK_STATUS_LABELS[r.status],
  target: { ...(r.page_id ? { page: r.page_id } : {}), ...(r.target_node ? { node: r.target_node } : {}) },
  authorId: r.author,
  authorName: r.author_name,
  body: r.body,
  createdAt: r.created_at,
  ...(r.agent_name ? { agent: r.agent_name } : {}),
  ...(r.picked_up_at ? { pickedUpAt: r.picked_up_at } : {}),
  ...(r.run_id ? { runId: r.run_id, runNo: r.run_no ?? undefined } : {}),
  ...(r.last_write_at ? { lastWriteAt: r.last_write_at } : {}),
  ...(r.failure_reason ? { failureReason: r.failure_reason } : {}),
  ...(r.screen ? { screen: r.screen } : {}),
  ...(r.asset ? { asset: r.asset } : {}),
  ...(r.device ? { device: r.device } : {}),
  ...(r.frame ? { frame: r.frame } : {}),
});

const toRun = (r: RunRow): RunView => ({
  id: r.id,
  no: r.no,
  agentName: r.agent_name,
  tokenId: r.token_id,
  authorizedBy: r.authorized_by,
  authorizedByName: r.authorized_name,
  intent: r.intent,
  taskId: r.task_id,
  jobId: r.job_id,
  status: r.status,
  startSeq: r.start_seq,
  endSeq: r.end_seq,
  startedAt: r.started_at,
  endedAt: r.ended_at,
  lastWriteAt: r.last_write_at,
  writes: r.writes,
  summary: r.summary,
  undoneBy: r.undone_by_name,
  undoReport: r.undo_report,
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class DbAgentPlatform extends EventEmitter<AgentPlatformEvents> implements AgentPlatform {
  readonly kind = 'hosted' as const;

  constructor(
    private readonly db: Database,
    private readonly projectId: string,
    private readonly orgId: string,
    readonly limits: UsageLimits = DEFAULT_LIMITS,
  ) {
    super();
  }

  /** As the person behind the current request, through their token when an agent is asking. */
  private as<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    return withUser(this.db, actor.getStore() ?? null, fn);
  }

  private async task(q: Q, id: string): Promise<TaskView> {
    const [row] = await q<TaskRow>(`SELECT ${TASK_COLUMNS} FROM ${TASKS_FROM} WHERE t.id = $1 AND t.project_id = $2`, [id, this.projectId]);
    if (!row) throw new Error(`Note or task ${id} not found`);
    return toTask(row);
  }

  private changed(queued = false): void {
    this.emit('changed');
    if (queued) this.emit('queued');
  }

  async createTask(input: NewTask): Promise<TaskView> {
    const view = await this.as(async (q) => {
      const [row] = await q<{ id: string }>(
        `INSERT INTO agent_tasks (project_id, org_id, kind, page_id, target_node, author, author_name, body, screen, asset, device)
         VALUES ($1, $2, $3, $4, $5, app_uid(), $6, $7, $8::jsonb, $9, $10) RETURNING id`,
        [this.projectId, this.orgId, input.kind, input.target?.page ?? null, input.target?.node ?? null, input.authorName.slice(0, 80) || 'Someone', input.body.slice(0, 8000), input.screen ? JSON.stringify(input.screen) : null, input.asset ?? null, input.device ?? null],
      );
      return this.task(q, row!.id);
    });
    this.changed(true);
    return view;
  }

  async listTasks(): Promise<TaskView[]> {
    return this.as(async (q) => (await q<TaskRow>(`SELECT ${TASK_COLUMNS} FROM ${TASKS_FROM} WHERE t.project_id = $1 ORDER BY t.created_at`, [this.projectId])).map(toTask));
  }

  async requeueTask(id: string): Promise<TaskView> {
    const view = await this.as(async (q) => {
      await q(`SELECT agent_task_requeue($1)`, [id]);
      return this.task(q, id);
    });
    this.changed(true);
    return view;
  }

  async withdrawTask(id: string): Promise<void> {
    await this.as((q) => q(`SELECT agent_task_withdraw($1)`, [id]));
    this.changed();
  }

  async waitingCount(): Promise<number> {
    return this.as(async (q) => {
      await q(`SELECT agent_jobs_reap($1)`, [this.projectId]);
      const [row] = await q<{ n: number }>(`SELECT count(*)::int AS n FROM agent_jobs WHERE project_id = $1 AND status = 'waiting'`, [this.projectId]);
      return row!.n;
    });
  }

  async claimJob(agent: AgentIdentity, leaseMs = LEASE_MS): Promise<JobLease | null> {
    const lease = await this.as(async (q) => {
      const [row] = await q<{ job_id: string; lease_token: string; lease_until: number; attempts: number; task_id: string }>(
        `SELECT job_id, lease_token, ${ms('lease_until')} AS lease_until, attempts, task_id FROM agent_job_claim($1, $2, $3)`,
        [this.projectId, agent.agentName, Math.round(leaseMs / 1000)],
      );
      if (!row) return null;
      return { jobId: row.job_id, leaseToken: row.lease_token, leaseUntil: row.lease_until, attempts: row.attempts, task: await this.task(q, row.task_id) };
    });
    if (lease) this.changed();
    return lease;
  }

  async heartbeat(jobId: string, leaseToken: string, leaseMs = LEASE_MS): Promise<boolean> {
    try {
      await this.as((q) => q(`SELECT agent_job_heartbeat($1, $2, $3)`, [jobId, leaseToken, Math.round(leaseMs / 1000)]));
      return true;
    } catch {
      return false;
    }
  }

  async finishJob(_agent: AgentIdentity, jobId: string, leaseToken: string, outcome: FinishOutcome): Promise<TaskView> {
    const view = await this.as(async (q) => {
      await q(`SELECT agent_job_finish($1, $2, $3, $4, $5)`, [jobId, leaseToken, outcome.status, outcome.reason ?? null, outcome.frame ?? null]);
      const [row] = await q<{ task_id: string }>(`SELECT task_id FROM agent_jobs WHERE id = $1`, [jobId]);
      return this.task(q, row!.task_id);
    });
    this.changed();
    if (outcome.status === 'done') this.emit('taskDone', view);
    return view;
  }

  async reap(): Promise<number> {
    const [row] = await this.as((q) => q<{ n: number }>(`SELECT agent_jobs_reap($1) AS n`, [this.projectId]));
    if (row!.n) this.changed(true);
    return row!.n;
  }

  async startRun(agent: AgentIdentity, input: { intent: string; startSeq: number; jobId?: string; leaseToken?: string }): Promise<RunView> {
    const run = await this.as(async (q) => {
      const [row] = await q<{ id: string }>(`SELECT agent_run_start($1, $2, $3, $4, $5, $6) AS id`, [this.projectId, agent.agentName, input.intent, input.startSeq, input.jobId ?? null, input.leaseToken ?? null]);
      return (await this.runs(q, `id = $2`, [row!.id]))[0]!;
    });
    this.changed();
    return run;
  }

  private async runs(q: Q, where: string, params: unknown[], tail = ''): Promise<RunView[]> {
    return (await q<RunRow>(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE project_id = $1 AND ${where} ${tail}`, [this.projectId, ...params])).map(toRun);
  }

  async openRun(agent: AgentIdentity): Promise<RunView | null> {
    if (!agent.tokenId) return null;
    return this.as(async (q) => (await this.runs(q, `token_id = $2 AND status = 'running'`, [agent.tokenId]))[0] ?? null);
  }

  async endRun(_agent: AgentIdentity, runId: string, input: { endSeq: number; status: 'done' | 'failed'; summary?: string }): Promise<RunView> {
    const run = await this.as(async (q) => {
      await q(`SELECT agent_run_end($1, $2, $3, $4)`, [runId, input.status, input.endSeq, input.summary ?? null]);
      return (await this.runs(q, `id = $2`, [runId]))[0]!;
    });
    this.changed();
    return run;
  }

  async getRun(runId: string): Promise<RunView | null> {
    if (!/^[0-9a-f-]{36}$/i.test(runId)) return null;
    return this.as(async (q) => (await this.runs(q, `id = $2`, [runId]))[0] ?? null);
  }

  async listRuns(limit = 50): Promise<RunView[]> {
    return this.as((q) => this.runs(q, 'true', [Math.min(Math.max(limit, 1), 200)], 'ORDER BY no DESC LIMIT $2'));
  }

  async noteRunWrite(runId: string, writes: number): Promise<void> {
    await this.as((q) => q(`SELECT agent_run_note_write($1, $2)`, [runId, writes]));
    this.changed();
  }

  async markRunUndone(runId: string, _by: { id?: string; name: string }, report: { reverted: number; stayed: number; message: string }): Promise<RunView> {
    const run = await this.as(async (q) => {
      await q(`SELECT agent_run_mark_undone($1, $2::jsonb)`, [runId, JSON.stringify(report)]);
      return (await this.runs(q, `id = $2`, [runId]))[0]!;
    });
    this.changed();
    return run;
  }

  /** Calls per token and per organization in a rolling minute, counted in the database so every process agrees. */
  async meter(agent: AgentIdentity): Promise<string | null> {
    if (!agent.tokenId) return null;
    const [row] = await this.as((q) =>
      q<{ token: number; org: number }>(`SELECT auth_throttle_hit('mcp.token', $1, 60) AS token, auth_throttle_hit('mcp.org', $2, 60) AS org`, [sha(`token:${agent.tokenId}`), sha(`org:${this.orgId}`)]),
    );
    if (row!.token > this.limits.perTokenPerMinute) return `Slow down: this token made more than ${this.limits.perTokenPerMinute} calls in a minute. Try again shortly.`;
    if (row!.org > this.limits.perOrgPerMinute) return `This organization's agents made more than ${this.limits.perOrgPerMinute} calls in a minute. Try again shortly.`;
    return null;
  }

  async connections(): Promise<ConnectionView[]> {
    const rows = await this.as((q) =>
      q<{ token_id: string; token_name: string; owner_id: string; owner_name: string; last_used_at: number | null; expires_at: number | null; revoked_at: number | null; mine: boolean }>(
        `SELECT token_id, token_name, owner_id, owner_name, ${ms('last_used_at')} AS last_used_at, ${ms('expires_at')} AS expires_at, ${ms('revoked_at')} AS revoked_at, mine FROM project_agent_connections($1)`,
        [this.projectId],
      ),
    );
    const now = Date.now();
    return rows.map((r) => ({
      tokenId: r.token_id,
      tokenName: r.token_name,
      ownerId: r.owner_id,
      ownerName: r.owner_name,
      mine: r.mine,
      lastSeenAt: r.last_used_at,
      expiresAt: r.expires_at,
      ...connectionState({ lastUsedAt: r.last_used_at, expiresAt: r.expires_at, revokedAt: r.revoked_at, ownerName: r.owner_name }, now),
    }));
  }

  // ---------------------------------------------------------------- write-rule facts

  /** Top-level frames a change created belong to whoever made it (as that person, through their token). */
  async recordFrameOwners(entry: ChangeEntry): Promise<void> {
    const frames = entry.ops.flatMap((op) => (op.op === 'create' && !op.parent && op.node.id ? [op.node.id] : []));
    // without the operation log, entries carry no attribution: the change is published inside its request
    const who = entry.actorId ?? actor.getStore();
    const token = entry.actorId ? entry.tokenId : tokenActor.getStore();
    if (!frames.length || !who) return;
    const write = () =>
      withUser(this.db, who, (q) =>
        q(`INSERT INTO frame_owners (project_id, org_id, frame_id, owner_id) SELECT $1, $2, f, app_uid() FROM unnest($3::text[]) f ON CONFLICT DO NOTHING`, [this.projectId, this.orgId, frames]),
      );
    await (token ? tokenActor.run(token, write) : write()).catch((err: unknown) => logger.warn('could not record who made a frame', { err, projectId: this.projectId }));
  }

  async writeFacts(frames: readonly string[]): Promise<{ owners: Map<string, string>; imports: Map<string, { mode: 'protected' | 'draft'; importedBy: string | null }>; solo: boolean }> {
    return this.as(async (q) => {
      const owners = await q<{ frame_id: string; owner_id: string | null }>(`SELECT frame_id, owner_id FROM frame_owners WHERE project_id = $1 AND frame_id = ANY ($2::text[])`, [this.projectId, [...frames]]);
      const imports = await q<{ page_id: string; mode: 'protected' | 'draft'; imported_by: string | null }>(`SELECT page_id, mode, imported_by FROM page_agent_policies WHERE project_id = $1`, [this.projectId]);
      const [solo] = await q<{ solo: boolean }>(`SELECT project_is_solo($1) AS solo`, [this.projectId]);
      return {
        owners: new Map(owners.flatMap((o) => (o.owner_id ? [[o.frame_id, o.owner_id] as const] : []))),
        imports: new Map(imports.map((p) => [p.page_id, { mode: p.mode, importedBy: p.imported_by }])),
        solo: !!solo?.solo,
      };
    });
  }

  /** A person sets a page's team-import mode: Protected (agents suggest) or Draft (the importer's agent edits). */
  async setPagePolicy(pageId: string, mode: 'protected' | 'draft', importedBy: string | null): Promise<void> {
    await this.as((q) =>
      q(
        `INSERT INTO page_agent_policies (project_id, org_id, page_id, mode, imported_by, set_by) VALUES ($1, $2, $3, $4, $5, app_uid())
         ON CONFLICT (project_id, page_id) DO UPDATE SET mode = EXCLUDED.mode, imported_by = coalesce(EXCLUDED.imported_by, page_agent_policies.imported_by), set_by = app_uid(), updated_at = clock_timestamp()`,
        [this.projectId, this.orgId, pageId, mode, importedBy],
      ),
    );
  }
}

/** The reaper: expired leases everywhere, once a minute, from the one app process. */
export function startLeaseReaper(db: Database, everyMs = 60_000): () => void {
  const timer = setInterval(() => {
    void withUser(db, null, (q) => q(`SELECT agent_jobs_reap(NULL)`)).catch((err: unknown) => logger.warn('lease reaper failed', { err }));
  }, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
