/**
 * One server per document. The running server records itself in a lock file (in the OS temp dir,
 * never in the user's repo). `rangoli mcp` finds it and bridges stdio → HTTP instead of opening
 * the document a second time (two writers would overwrite each other).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface LockInfo {
  pid: number;
  url: string;
  dir: string;
  startedAt: number;
}

export function lockPath(dir: string): string {
  const h = createHash('sha1').update(resolve(dir).toLowerCase()).digest('hex').slice(0, 16);
  return join(tmpdir(), `rangoli-${h}.json`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Returns the live server for this document, verifying it actually answers. */
export async function findRunning(dir: string): Promise<LockInfo | null> {
  const file = lockPath(dir);
  if (!existsSync(file)) return null;
  try {
    const info = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
    if (!alive(info.pid)) throw new Error('stale');
    const r = await fetch(`${info.url}api/doc`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok) throw new Error('not answering');
    return info;
  } catch {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
    return null;
  }
}

export function writeLock(dir: string, url: string): () => void {
  const file = lockPath(dir);
  writeFileSync(file, JSON.stringify({ pid: process.pid, url, dir: resolve(dir), startedAt: Date.now() } satisfies LockInfo));
  const release = () => {
    try {
      const cur = JSON.parse(readFileSync(file, 'utf8')) as LockInfo;
      if (cur.pid === process.pid) unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
  process.once('exit', release);
  return release;
}
