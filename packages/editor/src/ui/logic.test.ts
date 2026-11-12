import { describe, expect, it } from 'vitest';
import { agentStatusCopy, AVATAR_TINTS, avatarTint, canLeave, composerCopy, formatAgo, initials, isLeaveChord, moveIndex, place, possessive, splitOverflow, STAGES, taskStatusCopy, toastDismissMs, typeaheadIndex, type TaskState } from './logic';

describe('names', () => {
  it('derives initials as the mockups show them', () => {
    expect(initials('Lena Fischer')).toBe('LF');
    expect(initials('Claude Code')).toBe('CC');
    expect(initials('Cursor')).toBe('Cu');
    expect(initials('  ')).toBe('?');
    expect(initials('Asha Priya Menon')).toBe('AM');
  });

  it('keeps combining marks with their letter', () => {
    expect(initials('कृष्णा राव')).toBe('कृरा');
  });

  it('gives a name one stable, allowed tint', () => {
    expect(avatarTint('Asha Menon')).toBe(avatarTint(' asha menon '));
    for (const n of ['A', 'Bo', 'Priya Rao', 'Lena Fischer', 'Daniel Cho']) expect(AVATAR_TINTS).toContain(avatarTint(n));
    expect(AVATAR_TINTS).toEqual(['plum', 'slate', 'clay']);
  });

  it('forms the possessive used in token copy', () => expect(possessive('Asha')).toBe("Asha's"));
});

describe('splitOverflow', () => {
  it('splits at the limit and always shows one', () => {
    expect(splitOverflow([1, 2, 3], 2)).toEqual({ shown: [1, 2], hidden: [3] });
    expect(splitOverflow([1, 2], 5)).toEqual({ shown: [1, 2], hidden: [] });
    expect(splitOverflow([1, 2], 0)).toEqual({ shown: [1], hidden: [2] });
  });
});

describe('formatAgo', () => {
  it.each([[3, '3s ago'], [59, '59s ago'], [60, '1m ago'], [720, '12m ago'], [7200, '2h ago'], [172800, '2d ago'], [-5, '0s ago'], [NaN, '0s ago']])('%d is %s', (s, out) => expect(formatAgo(s)).toBe(out));
});

describe('moveIndex', () => {
  it('moves and wraps', () => {
    expect(moveIndex('ArrowDown', 0, 3)).toBe(1);
    expect(moveIndex('ArrowUp', 0, 3)).toBe(2);
    expect(moveIndex('ArrowRight', 2, 3)).toBe(0);
  });

  it('skips disabled items in both directions, and at the ends', () => {
    const isDisabled = (i: number) => i === 1 || i === 0;
    expect(moveIndex('ArrowDown', 2, 4, { isDisabled })).toBe(3);
    expect(moveIndex('ArrowDown', 3, 4, { isDisabled })).toBe(2);
    expect(moveIndex('Home', 3, 4, { isDisabled })).toBe(2);
    expect(moveIndex('End', 0, 4, { isDisabled: (i) => i === 3 })).toBe(2);
  });

  it('ignores the wrong axis and other keys', () => {
    expect(moveIndex('ArrowLeft', 1, 3, { orientation: 'vertical' })).toBeNull();
    expect(moveIndex('ArrowUp', 1, 3, { orientation: 'horizontal' })).toBeNull();
    expect(moveIndex('a', 1, 3)).toBeNull();
  });

  it('returns null with nothing to focus', () => {
    expect(moveIndex('ArrowDown', 0, 0)).toBeNull();
    expect(moveIndex('Home', 0, 2, { isDisabled: () => true })).toBeNull();
  });
});

describe('typeaheadIndex', () => {
  const labels = ['Mark reviewed', 'Refuse further writes', 'Rerun', 'Undo whole run'];
  it('finds the next match after the current item and wraps', () => {
    expect(typeaheadIndex('r', labels, 0)).toBe(1);
    expect(typeaheadIndex('R', labels, 1)).toBe(2);
    expect(typeaheadIndex('r', labels, 2)).toBe(1);
  });
  it('skips disabled items and reports no match', () => {
    expect(typeaheadIndex('r', labels, 0, (i) => i === 1)).toBe(2);
    expect(typeaheadIndex('z', labels, 0)).toBeNull();
  });
});

describe('place', () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 200, height: 100 };
  it('sits below the anchor by default', () => {
    expect(place({ left: 100, top: 100, width: 50, height: 20 }, size, viewport)).toEqual({ left: 100, top: 124, side: 'below' });
  });
  it('flips above when there is no room below', () => {
    expect(place({ left: 100, top: 760, width: 50, height: 20 }, size, viewport)).toMatchObject({ top: 656, side: 'above' });
  });
  it('flips below when above is preferred but there is no room', () => {
    expect(place({ left: 100, top: 10, width: 50, height: 20 }, size, viewport, { prefer: 'above' }).side).toBe('below');
  });
  it('stays inside the viewport', () => {
    expect(place({ left: 950, top: 100, width: 40, height: 20 }, size, viewport).left).toBe(792);
    expect(place({ left: -40, top: 100, width: 40, height: 20 }, size, viewport).left).toBe(8);
  });
  it('aligns to the end and centre', () => {
    expect(place({ left: 400, top: 100, width: 100, height: 20 }, size, viewport, { align: 'end' }).left).toBe(300);
    expect(place({ left: 400, top: 100, width: 100, height: 20 }, size, viewport, { align: 'center' }).left).toBe(350);
  });
});

describe('Ctrl+Enter and leaving', () => {
  it('needs the modifier', () => {
    expect(isLeaveChord({ key: 'Enter', ctrlKey: true, metaKey: false })).toBe(true);
    expect(isLeaveChord({ key: 'Enter', ctrlKey: false, metaKey: true })).toBe(true);
    expect(isLeaveChord({ key: 'Enter', ctrlKey: false, metaKey: false })).toBe(false);
    expect(isLeaveChord({ key: 'a', ctrlKey: true, metaKey: false })).toBe(false);
  });
  it('refuses blank text and a second send while busy', () => {
    expect(canLeave('   ')).toBe(false);
    expect(canLeave('Fix it')).toBe(true);
    expect(canLeave('Fix it', true)).toBe(false);
  });
});

describe('toastDismissMs', () => {
  it('keeps failures and toasts with actions', () => {
    expect(toastDismissMs('fail', false)).toBeNull();
    expect(toastDismissMs('neutral', true)).toBeNull();
    expect(toastDismissMs('neutral', false)).toBe(6000);
  });
});

const TASKS: TaskState[] = [
  { status: 'waiting' },
  { status: 'picked-up', agentName: 'Claude Code', at: '14:41' },
  { status: 'running', run: 31, secondsSinceWrite: 3 },
  { status: 'done', run: 29 },
];

describe('agent copy', () => {
  it('states each connection', () => {
    expect(agentStatusCopy('Claude Code', { state: 'connected', tokenOwner: 'Asha' })).toEqual({ name: 'Claude Code', state: 'connected', title: 'Claude Code connected', detail: "Asha's token, this project only" });
    expect(agentStatusCopy(undefined, { state: 'not-connected' })).toMatchObject({ state: 'Not connected', title: 'Not connected' });
    expect(agentStatusCopy('Cursor', { state: 'last-seen', tokenOwner: 'Priya', lastSeen: '18:11 yesterday' }).detail).toBe("Not connected. Priya's token, seen 18:11 yesterday");
    expect(agentStatusCopy('Cursor', { state: 'token-expired', tokenOwner: 'Priya' })).toMatchObject({ name: 'Cursor', state: 'token expired', detail: "Token expired. Priya's token" });
    expect(agentStatusCopy(undefined, { state: 'token-expired' })).toMatchObject({ state: 'Token expired' });
  });
});

describe('task copy', () => {
  it('uses the four direction.md statuses', () => {
    expect(TASKS.map((t) => taskStatusCopy(t).label)).toEqual(['Waiting for agent', 'Picked up', 'Run in progress', 'Done, ready to review']);
  });
  it('shows waiting with no timer or estimate', () => expect(taskStatusCopy({ status: 'waiting' }).meta).toBeUndefined());
  it('names who picked it up and when', () => expect(taskStatusCopy(TASKS[1]!).meta).toBe('Claude Code, 14:41'));
  it('reports silence as a last write', () => {
    expect(taskStatusCopy({ status: 'running', run: 31, secondsSinceWrite: 720 }).meta).toBe('Run 31, last write 12m ago');
  });
});

describe('composer copy', () => {
  it('says plainly that Rangoli cannot start an agent, in every state', () => {
    for (const c of [composerCopy('task', 'Claude Code'), composerCopy('task'), composerCopy('note', 'Claude Code')]) expect(c.hint).toContain("Rangoli can't make it start.");
  });
  it('matches the mockup when an agent is connected', () => {
    expect(composerCopy('task', 'Claude Code').hint).toBe("Shows as Waiting for agent until one picks it up. Claude Code is connected, but Rangoli can't make it start.");
  });
  it('labels the action by kind', () => {
    expect(composerCopy('task').leave).toBe('Leave task');
    expect(composerCopy('note').leave).toBe('Leave note');
  });
});

describe('nothing reads as a conversation or a guess', () => {
  const copy = [
    ...TASKS.flatMap((t) => Object.values(taskStatusCopy(t))),
    ...(['note', 'task'] as const).flatMap((k) => Object.values(composerCopy(k, 'Claude Code'))),
    ...Object.values(agentStatusCopy('Cursor', { state: 'last-seen', tokenOwner: 'Priya', lastSeen: '18:11 yesterday' })),
    ...Object.values(agentStatusCopy('Cursor', { state: 'connected', tokenOwner: 'Priya' })),
  ];
  it.each(copy.map((c) => [c]))('%s', (text) => {
    expect(text).not.toMatch(/\b(prompt|chat|reply|replies|message|ask|send|thinking|typing|working|soon|estimate)\b/i);
  });
});

describe('stages', () => {
  it('lists the ten stages', () => expect(STAGES).toHaveLength(10));
});
