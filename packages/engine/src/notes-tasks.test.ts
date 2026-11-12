import { describe, expect, it } from 'vitest';
import { RangoliError } from './document.js';
import {
  canTransitionNoteTask,
  createNoteTask,
  NOTE_TASK_STATUS_LABELS,
  NOTE_TASK_STATUSES,
  nextNoteTaskStatus,
  transitionNoteTask,
  type NoteTask,
  type NoteTaskActor,
  type NoteTaskEvent,
  type NoteTaskEventType,
  type NoteTaskStatus,
} from './notes-tasks.js';

const claude: NoteTaskActor = { kind: 'agent', name: 'Claude Code' };
const cursor: NoteTaskActor = { kind: 'agent', name: 'Cursor' };
const lena: NoteTaskActor = { kind: 'person', id: 'lena' };
const system: NoteTaskActor = { kind: 'system' };

const newItem = () => createNoteTask({ id: 't1', kind: 'task', author: 'lena', body: 'Tighten the header', at: 1 });

function eventFor(type: NoteTaskEventType, actor?: NoteTaskActor): NoteTaskEvent {
  switch (type) {
    case 'pick_up':
      return { type, actor: actor ?? claude, at: 2 };
    case 'start_run':
      return { type, actor: actor ?? claude, at: 3, runId: 'run-31' };
    case 'finish':
      return { type, actor: actor ?? claude, at: 4, runId: 'run-31' };
    case 'fail':
      return { type, actor: actor ?? claude, at: 4, reason: 'Page was protected' };
    case 'release':
      return { type, actor: actor ?? claude, at: 4 };
    case 'requeue':
      return { type, actor: actor ?? lena, at: 5 };
  }
}

const PATHS: Record<NoteTaskStatus, NoteTaskEventType[]> = {
  waiting_for_agent: [],
  picked_up: ['pick_up'],
  run_in_progress: ['pick_up', 'start_run'],
  done_ready_to_review: ['pick_up', 'start_run', 'finish'],
  could_not_complete: ['pick_up', 'start_run', 'fail'],
};

const itemIn = (status: NoteTaskStatus): NoteTask => PATHS[status].reduce((item, type) => transitionNoteTask(item, eventFor(type)), newItem());

const ALLOWED: Record<NoteTaskStatus, Partial<Record<NoteTaskEventType, NoteTaskStatus>>> = {
  waiting_for_agent: { pick_up: 'picked_up' },
  picked_up: { start_run: 'run_in_progress', fail: 'could_not_complete', release: 'waiting_for_agent' },
  run_in_progress: { finish: 'done_ready_to_review', fail: 'could_not_complete' },
  done_ready_to_review: {},
  could_not_complete: { requeue: 'waiting_for_agent' },
};

const EVENTS: NoteTaskEventType[] = ['pick_up', 'start_run', 'finish', 'fail', 'release', 'requeue'];

function errorCode(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(RangoliError);
    return (err as RangoliError).code;
  }
  return undefined;
}

describe('creating', () => {
  it('starts waiting, with nothing claimed', () => {
    const item = newItem();
    expect(item.status).toBe('waiting_for_agent');
    expect(item.agent).toBeUndefined();
    expect(item.history).toEqual([]);
  });

  it('uses the wording from the PRD', () => {
    expect(NOTE_TASK_STATUSES.map((status) => NOTE_TASK_STATUS_LABELS[status])).toEqual(['Waiting for agent', 'Picked up', 'Run in progress', 'Done, ready to review', 'Could not complete']);
  });

  it('pins a note to a frame or layer', () => {
    expect(errorCode(() => createNoteTask({ id: 'n', kind: 'note', author: 'lena', body: 'Why?', at: 1 }))).toBe('INVALID_NOTE_TASK');
    expect(createNoteTask({ id: 'n', kind: 'note', author: 'lena', body: 'Why?', target: { page: 'p1', node: 'n7' }, at: 1 }).target.node).toBe('n7');
  });

  it('allows a task for the whole project', () => {
    expect(newItem().target).toEqual({});
  });

  it.each([['', 'body'], ['lena', '   ']])('rejects author "%s" with body "%s"', (author, body) => {
    expect(errorCode(() => createNoteTask({ id: 'x', kind: 'task', author, body, at: 1 }))).toBe('INVALID_NOTE_TASK');
  });
});

describe('every status and event pair', () => {
  for (const status of NOTE_TASK_STATUSES) {
    for (const event of EVENTS) {
      const to = ALLOWED[status][event];
      it(`${status} + ${event} ${to ? `goes to ${to}` : 'is rejected'}`, () => {
        expect(nextNoteTaskStatus(status, event)).toBe(to);
        expect(canTransitionNoteTask(status, event)).toBe(to !== undefined);
        const item = itemIn(status);
        const actor = event === 'requeue' ? lena : claude;
        if (to) expect(transitionNoteTask(item, eventFor(event, actor)).status).toBe(to);
        else expect(errorCode(() => transitionNoteTask(item, eventFor(event, actor)))).toBe('INVALID_TRANSITION');
      });
    }
  }
});

describe('who can move an item', () => {
  it('lets only an agent pick up, because Rangoli cannot start one', () => {
    for (const actor of [lena, system]) expect(errorCode(() => transitionNoteTask(newItem(), eventFor('pick_up', actor)))).toBe('INVALID_ACTOR');
  });

  it('keeps a person from finishing or starting a run on the agent\'s behalf', () => {
    expect(errorCode(() => transitionNoteTask(itemIn('picked_up'), eventFor('start_run', lena)))).toBe('INVALID_ACTOR');
    expect(errorCode(() => transitionNoteTask(itemIn('run_in_progress'), eventFor('finish', lena)))).toBe('INVALID_ACTOR');
  });

  it('holds the claim for the agent that picked it up', () => {
    expect(errorCode(() => transitionNoteTask(itemIn('picked_up'), eventFor('start_run', cursor)))).toBe('NOT_CLAIM_HOLDER');
    expect(errorCode(() => transitionNoteTask(itemIn('run_in_progress'), eventFor('finish', cursor)))).toBe('NOT_CLAIM_HOLDER');
    expect(errorCode(() => transitionNoteTask(itemIn('run_in_progress'), eventFor('fail', cursor)))).toBe('NOT_CLAIM_HOLDER');
  });

  it('lets the system return an expired pickup or close a dead run', () => {
    expect(transitionNoteTask(itemIn('picked_up'), eventFor('release', system)).status).toBe('waiting_for_agent');
    expect(transitionNoteTask(itemIn('run_in_progress'), eventFor('fail', system)).status).toBe('could_not_complete');
  });

  it('lets only a person requeue failed work', () => {
    expect(errorCode(() => transitionNoteTask(itemIn('could_not_complete'), eventFor('requeue', claude)))).toBe('INVALID_ACTOR');
    expect(errorCode(() => transitionNoteTask(itemIn('could_not_complete'), eventFor('requeue', system)))).toBe('INVALID_ACTOR');
  });
});

describe('recorded facts', () => {
  it('records the agent, time and run', () => {
    const item = itemIn('run_in_progress');
    expect(item).toMatchObject({ agent: 'Claude Code', pickedUpAt: 2, runId: 'run-31' });
  });

  it('refuses to finish a different run', () => {
    expect(errorCode(() => transitionNoteTask(itemIn('run_in_progress'), { type: 'finish', actor: claude, at: 4, runId: 'run-9' }))).toBe('RUN_MISMATCH');
  });

  it('needs a run id and a failure reason', () => {
    expect(errorCode(() => transitionNoteTask(itemIn('picked_up'), { type: 'start_run', actor: claude, at: 3, runId: ' ' }))).toBe('INVALID_NOTE_TASK');
    expect(errorCode(() => transitionNoteTask(itemIn('picked_up'), { type: 'fail', actor: claude, at: 3, reason: '' }))).toBe('INVALID_NOTE_TASK');
  });

  it('clears the claim when work returns to the queue', () => {
    const released = transitionNoteTask(itemIn('picked_up'), eventFor('release'));
    expect(released.agent).toBeUndefined();
    expect(released.pickedUpAt).toBeUndefined();
    const requeued = transitionNoteTask(itemIn('could_not_complete'), eventFor('requeue'));
    expect(requeued).not.toHaveProperty('failureReason');
    expect(requeued).not.toHaveProperty('runId');
  });

  it('never changes the item it was given', () => {
    const item = itemIn('picked_up');
    const before = structuredClone(item);
    transitionNoteTask(item, eventFor('start_run'));
    expect(item).toEqual(before);
  });
});

describe('random walks', () => {
  it('only ever follows the table, and history stays a connected chain', () => {
    let state = 12345;
    const random = (limit: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state >>> 8) % limit;
    };
    for (let run = 0; run < 300; run++) {
      let item = newItem();
      for (let step = 0; step < 30; step++) {
        const type = EVENTS[random(EVENTS.length)]!;
        const expected = ALLOWED[item.status][type];
        const event = eventFor(type, type === 'requeue' ? lena : claude);
        if (expected) {
          item = transitionNoteTask(item, event);
          expect(item.status).toBe(expected);
        } else {
          expect(() => transitionNoteTask(item, event)).toThrow(RangoliError);
        }
      }
      item.history.forEach((entry, i) => {
        expect(entry.from).toBe(i === 0 ? 'waiting_for_agent' : item.history[i - 1]!.to);
      });
      if (item.history.length) expect(item.status).toBe(item.history[item.history.length - 1]!.to);
    }
  });
});
