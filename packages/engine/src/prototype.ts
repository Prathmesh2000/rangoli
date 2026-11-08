/**
 * Prototype interactions + timelines (SPEC §9–10, Phase 4).
 *
 *   proto #n7
 *     click navigate #np dissolve
 *     click overlay #nx dissolve fast
 *     hover swap variant=secondary
 *     delay:2000 navigate #n1 slide left base out
 *     click play timeline:success
 *   proto start #n1
 *
 *   timeline success 900ms
 *     #ny 0 opacity:0, y:sm base out
 *     #nz 150 scale:popIn base spring:snappy
 */
import type { Diagnostic } from './rdl.js';
import { parseMotionLines, resolveTiming, type MotionSpec } from './motion.js';
import { TokenResolver } from './tokens.js';
import type { TokenTree } from './model.js';

export type ProtoTrigger = 'click' | 'hover' | 'press' | 'delay' | 'key';
export type ProtoAction = 'navigate' | 'overlay' | 'close' | 'back' | 'swap' | 'play';
export type TransitionType = 'instant' | 'dissolve' | 'slide' | 'push' | 'smart';

export interface ProtoTransition {
  type: TransitionType;
  direction?: 'left' | 'right' | 'up' | 'down';
  duration: string;
  easing: string;
}

export interface Interaction {
  trigger: ProtoTrigger;
  delay?: number;
  key?: string;
  action: ProtoAction;
  target?: string;
  variant?: Record<string, string>;
  timeline?: string;
  transition: ProtoTransition;
}

export interface PrototypeData {
  start?: string;
  interactions: Record<string, Interaction[]>;
}

export interface TimelineTrack {
  target: string;
  at: number;
  spec: MotionSpec;
}

export interface Timeline {
  name: string;
  tracks: TimelineTrack[];
}

const TRIGGERS: ProtoTrigger[] = ['click', 'hover', 'press', 'delay', 'key'];
const ACTIONS: ProtoAction[] = ['navigate', 'overlay', 'close', 'back', 'swap', 'play'];
const TRANSITIONS: TransitionType[] = ['instant', 'dissolve', 'slide', 'push', 'smart'];

// ---------------------------------------------------------------- parsing

export function parseProtoLines(lines: { no: number; toks: string[] }[], diag: Diagnostic[]): Interaction[] {
  const out: Interaction[] = [];
  for (const { no, toks } of lines) {
    const err = (message: string) => diag.push({ line: no, severity: 'error', message });
    const [trigTok, actionTok, ...rest] = toks;
    let m: RegExpExecArray | null;
    const it: Interaction = { trigger: 'click', action: 'navigate', transition: { type: 'dissolve', duration: 'base', easing: 'out' } };
    if ((m = /^delay:(\d+)(?:ms)?$/.exec(trigTok ?? ''))) { it.trigger = 'delay'; it.delay = Number(m[1]); }
    else if ((m = /^key:(.+)$/.exec(trigTok ?? ''))) { it.trigger = 'key'; it.key = m[1]; }
    else if (TRIGGERS.includes(trigTok as ProtoTrigger)) it.trigger = trigTok as ProtoTrigger;
    else { err(`Unknown trigger "${trigTok}". Use: click, hover, press, delay:<ms>, key:<Key>`); continue; }
    if (!ACTIONS.includes(actionTok as ProtoAction)) { err(`Unknown action "${actionTok ?? ''}". Use: ${ACTIONS.join(', ')}`); continue; }
    it.action = actionTok as ProtoAction;
    if (it.action === 'close' || it.action === 'back') it.transition.type = 'dissolve';
    if (it.action === 'swap') it.transition = { type: 'smart', duration: 'fast', easing: 'out' };
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i]!;
      if (t.startsWith('#')) { it.target = t.slice(1); continue; }
      if ((m = /^timeline:([\w-]+)$/.exec(t))) { it.timeline = m[1]; continue; }
      if ((m = /^([\w-]+)=(.+)$/.exec(t))) { (it.variant ??= {})[m[1]!] = m[2]!; continue; }
      if (TRANSITIONS.includes(t as TransitionType)) {
        it.transition.type = t as TransitionType;
        const dir = rest[i + 1];
        if (dir === 'left' || dir === 'right' || dir === 'up' || dir === 'down') { it.transition.direction = dir; i++; }
        continue;
      }
      if (/^(instant|fast|base|slow|panel)$/.test(t) || /^\d+ms$/.test(t)) { it.transition.duration = t; continue; }
      if (/^(out|in|inOut|drawer|linear)$/.test(t) || /^spring:[\w-]+$/.test(t)) { it.transition.easing = t; continue; }
      err(`Unexpected "${t}" in interaction`);
    }
    if ((it.action === 'navigate' || it.action === 'overlay') && !it.target) err(`${it.action} needs a target frame: ${it.action} #frameId`);
    if (it.action === 'swap' && !it.variant) err('swap needs a variant, e.g. swap variant=secondary');
    if (it.action === 'play' && !it.timeline) err('play needs a timeline, e.g. play timeline:success');
    if ((it.transition.type === 'slide' || it.transition.type === 'push') && !it.transition.direction) it.transition.direction = 'left';
    out.push(it);
  }
  return out;
}

export function parseTimelineLines(lines: { no: number; toks: string[] }[], diag: Diagnostic[]): TimelineTrack[] {
  const tracks: TimelineTrack[] = [];
  for (const { no, toks } of lines) {
    const [target, at, ...rest] = toks;
    if (!target?.startsWith('#') || !/^\d+(ms)?$/.test(at ?? '')) {
      diag.push({ line: no, severity: 'error', message: 'timeline track: #id <startMs> <prop:value>[, …] <duration> <easing>   e.g. #n7 150 opacity:0, y:sm base out' });
      continue;
    }
    const specs = parseMotionLines([{ no, toks: ['enter', ...rest] }], diag);
    if (specs[0]) tracks.push({ target: target.slice(1), at: parseInt(at!, 10), spec: specs[0] });
  }
  return tracks;
}

// ---------------------------------------------------------------- serialize

function interactionLine(it: Interaction): string {
  const trig = it.trigger === 'delay' ? `delay:${it.delay}` : it.trigger === 'key' ? `key:${it.key}` : it.trigger;
  const parts = [trig, it.action];
  if (it.target) parts.push(`#${it.target}`);
  for (const [k, v] of Object.entries(it.variant ?? {})) parts.push(`${k}=${v}`);
  if (it.timeline) parts.push(`timeline:${it.timeline}`);
  if (it.action !== 'play') {
    parts.push(it.transition.type + (it.transition.direction ? ` ${it.transition.direction}` : ''));
    parts.push(it.transition.duration, it.transition.easing);
  }
  return parts.join(' ');
}

export function serializePrototype(p: PrototypeData | undefined, timelines: Record<string, Timeline> | undefined, nodes?: string[]): string {
  // timelines first: interactions may "play" them, and RDL resolves names in order
  const out: string[] = [];
  for (const tl of Object.values(timelines ?? {})) {
    if (nodes && !tl.tracks.some((t) => nodes.includes(t.target))) continue;
    out.push(`timeline ${tl.name}`);
    for (const t of tl.tracks) {
      const s = t.spec;
      const tracks = s.tracks.map((x) => (x.from !== undefined && x.to !== undefined ? `${x.prop}:${x.from}→${x.to}` : `${x.prop}:${x.from ?? x.to}`));
      out.push(`  #${t.target} ${t.at} ${tracks.join(', ')} ${s.duration} ${s.easing}`);
    }
  }
  if (p?.start && !nodes) out.push(`proto start #${p.start}`);
  for (const [node, list] of Object.entries(p?.interactions ?? {})) {
    if (nodes && !nodes.includes(node)) continue;
    out.push(`proto #${node}`, ...list.map((i) => `  ${interactionLine(i)}`));
  }
  return out.join('\n');
}

/** Total length of a timeline in ms (last track end). */
export function timelineDuration(tl: Timeline, tokenTree: TokenTree): number {
  const tokens = new TokenResolver(tokenTree);
  return Math.max(0, ...tl.tracks.map((t) => t.at + resolveTiming(t.spec, tokens).ms));
}
