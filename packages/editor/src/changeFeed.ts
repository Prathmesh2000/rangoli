/**
 * What each document version changed, so the canvas can render only that (retained.ts).
 * The store records every version bump: the change's touched ids, or null when it replaced the document
 * wholesale (first load, refetch, page load). Several versions can land between two paints; the canvas asks
 * for the union since the version it last drew, and gets null when any step in between is unknown.
 */
interface Entry { version: number; touched: readonly string[] | null }

const LIMIT = 256;
const log: Entry[] = [];

export function recordChange(version: number, touched: readonly string[] | null): void {
  log.push({ version, touched });
  if (log.length > LIMIT) log.splice(0, log.length - LIMIT);
}

/** Union of touched ids for versions (from, to], or null when the range is not fully known. */
export function touchedBetween(from: number, to: number): Set<string> | null {
  if (to <= from) return new Set();
  const out = new Set<string>();
  let expect = from + 1;
  for (const e of log) {
    if (e.version <= from || e.version > to) continue;
    if (e.version !== expect || e.touched === null) return null;
    for (const t of e.touched) out.add(t);
    expect++;
  }
  return expect === to + 1 ? out : null;
}
