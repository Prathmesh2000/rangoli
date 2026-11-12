/** Pure logic and copy for the UI kit. No React or DOM, so it can be tested without a browser. */

export const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/** The ten stages. Stages are views: none of them can lock. */
export const STAGES = ['Discovery', 'Define', 'IA & Flow', 'Wireframes', 'Visual', 'Prototype', 'Testing', 'Handoff', 'Release', 'Live'] as const;
export type StageName = (typeof STAGES)[number];

/* ---------- Names and avatars ---------- */

const graphemes = (s: string) => Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(s), (g) => g.segment);

/** "Lena Fischer" is LF, "Claude Code" is CC, "Cursor" is Cu. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0];
  if (!first) return '?';
  const last = words[words.length - 1]!;
  if (words.length > 1) return `${graphemes(first)[0]!}${graphemes(last)[0]!}`.toUpperCase();
  const [a = '', b = ''] = graphemes(first);
  return a.toUpperCase() + b;
}

/** Avatar tints are plum, slate and clay, never marigold or teal: those colours carry meaning. */
export const AVATAR_TINTS = ['plum', 'slate', 'clay'] as const;
export type AvatarTint = (typeof AVATAR_TINTS)[number];

/** The same name always gets the same tint. */
export function avatarTint(name: string): AvatarTint {
  let hash = 0;
  for (const ch of name.trim().toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  return AVATAR_TINTS[hash % AVATAR_TINTS.length]!;
}

export const possessive = (name: string) => `${name}'s`;

export function splitOverflow<T>(items: readonly T[], max: number): { shown: T[]; hidden: T[] } {
  const limit = Math.max(1, Math.floor(max));
  return { shown: items.slice(0, limit), hidden: items.slice(limit) };
}

/** "3s ago", "12m ago". Used for last write; never as an estimate of what comes next. */
export function formatAgo(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ---------- Keyboard ---------- */

export type Orientation = 'horizontal' | 'vertical' | 'both';

const STEP: Record<string, { step: 1 | -1; axis: 'horizontal' | 'vertical' }> = {
  ArrowRight: { step: 1, axis: 'horizontal' },
  ArrowLeft: { step: -1, axis: 'horizontal' },
  ArrowDown: { step: 1, axis: 'vertical' },
  ArrowUp: { step: -1, axis: 'vertical' },
};

/** Where a navigation key moves focus: wraps, skips disabled items. Null if the key does not navigate. */
export function moveIndex(key: string, current: number, count: number, opts: { orientation?: Orientation; isDisabled?: (i: number) => boolean } = {}): number | null {
  const { orientation = 'both', isDisabled = () => false } = opts;
  if (count <= 0) return null;
  const scan = (start: number, step: 1 | -1) => {
    for (let n = 0, i = start; n < count; n++, i = (i + step + count) % count) if (!isDisabled(i)) return i;
    return null;
  };
  if (key === 'Home') return scan(0, 1);
  if (key === 'End') return scan(count - 1, -1);
  const move = STEP[key];
  if (!move || (orientation !== 'both' && orientation !== move.axis)) return null;
  return scan((current + move.step + count) % count, move.step);
}

/** Next item after `from` whose label starts with the typed character. */
export function typeaheadIndex(char: string, labels: readonly string[], from: number, isDisabled: (i: number) => boolean = () => false): number | null {
  const wanted = char.toLowerCase();
  for (let n = 1; n <= labels.length; n++) {
    const i = (from + n) % labels.length;
    if (!isDisabled(i) && labels[i]!.trim().toLowerCase().startsWith(wanted)) return i;
  }
  return null;
}

/** Ctrl+Enter leaves a note or task. Cmd+Enter does the same on a Mac. */
export const isLeaveChord = (e: { key: string; ctrlKey: boolean; metaKey: boolean }) => e.key === 'Enter' && (e.ctrlKey || e.metaKey);

/* ---------- Placement ---------- */

export interface Size { width: number; height: number }
export interface Rect extends Size { left: number; top: number }

export function place(anchor: Rect, size: Size, viewport: Size, opts: { align?: 'start' | 'center' | 'end'; prefer?: 'below' | 'above'; gap?: number; margin?: number } = {}): { left: number; top: number; side: 'below' | 'above' } {
  const { align = 'start', prefer = 'below', gap = 4, margin = 8 } = opts;
  const roomBelow = viewport.height - (anchor.top + anchor.height) - gap - margin;
  const roomAbove = anchor.top - gap - margin;
  const [first, firstRoom, secondRoom] = prefer === 'below' ? ['below' as const, roomBelow, roomAbove] : ['above' as const, roomAbove, roomBelow];
  const side = firstRoom >= size.height || firstRoom >= secondRoom ? first : first === 'below' ? 'above' : 'below';
  const rawTop = side === 'below' ? anchor.top + anchor.height + gap : anchor.top - gap - size.height;
  const rawLeft = align === 'start' ? anchor.left : align === 'end' ? anchor.left + anchor.width - size.width : anchor.left + (anchor.width - size.width) / 2;
  const clamp = (v: number, room: number, length: number) => Math.max(margin, Math.min(v, Math.max(margin, room - length - margin)));
  return { left: clamp(rawLeft, viewport.width, size.width), top: clamp(rawTop, viewport.height, size.height), side };
}

/* ---------- Toasts ---------- */

/** Failures and toasts with an action stay until dismissed; anything else clears itself. */
export const toastDismissMs = (tone: 'neutral' | 'fail', hasAction: boolean): number | null => (tone === 'fail' || hasAction ? null : 6000);

/* ---------- Honest copy. Rangoli says only what it can know. ---------- */

export type AgentConnection =
  | { state: 'not-connected' }
  | { state: 'connected'; tokenOwner: string }
  | { state: 'last-seen'; tokenOwner: string; lastSeen: string }
  | { state: 'token-expired'; tokenOwner?: string };

export interface AgentStatusCopy {
  /** Agent name for the top-bar form, if one is known. */
  name?: string;
  /** State wording for the top-bar form. */
  state: string;
  /** First line of the panel form. */
  title: string;
  /** Second line of the panel form. */
  detail: string;
}

export function agentStatusCopy(agentName: string | undefined, c: AgentConnection): AgentStatusCopy {
  const name = agentName;
  const lead = (state: string) => (name ? { name, state: state.toLowerCase() } : { state });
  switch (c.state) {
    case 'connected':
      return { ...lead('Connected'), title: `${name ?? 'Agent'} connected`, detail: `${possessive(c.tokenOwner)} token, this project only` };
    case 'not-connected':
      return { ...lead('Not connected'), title: name ?? 'Not connected', detail: name ? 'Not connected' : 'No agent has connected yet' };
    case 'last-seen':
      return { ...lead('Not connected'), title: name ?? 'Not connected', detail: `Not connected. ${possessive(c.tokenOwner)} token, seen ${c.lastSeen}` };
    case 'token-expired':
      return { ...lead('Token expired'), title: name ?? 'Token expired', detail: c.tokenOwner ? `Token expired. ${possessive(c.tokenOwner)} token` : 'Token expired' };
  }
}

/**
 * A task's state. Waiting takes no time on purpose: it shows no timer or estimate.
 * Running reports the last write, never "working".
 */
export type TaskState =
  | { status: 'waiting' }
  | { status: 'picked-up'; agentName: string; at: string }
  | { status: 'running'; run: number; secondsSinceWrite: number }
  | { status: 'done'; run: number };

export function taskStatusCopy(t: TaskState): { label: string; meta?: string } {
  switch (t.status) {
    case 'waiting': return { label: 'Waiting for agent' };
    case 'picked-up': return { label: 'Picked up', meta: `${t.agentName}, ${t.at}` };
    case 'running': return { label: 'Run in progress', meta: `Run ${t.run}, last write ${formatAgo(t.secondsSinceWrite)}` };
    case 'done': return { label: 'Done, ready to review', meta: `Run ${t.run}` };
  }
}

export const AGENT_DRAFTED = 'Agent drafted, not reviewed';

export type EntryKind = 'note' | 'task';

export function composerCopy(kind: EntryKind, connectedAgent?: string | null) {
  const cannotStart = connectedAgent ? `${connectedAgent} is connected, but Rangoli can't make it start.` : "No agent is connected, and Rangoli can't make it start.";
  return kind === 'task'
    ? { hint: `Shows as Waiting for agent until one picks it up. ${cannotStart}`, leave: 'Leave task', field: 'Task', placeholder: 'Describe the work' }
    : { hint: "Pins here as context, visible when an agent collects the queue. Rangoli can't make it start.", leave: 'Leave note', field: 'Note', placeholder: 'Add context' };
}

export const canLeave = (text: string, busy = false) => !busy && text.trim().length > 0;
