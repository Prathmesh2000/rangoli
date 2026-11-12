/**
 * Single-key shortcuts (PRD section 16, WCAG 2.1.4 Character Key Shortcuts).
 *
 * A shortcut without Ctrl, Cmd or Alt works only while the canvas region has focus, and every one can be
 * remapped (saved per browser). Shortcuts with a modifier stay global and fixed. Arrow keys and Escape are
 * navigation, not character keys, but they also act only while the canvas has focus.
 */
import { useSyncExternalStore } from 'react';

export type Action =
  | 'tool.select' | 'tool.frame' | 'tool.rect' | 'tool.ellipse' | 'tool.line' | 'tool.pen' | 'tool.text'
  | 'add' | 'delete' | 'edit' | 'pan' | 'shortcuts';

export interface ActionDef {
  id: Action;
  label: string;
  /** default keys, as KeyboardEvent.key with letters lower-cased */
  keys: string[];
}

export const ACTIONS: readonly ActionDef[] = [
  { id: 'tool.select', label: 'Select and move tool', keys: ['v'] },
  { id: 'tool.frame', label: 'Frame tool', keys: ['f'] },
  { id: 'tool.rect', label: 'Rectangle tool', keys: ['r'] },
  { id: 'tool.ellipse', label: 'Ellipse tool', keys: ['o'] },
  { id: 'tool.line', label: 'Line tool', keys: ['l'] },
  { id: 'tool.pen', label: 'Pen tool', keys: ['p'] },
  { id: 'tool.text', label: 'Text tool', keys: ['t'] },
  { id: 'add', label: 'Open the Add panel', keys: ['a'] },
  { id: 'delete', label: 'Delete the selection', keys: ['Delete', 'Backspace'] },
  { id: 'edit', label: 'Edit text in place, or go into the selected frame', keys: ['Enter'] },
  { id: 'pan', label: 'Hold to pan with the pointer', keys: [' '] },
  { id: 'shortcuts', label: 'Show keyboard shortcuts', keys: ['?'] },
];

const STORE_KEY = 'rangoli.keys';
let custom: Partial<Record<Action, string[]>> = load();
let version = 0;
const listeners = new Set<() => void>();

function load(): Partial<Record<Action, string[]>> {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
    const out: Partial<Record<Action, string[]>> = {};
    for (const a of ACTIONS) {
      const v = raw[a.id];
      if (Array.isArray(v) && v.every((k) => typeof k === 'string' && k.length > 0 && k.length < 16)) out[a.id] = v as string[];
    }
    return out;
  } catch {
    return {};
  }
}

function save(): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(custom)); } catch { /* private mode: lasts this session */ }
  version++;
  listeners.forEach((l) => l());
}

/** The key as stored: letters lower-case, everything else as KeyboardEvent.key names it. */
export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

export function keysFor(action: Action): string[] {
  return custom[action] ?? ACTIONS.find((a) => a.id === action)!.keys;
}

/** How a key reads in a tooltip or the shortcuts list. */
export function keyLabel(key: string): string {
  if (key === ' ') return 'Space';
  return key.length === 1 ? key.toUpperCase() : key;
}

export const shortcutLabel = (action: Action): string => keysFor(action).map(keyLabel).join(' or ');

/** The action a key press asks for, when it has no Ctrl, Cmd or Alt. */
export function actionFor(e: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): Action | undefined {
  if (e.ctrlKey || e.metaKey || e.altKey) return undefined;
  const k = normalizeKey(e.key);
  return ACTIONS.find((a) => keysFor(a.id).includes(k))?.id;
}

/** Which action already uses this key (to warn before taking it). */
export function conflictFor(key: string, except: Action): Action | undefined {
  const k = normalizeKey(key);
  return ACTIONS.find((a) => a.id !== except && keysFor(a.id).includes(k))?.id;
}

/** Keys that cannot be single-key shortcuts: they move focus or belong to the browser. */
export const RESERVED_KEYS = new Set(['Tab', 'Escape', 'F6', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'F5', 'F11', 'F12']);

export function remap(action: Action, key: string): void {
  const k = normalizeKey(key);
  if (RESERVED_KEYS.has(k)) return;
  // a key does one thing: take it from whoever had it
  for (const a of ACTIONS) {
    if (a.id === action) continue;
    const ks = keysFor(a.id);
    if (ks.includes(k)) custom[a.id] = ks.filter((x) => x !== k);
  }
  custom[action] = [k];
  save();
}

/** Turn one shortcut off (WCAG 2.1.4 allows turning off as well as remapping). */
export function clearKeys(action: Action): void {
  custom[action] = [];
  save();
}

export function resetKeys(): void {
  custom = {};
  save();
}

export function useKeymap(): number {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => version);
}

/** The editor regions F6 cycles through, in order. */
export const REGION_ATTR = 'data-region';

/** Move focus to the next (or previous) region that is on screen. */
export function cycleRegion(back: boolean): void {
  const regions = [...document.querySelectorAll<HTMLElement>(`[${REGION_ATTR}]`)].filter((r) => r.offsetParent !== null || r === document.activeElement);
  if (!regions.length) return;
  const active = document.activeElement;
  let i = regions.findIndex((r) => r === active || r.contains(active));
  i = i < 0 ? (back ? regions.length - 1 : 0) : (i + (back ? regions.length - 1 : 1)) % regions.length;
  const r = regions[i]!;
  if (r.tabIndex < 0 && !r.hasAttribute('tabindex')) r.tabIndex = -1;
  r.focus();
}

/** True while focus is inside the canvas region: the only place single-key shortcuts act. */
export function canvasHasFocus(): boolean {
  const a = document.activeElement;
  return !!a && !!a.closest?.('[data-region="canvas"]');
}

/** The element a key event really came from, through shadow roots (in-place text editing lives in one). */
export function keyTarget(e: Event): HTMLElement | null {
  const t = e.composedPath?.()[0] ?? e.target;
  return t instanceof HTMLElement ? t : null;
}

export function isTypingTarget(e: Event): boolean {
  const t = keyTarget(e);
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}
