/**
 * Agent notes and tasks (PRD §11, design direction "Notes and tasks").
 *
 * People leave notes and tasks. Connected agents collect them through MCP and work as named runs.
 * Rangoli cannot start an agent, so nothing but an agent can move an item out of waiting, and a
 * finished run approves nothing. Whether the author may leave a request (`task.create`) is checked
 * by the caller; see capabilities.ts.
 */
import { RangoliError } from './document.js';

export const NOTE_TASK_STATUSES = ['waiting_for_agent', 'picked_up', 'run_in_progress', 'done_ready_to_review', 'could_not_complete'] as const;
export type NoteTaskStatus = (typeof NOTE_TASK_STATUSES)[number];

export const NOTE_TASK_STATUS_LABELS: Record<NoteTaskStatus, string> = {
  waiting_for_agent: 'Waiting for agent',
  picked_up: 'Picked up',
  run_in_progress: 'Run in progress',
  done_ready_to_review: 'Done, ready to review',
  could_not_complete: 'Could not complete',
};

export type NoteTaskKind = 'note' | 'task';

export type NoteTaskActor = { kind: 'person'; id: string } | { kind: 'agent'; name: string } | { kind: 'system' };

export interface NoteTaskTarget {
  page?: string;
  /** frame or layer the note is pinned to */
  node?: string;
}

export type NoteTaskEvent =
  | { type: 'pick_up'; actor: NoteTaskActor; at: number }
  | { type: 'start_run'; actor: NoteTaskActor; at: number; runId: string }
  | { type: 'finish'; actor: NoteTaskActor; at: number; runId: string }
  | { type: 'fail'; actor: NoteTaskActor; at: number; reason: string }
  /** the agent let go, or its lease ran out, before any run began */
  | { type: 'release'; actor: NoteTaskActor; at: number }
  /** a person puts failed work back in the queue */
  | { type: 'requeue'; actor: NoteTaskActor; at: number };

export type NoteTaskEventType = NoteTaskEvent['type'];

export interface NoteTaskHistoryEntry {
  from: NoteTaskStatus;
  to: NoteTaskStatus;
  event: NoteTaskEventType;
  actor: NoteTaskActor;
  at: number;
}

export interface NoteTask {
  id: string;
  kind: NoteTaskKind;
  author: string;
  body: string;
  target: NoteTaskTarget;
  status: NoteTaskStatus;
  createdAt: number;
  /** the named agent holding the item; cleared when it goes back to waiting */
  agent?: string;
  pickedUpAt?: number;
  runId?: string;
  failureReason?: string;
  history: NoteTaskHistoryEntry[];
}

export interface NewNoteTask {
  id: string;
  kind: NoteTaskKind;
  author: string;
  body: string;
  target?: NoteTaskTarget;
  at: number;
}

const TRANSITIONS: Record<NoteTaskStatus, Partial<Record<NoteTaskEventType, NoteTaskStatus>>> = {
  waiting_for_agent: { pick_up: 'picked_up' },
  picked_up: { start_run: 'run_in_progress', fail: 'could_not_complete', release: 'waiting_for_agent' },
  run_in_progress: { finish: 'done_ready_to_review', fail: 'could_not_complete' },
  done_ready_to_review: {},
  could_not_complete: { requeue: 'waiting_for_agent' },
};

const ALLOWED_ACTORS: Record<NoteTaskEventType, readonly NoteTaskActor['kind'][]> = {
  pick_up: ['agent'],
  start_run: ['agent'],
  finish: ['agent'],
  fail: ['agent', 'system'],
  release: ['agent', 'system'],
  requeue: ['person'],
};

/** The status an event leads to, or undefined when the event is not allowed from `status`. */
export function nextNoteTaskStatus(status: NoteTaskStatus, event: NoteTaskEventType): NoteTaskStatus | undefined {
  return TRANSITIONS[status]?.[event];
}

export function canTransitionNoteTask(status: NoteTaskStatus, event: NoteTaskEventType): boolean {
  return nextNoteTaskStatus(status, event) !== undefined;
}

export function createNoteTask(input: NewNoteTask): NoteTask {
  if (input.kind !== 'note' && input.kind !== 'task') throw new RangoliError('INVALID_NOTE_TASK', `Unknown kind "${String(input.kind)}"`);
  if (!input.author.trim()) throw new RangoliError('INVALID_NOTE_TASK', 'A note or task needs an author');
  if (!input.body.trim()) throw new RangoliError('INVALID_NOTE_TASK', 'A note or task needs a body');
  if (input.kind === 'note' && !input.target?.node) throw new RangoliError('INVALID_NOTE_TASK', 'A note must be pinned to a frame or layer');
  return {
    id: input.id,
    kind: input.kind,
    author: input.author,
    body: input.body,
    target: { ...input.target },
    status: 'waiting_for_agent',
    createdAt: input.at,
    history: [],
  };
}

function requireActor(item: NoteTask, event: NoteTaskEvent): void {
  if (!ALLOWED_ACTORS[event.type].includes(event.actor.kind)) {
    throw new RangoliError('INVALID_ACTOR', `A ${event.actor.kind} cannot ${event.type} item ${item.id}`);
  }
  // A lease reaper acts as the system; only the agent's own actions are tied to its claim.
  if (event.type !== 'pick_up' && event.actor.kind === 'agent' && event.actor.name !== item.agent) {
    throw new RangoliError('NOT_CLAIM_HOLDER', `${event.actor.name} does not hold item ${item.id}`);
  }
}

/** Returns the updated item and leaves the original untouched. Invalid events throw. */
export function transitionNoteTask(item: NoteTask, event: NoteTaskEvent): NoteTask {
  const to = nextNoteTaskStatus(item.status, event.type);
  if (!to) {
    throw new RangoliError('INVALID_TRANSITION', `Cannot ${event.type} an item that is ${NOTE_TASK_STATUS_LABELS[item.status]}`);
  }
  requireActor(item, event);

  const next: NoteTask = {
    ...item,
    target: { ...item.target },
    status: to,
    history: [...item.history, { from: item.status, to, event: event.type, actor: event.actor, at: event.at }],
  };

  switch (event.type) {
    case 'pick_up':
      next.agent = (event.actor as { name: string }).name;
      next.pickedUpAt = event.at;
      break;
    case 'start_run':
      if (!event.runId.trim()) throw new RangoliError('INVALID_NOTE_TASK', 'A run needs an id');
      next.runId = event.runId;
      break;
    case 'finish':
      if (event.runId !== item.runId) throw new RangoliError('RUN_MISMATCH', `Run ${event.runId} is not the run on item ${item.id}`);
      break;
    case 'fail':
      if (!event.reason.trim()) throw new RangoliError('INVALID_NOTE_TASK', 'Could not complete needs a reason');
      next.failureReason = event.reason;
      break;
    case 'release':
    case 'requeue':
      delete next.agent;
      delete next.pickedUpAt;
      delete next.runId;
      delete next.failureReason;
      break;
  }
  return next;
}
