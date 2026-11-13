/**
 * Notes, tasks, job leases and named runs for one project (PRD §11, design direction "Notes and tasks").
 *
 * People leave notes and tasks. Rangoli cannot start an agent, so an item waits, honestly, until a connected
 * agent asks for work: `agent_wait` waits a bounded time, `job_claim` leases the oldest waiting item, the
 * agent works inside a named run, and `job_finish` closes it. A lease that is not renewed runs out and is
 * reaped: an item nobody started goes back to waiting, a run that stopped answering becomes Could not complete.
 *
 * This is a port with two adapters: `LocalAgentPlatform` here (one process, kept in a file beside the
 * document) and the Postgres one in app/agents/platform-db.ts, where leases are claimed with
 * `FOR UPDATE SKIP LOCKED` so two agents never share a job.
 */
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createNoteTask, NOTE_TASK_STATUS_LABELS, transitionNoteTask, type NoteTask, type NoteTaskActor, type NoteTaskKind, type NoteTaskStatus, type NoteTaskTarget } from '@rangoli/engine';

/** How long a claim lasts without a write or heartbeat (ARCHITECTURE §4: 5 minutes). */
export const LEASE_MS = 5 * 60 * 1000;
/** A lease runs out this many times before its item is given up as Could not complete. */
export const MAX_ATTEMPTS = 3;
/** agent_wait never holds a call longer than this (ARCHITECTURE §4: 25 s). */
export const MAX_WAIT_MS = 25 * 1000;

/** Who is asking: the authorizing person, their token, and the name the agent goes by. */
export interface AgentIdentity {
  agentName: string;
  userId?: string;
  tokenId?: string;
}

export interface TaskView {
  id: string;
  kind: NoteTaskKind;
  status: NoteTaskStatus;
  statusLabel: string;
  target: NoteTaskTarget;
  authorId: string | null;
  authorName: string;
  /** a request from a person allowed to make one (task.create): the only text an agent treats as instructions */
  body: string;
  createdAt: number;
  agent?: string;
  pickedUpAt?: number;
  runId?: string;
  runNo?: number;
  lastWriteAt?: number;
  failureReason?: string;
  /** the planned screen this builds, in the team app */
  screen?: { id: string; name: string };
  asset?: string;
  device?: 'desktop' | 'tablet' | 'mobile';
  frame?: string;
}

export type RunStatus = 'running' | 'done' | 'failed' | 'undone';

export interface RunView {
  id: string;
  /** per project: "Run 31" */
  no: number;
  agentName: string;
  tokenId: string | null;
  authorizedBy: string | null;
  authorizedByName?: string | null;
  intent: string;
  taskId: string | null;
  jobId: string | null;
  status: RunStatus;
  startSeq: number;
  endSeq: number | null;
  startedAt: number;
  endedAt: number | null;
  lastWriteAt: number | null;
  writes: number;
  summary: string | null;
  undoneBy: string | null;
  undoReport: { reverted: number; stayed: number; message: string } | null;
}

export interface JobLease {
  jobId: string;
  /** fences a late writer: only the holder of this token may heartbeat or finish */
  leaseToken: string;
  leaseUntil: number;
  attempts: number;
  task: TaskView;
}

export interface NewTask {
  kind: NoteTaskKind;
  body: string;
  target?: NoteTaskTarget;
  authorId?: string | null;
  authorName: string;
  screen?: { id: string; name: string };
  asset?: string;
  device?: 'desktop' | 'tablet' | 'mobile';
}

export interface FinishOutcome {
  status: 'done' | 'failed';
  reason?: string;
  frame?: string;
}

export interface UsageLimits {
  /** tool calls per token per minute */
  perTokenPerMinute: number;
  /** tool calls per organization (all its tokens) per minute */
  perOrgPerMinute: number;
  /** changes in one run */
  runChanges: number;
  /** characters in one RDL script */
  scriptChars: number;
}

export const DEFAULT_LIMITS: UsageLimits = {
  perTokenPerMinute: Number(process.env.RANGOLI_AGENT_TOKEN_RPM) || 240,
  perOrgPerMinute: Number(process.env.RANGOLI_AGENT_ORG_RPM) || 1200,
  runChanges: Number(process.env.RANGOLI_AGENT_RUN_CHANGES) || 2000,
  scriptChars: Number(process.env.RANGOLI_AGENT_SCRIPT_CHARS) || 200_000,
};

/** What an editor needs to show a project's agent connection: one row per person's token. */
export interface ConnectionView {
  tokenId: string;
  tokenName: string;
  ownerId: string;
  ownerName: string;
  mine: boolean;
  state: 'connected' | 'not_connected' | 'token_expired';
  /** the words the interface shows */
  label: string;
  lastSeenAt: number | null;
  expiresAt: number | null;
}

/** Connected means the token was used in the last five minutes; anything older is "last seen". */
export const CONNECTED_WITHIN_MS = 5 * 60 * 1000;

export function connectionState(row: { lastUsedAt: number | null; expiresAt: number | null; revokedAt: number | null; ownerName: string }, now = Date.now()): Pick<ConnectionView, 'state' | 'label'> {
  if (row.revokedAt !== null || (row.expiresAt !== null && row.expiresAt <= now)) return { state: 'token_expired', label: 'Token expired' };
  if (row.lastUsedAt !== null && now - row.lastUsedAt < CONNECTED_WITHIN_MS) return { state: 'connected', label: `Connected, with ${row.ownerName}'s token` };
  if (row.lastUsedAt !== null) return { state: 'not_connected', label: `Not connected, last seen ${ago(now - row.lastUsedAt)}` };
  return { state: 'not_connected', label: 'Not connected' };
}

/** "3s ago", "12m ago": what Rangoli knows, never a guess at what the agent is doing. */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export interface AgentPlatformEvents {
  /** something changed in the queue or a run: open editors refresh */
  changed: [];
  /** a new item is waiting: wakes agent_wait */
  queued: [];
  /** a task with a planned screen finished with a frame */
  taskDone: [TaskView];
}

export interface AgentPlatform extends EventEmitter<AgentPlatformEvents> {
  readonly kind: 'local' | 'hosted';
  readonly limits: UsageLimits;

  // people
  createTask(input: NewTask): Promise<TaskView>;
  listTasks(): Promise<TaskView[]>;
  /** Could not complete goes back to waiting; a person's action */
  requeueTask(id: string, person: { id?: string; name: string }): Promise<TaskView>;
  /** a waiting item its author takes back before any agent picks it up */
  withdrawTask(id: string): Promise<void>;

  // the queue
  waitingCount(): Promise<number>;
  claimJob(agent: AgentIdentity, leaseMs?: number): Promise<JobLease | null>;
  heartbeat(jobId: string, leaseToken: string, leaseMs?: number): Promise<boolean>;
  finishJob(agent: AgentIdentity, jobId: string, leaseToken: string, outcome: FinishOutcome): Promise<TaskView>;
  /** expire stale leases; returns how many were reaped */
  reap(): Promise<number>;

  // runs
  startRun(agent: AgentIdentity, input: { intent: string; startSeq: number; jobId?: string; leaseToken?: string }): Promise<RunView>;
  /** the run this agent has open on this project, if any; one at a time per token */
  openRun(agent: AgentIdentity): Promise<RunView | null>;
  endRun(agent: AgentIdentity, runId: string, input: { endSeq: number; status: 'done' | 'failed'; summary?: string }): Promise<RunView>;
  getRun(runId: string): Promise<RunView | null>;
  listRuns(limit?: number): Promise<RunView[]>;
  noteRunWrite(runId: string, writes: number): Promise<void>;
  /** a person undid the whole run */
  markRunUndone(runId: string, by: { id?: string; name: string }, report: { reverted: number; stayed: number; message: string }): Promise<RunView>;

  // use
  /** a refusal when the caller is over its quota, else null; counts the call */
  meter(agent: AgentIdentity): Promise<string | null>;
  connections(viewer?: string): Promise<ConnectionView[]>;
}

// ---------------------------------------------------------------------------------------------------------------
// The local adapter: one process, the machine owner's document

interface LocalJob {
  id: string;
  taskId: string;
  status: 'waiting' | 'leased' | 'done' | 'failed';
  leaseToken: string | null;
  leaseUntil: number | null;
  attempts: number;
  agentName: string | null;
  createdAt: number;
}

interface LocalTask {
  item: NoteTask;
  authorId: string | null;
  authorName: string;
  screen?: { id: string; name: string };
  asset?: string;
  device?: 'desktop' | 'tablet' | 'mobile';
  frame?: string;
  runNo?: number;
}

interface LocalState {
  tasks: LocalTask[];
  jobs: LocalJob[];
  runs: RunView[];
  nextRun: number;
}

const AGENT = (name: string): NoteTaskActor => ({ kind: 'agent', name });
const SYSTEM: NoteTaskActor = { kind: 'system' };

export class LocalAgentPlatform extends EventEmitter<AgentPlatformEvents> implements AgentPlatform {
  readonly kind = 'local' as const;
  private state: LocalState = { tasks: [], jobs: [], runs: [], nextRun: 1 };
  private readonly file: string | undefined;
  private saving: Promise<void> = Promise.resolve();
  private readonly calls = new Map<string, number[]>();

  constructor(location = '', readonly limits: UsageLimits = DEFAULT_LIMITS, private readonly now: () => number = Date.now) {
    super();
    this.file = location ? join(location, 'agents.json') : undefined;
    if (this.file && existsSync(this.file)) {
      try {
        this.state = { ...this.state, ...(JSON.parse(readFileSync(this.file, 'utf8')) as Partial<LocalState>) };
      } catch {
        // a damaged file starts an empty queue; the design itself is untouched
      }
    }
  }

  private persist(): void {
    this.emit('changed');
    if (!this.file) return;
    const file = this.file;
    const json = JSON.stringify(this.state, null, 2) + '\n';
    this.saving = this.saving.then(() => writeFile(file, json)).catch(() => undefined);
  }

  /** Resolves once the queue is written to disk. */
  flush(): Promise<void> {
    return this.saving;
  }

  private view(t: LocalTask): TaskView {
    const run = t.item.runId ? this.state.runs.find((r) => r.id === t.item.runId) : undefined;
    return {
      id: t.item.id,
      kind: t.item.kind,
      status: t.item.status,
      statusLabel: NOTE_TASK_STATUS_LABELS[t.item.status],
      target: t.item.target,
      authorId: t.authorId,
      authorName: t.authorName,
      body: t.item.body,
      createdAt: t.item.createdAt,
      ...(t.item.agent ? { agent: t.item.agent } : {}),
      ...(t.item.pickedUpAt ? { pickedUpAt: t.item.pickedUpAt } : {}),
      ...(t.item.runId ? { runId: t.item.runId, runNo: run?.no } : {}),
      ...(run?.lastWriteAt ? { lastWriteAt: run.lastWriteAt } : {}),
      ...(t.item.failureReason ? { failureReason: t.item.failureReason } : {}),
      ...(t.screen ? { screen: t.screen } : {}),
      ...(t.asset ? { asset: t.asset } : {}),
      ...(t.device ? { device: t.device } : {}),
      ...(t.frame ? { frame: t.frame } : {}),
    };
  }

  private task(id: string): LocalTask {
    const t = this.state.tasks.find((x) => x.item.id === id);
    if (!t) throw new Error(`Note or task ${id} not found`);
    return t;
  }

  async createTask(input: NewTask): Promise<TaskView> {
    const item = createNoteTask({ id: `task_${randomUUID().slice(0, 8)}`, kind: input.kind, author: input.authorName, body: input.body.slice(0, 8000), target: input.target, at: this.now() });
    const t: LocalTask = { item, authorId: input.authorId ?? null, authorName: input.authorName, screen: input.screen, asset: input.asset, device: input.device };
    this.state.tasks.push(t);
    this.state.jobs.push({ id: `job_${randomUUID().slice(0, 8)}`, taskId: item.id, status: 'waiting', leaseToken: null, leaseUntil: null, attempts: 0, agentName: null, createdAt: this.now() });
    this.persist();
    this.emit('queued');
    return this.view(t);
  }

  async listTasks(): Promise<TaskView[]> {
    await this.reap();
    return this.state.tasks.map((t) => this.view(t));
  }

  async requeueTask(id: string): Promise<TaskView> {
    const t = this.task(id);
    t.item = transitionNoteTask(t.item, { type: 'requeue', actor: { kind: 'person', id: 'owner' }, at: this.now() });
    const job = this.state.jobs.find((j) => j.taskId === id);
    if (job) Object.assign(job, { status: 'waiting', leaseToken: null, leaseUntil: null, attempts: 0, agentName: null });
    this.persist();
    this.emit('queued');
    return this.view(t);
  }

  async withdrawTask(id: string): Promise<void> {
    const t = this.task(id);
    if (t.item.status !== 'waiting_for_agent') throw new Error('An agent has already picked this up; it can no longer be withdrawn.');
    this.state.tasks = this.state.tasks.filter((x) => x !== t);
    this.state.jobs = this.state.jobs.filter((j) => j.taskId !== id);
    this.persist();
  }

  async waitingCount(): Promise<number> {
    await this.reap();
    return this.state.jobs.filter((j) => j.status === 'waiting').length;
  }

  async claimJob(agent: AgentIdentity, leaseMs = LEASE_MS): Promise<JobLease | null> {
    await this.reap();
    // one process, one event loop: taking the first waiting job is already exclusive
    const job = this.state.jobs.filter((j) => j.status === 'waiting').sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!job) return null;
    const t = this.task(job.taskId);
    t.item = transitionNoteTask(t.item, { type: 'pick_up', actor: AGENT(agent.agentName), at: this.now() });
    Object.assign(job, { status: 'leased', leaseToken: randomUUID(), leaseUntil: this.now() + leaseMs, attempts: job.attempts + 1, agentName: agent.agentName });
    this.persist();
    return { jobId: job.id, leaseToken: job.leaseToken!, leaseUntil: job.leaseUntil!, attempts: job.attempts, task: this.view(t) };
  }

  private heldJob(jobId: string, leaseToken: string): LocalJob {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job) throw new Error(`Job ${jobId} not found`);
    if (job.status !== 'leased' || job.leaseToken !== leaseToken) throw new Error('This job is no longer yours: its lease ran out or it was finished. Claim the next one with job_claim.');
    return job;
  }

  async heartbeat(jobId: string, leaseToken: string, leaseMs = LEASE_MS): Promise<boolean> {
    const job = this.state.jobs.find((j) => j.id === jobId);
    if (!job || job.status !== 'leased' || job.leaseToken !== leaseToken) return false;
    job.leaseUntil = this.now() + leaseMs;
    return true;
  }

  async finishJob(agent: AgentIdentity, jobId: string, leaseToken: string, outcome: FinishOutcome): Promise<TaskView> {
    await this.reap();
    const job = this.heldJob(jobId, leaseToken);
    const t = this.task(job.taskId);
    const at = this.now();
    const open = this.state.runs.find((r) => r.id === t.item.runId && r.status === 'running');
    if (outcome.status === 'done') {
      if (!t.item.runId) throw new Error('Finish needs a run: call run_start with this job before job_finish, so a person can review and undo the work.');
      if (open) Object.assign(open, { status: 'done', endedAt: at });
      t.item = transitionNoteTask(t.item, { type: 'finish', actor: AGENT(agent.agentName), at, runId: t.item.runId });
    } else {
      if (open) Object.assign(open, { status: 'failed', endedAt: at });
      t.item = transitionNoteTask(t.item, { type: 'fail', actor: AGENT(agent.agentName), at, reason: outcome.reason?.trim() || 'The agent did not say why.' });
    }
    if (outcome.frame) t.frame = outcome.frame;
    Object.assign(job, { status: outcome.status === 'done' ? 'done' : 'failed', leaseToken: null, leaseUntil: null });
    this.persist();
    const view = this.view(t);
    if (outcome.status === 'done') this.emit('taskDone', view);
    return view;
  }

  async reap(): Promise<number> {
    const now = this.now();
    let reaped = 0;
    for (const job of this.state.jobs) {
      if (job.status !== 'leased' || (job.leaseUntil ?? 0) > now) continue;
      reaped++;
      const t = this.task(job.taskId);
      const run = this.state.runs.find((r) => r.id === t.item.runId && r.status === 'running');
      if (t.item.status === 'run_in_progress' || job.attempts >= MAX_ATTEMPTS) {
        if (run) Object.assign(run, { status: 'failed', endedAt: now, summary: run.summary ?? 'The lease ran out before the run ended.' });
        t.item = transitionNoteTask(t.item, { type: 'fail', actor: SYSTEM, at: now, reason: t.item.status === 'run_in_progress' ? `${t.item.agent ?? 'The agent'} stopped answering: its lease ran out during the run.` : `Picked up ${job.attempts} times without starting.` });
        Object.assign(job, { status: 'failed', leaseToken: null, leaseUntil: null });
      } else {
        t.item = transitionNoteTask(t.item, { type: 'release', actor: SYSTEM, at: now });
        Object.assign(job, { status: 'waiting', leaseToken: null, leaseUntil: null, agentName: null });
      }
    }
    if (reaped) {
      this.persist();
      this.emit('queued');
    }
    return reaped;
  }

  private agentKey(agent: AgentIdentity): string {
    return agent.tokenId ?? "local";
  }

  async startRun(agent: AgentIdentity, input: { intent: string; startSeq: number; jobId?: string; leaseToken?: string }): Promise<RunView> {
    if (await this.openRun(agent)) throw new Error('A run is already open for this agent. End it with run_end before starting another.');
    let task: LocalTask | undefined;
    if (input.jobId) {
      const job = this.heldJob(input.jobId, input.leaseToken ?? '');
      task = this.task(job.taskId);
    }
    const run: RunView = {
      id: randomUUID(),
      no: this.state.nextRun++,
      agentName: agent.agentName,
      tokenId: agent.tokenId ?? null,
      authorizedBy: agent.userId ?? null,
      intent: input.intent.slice(0, 500),
      taskId: task?.item.id ?? null,
      jobId: input.jobId ?? null,
      status: 'running',
      startSeq: input.startSeq,
      endSeq: null,
      startedAt: this.now(),
      endedAt: null,
      lastWriteAt: null,
      writes: 0,
      summary: null,
      undoneBy: null,
      undoReport: null,
    };
    (run as RunView & { key: string }).key = this.agentKey(agent);
    if (task) task.item = transitionNoteTask(task.item, { type: 'start_run', actor: AGENT(task.item.agent ?? agent.agentName), at: run.startedAt, runId: run.id });
    this.state.runs.push(run);
    this.persist();
    return run;
  }

  async openRun(agent: AgentIdentity): Promise<RunView | null> {
    const key = this.agentKey(agent);
    return this.state.runs.find((r) => r.status === 'running' && (r as RunView & { key?: string }).key === key) ?? null;
  }

  async endRun(agent: AgentIdentity, runId: string, input: { endSeq: number; status: 'done' | 'failed'; summary?: string }): Promise<RunView> {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run || (run as RunView & { key?: string }).key !== this.agentKey(agent)) throw new Error(`Run ${runId} is not yours to end`);
    if (run.status !== 'running') throw new Error(`Run ${run.no} has already ended (${run.status})`);
    Object.assign(run, { status: input.status, endSeq: input.endSeq, endedAt: this.now(), summary: input.summary?.slice(0, 2000) ?? null });
    this.persist();
    return run;
  }

  async getRun(runId: string): Promise<RunView | null> {
    return this.state.runs.find((r) => r.id === runId) ?? null;
  }

  async listRuns(limit = 50): Promise<RunView[]> {
    return [...this.state.runs].reverse().slice(0, limit);
  }

  async noteRunWrite(runId: string, writes: number): Promise<void> {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) return;
    run.writes += writes;
    run.lastWriteAt = this.now();
    // a write in a run is a heartbeat for the job it serves
    const job = run.jobId ? this.state.jobs.find((j) => j.id === run.jobId && j.status === 'leased') : undefined;
    if (job) job.leaseUntil = this.now() + LEASE_MS;
    this.persist();
  }

  async markRunUndone(runId: string, by: { id?: string; name: string }, report: { reverted: number; stayed: number; message: string }): Promise<RunView> {
    const run = this.state.runs.find((r) => r.id === runId);
    if (!run) throw new Error(`Run ${runId} not found`);
    if (run.status === 'running') throw new Error(`Run ${run.no} is still open. Refuse further writes first, or wait for the agent to end it.`);
    if (run.status === 'undone') throw new Error(`Run ${run.no} was already undone`);
    Object.assign(run, { status: 'undone', undoneBy: by.name, undoReport: report });
    this.persist();
    return run;
  }

  async meter(agent: AgentIdentity): Promise<string | null> {
    const key = this.agentKey(agent);
    const now = this.now();
    const recent = (this.calls.get(key) ?? []).filter((t) => now - t < 60_000);
    recent.push(now);
    this.calls.set(key, recent);
    return recent.length > this.limits.perTokenPerMinute ? `Slow down: this agent made more than ${this.limits.perTokenPerMinute} calls in a minute. Try again shortly.` : null;
  }

  async connections(): Promise<ConnectionView[]> {
    return [];
  }
}

/** The person-facing sentence for an item's status: only what Rangoli knows. */
export function statusSentence(task: TaskView, now = Date.now()): string {
  switch (task.status) {
    case 'waiting_for_agent':
      return 'Waiting for agent. Rangoli can’t make it start.';
    case 'picked_up':
      return `Picked up by ${task.agent ?? 'an agent'}${task.pickedUpAt ? ` ${ago(now - task.pickedUpAt)}` : ''}`;
    case 'run_in_progress':
      return `Run ${task.runNo ?? ''} in progress${task.lastWriteAt ? `, last write ${ago(now - task.lastWriteAt)}` : ', no writes yet'}`.replace('Run  ', 'Run ');
    case 'done_ready_to_review':
      return 'Done, ready to review. Nothing is approved.';
    case 'could_not_complete':
      return `Could not complete: ${task.failureReason ?? 'no reason given'}`;
  }
}
