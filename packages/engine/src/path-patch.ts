/**
 * Path-level patches: the normal form an edit is stored in. Writing `style.fill` no longer carries the rest of
 * `style` with it, so two people changing different properties do not overwrite each other, and a stored change
 * stays small.
 *
 * A set with no `value` key deletes. That is deliberate: JSON has no `undefined`, so anything else would lose
 * the deletion on its way through the operation log.
 */
import { isSafeKey } from './safety.js';

export interface PathSet {
  path: string[];
  /** absent: delete the key */
  value?: unknown;
}

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);

/** The reserved key in a path, or undefined. Checked on every apply, including replay of stored ops. */
export function unsafePathSegment(path: readonly string[]): string | undefined {
  return path.find((seg) => typeof seg !== 'string' || !isSafeKey(seg));
}

/**
 * Apply sets under `holder[root]` and return the sets that undo them. A set cannot reach the prototype: every
 * segment is checked here, not only where input arrives, so a tampered stored op is as harmless as a live one.
 */
export function applySets(holder: Record<string, unknown>, root: string, sets: readonly PathSet[]): PathSet[] {
  const inverse: PathSet[] = [];
  for (const { path, value } of sets) {
    const bad = unsafePathSegment(path);
    if (bad !== undefined) throw new Error(`Path uses the reserved name "${String(bad)}"`);
    const full = [root, ...path];
    let cur = holder;
    let created = -1;
    for (let i = 0; i < full.length - 1; i++) {
      const seg = full[i]!;
      const next = Object.hasOwn(cur, seg) ? cur[seg] : undefined;
      if (!isPlain(next)) {
        // everything below here is new, so undoing means putting back this one key
        if (created < 0) created = i;
        if (value === undefined) {
          cur = {};
          break;
        }
        const made: Record<string, unknown> = {};
        if (created === i) inverse.unshift(next === undefined ? { path: full.slice(1, i + 1) } : { path: full.slice(1, i + 1), value: clone(next) });
        cur[seg] = made;
        cur = made;
      } else cur = next;
    }
    if (value === undefined && created >= 0) continue; // deleting under something that is not there
    const key = full[full.length - 1]!;
    if (created < 0) {
      const had = Object.hasOwn(cur, key);
      inverse.unshift(had ? { path: path.slice(), value: clone(cur[key]) } : { path: path.slice() });
    }
    if (value === undefined) delete cur[key];
    else cur[key] = clone(value);
  }
  return inverse;
}

function diffInto(before: unknown, after: unknown, path: string[], out: PathSet[], ordered: boolean): void {
  if (isPlain(before) && isPlain(after)) {
    const beforeKeys = Object.keys(before);
    const afterKeys = Object.keys(after).filter((k) => after[k] !== undefined);
    // Where key order means something, only appending keeps it; anything else replaces the object in place.
    if (ordered && !beforeKeys.every((k, i) => afterKeys[i] === k)) {
      out.push({ path, value: clone(after) });
      return;
    }
    if (!ordered) for (const k of beforeKeys) if (!afterKeys.includes(k)) out.push({ path: [...path, k] });
    for (const k of afterKeys) {
      if (!Object.hasOwn(before, k)) out.push({ path: [...path, k], value: clone(after[k]) });
      else diffInto(before[k], after[k], [...path, k], out, ordered);
    }
    return;
  }
  if (after === undefined) {
    if (before !== undefined) out.push({ path });
  } else if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path, value: clone(after) });
  }
}

/** The sets that turn `before` into `after`. Arrays are single values. */
export function diffSets(before: unknown, after: unknown, opts: { ordered?: boolean; prefix?: string[] } = {}): PathSet[] {
  const out: PathSet[] = [];
  diffInto(before, after, opts.prefix ?? [], out, opts.ordered ?? false);
  return out;
}

/** True when one path equals the other or contains it. */
export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}
