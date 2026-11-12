/**
 * Attempt limits kept in the database, so every app process shares them and a restart does not reset them.
 * Keys are hashed before they leave this file: the table never holds an email or an address.
 */
import { createHash } from 'node:crypto';
import type { As } from '../http/context.js';
import { HttpError } from '../http/errors.js';
import type { Limit, LimitName } from './config.js';

/** A rule and the value it limits: an email, an address key, a user id, or '*' for everyone at once. */
export type Hit = [LimitName, string];

const keyOf = (value: string) => createHash('sha256').update(value).digest('hex');
const bucketOf = (name: LimitName) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export const tooMany = (minutes: number) => new HttpError(429, `Too many attempts. Try again in ${minutes} minutes.`);

export interface Throttle {
  /** Counts these hits and says whether any rule is now over its limit. Atomic per rule. */
  hit(hits: Hit[]): Promise<boolean>;
  /** Whether any rule is already at its limit, without counting this attempt. */
  blocked(hits: Hit[]): Promise<boolean>;
  clear(hits: Hit[]): Promise<void>;
  /** The longest window among these rules, in minutes, for the message. */
  minutes(hits: Hit[]): number;
}

export function createThrottle(as: As, limits: Record<LimitName, Limit>): Throttle {
  let calls = 0;
  return {
    hit: (hits) =>
      as(null, async (q) => {
        // now and then, drop windows that ended long ago
        if (++calls % 200 === 0) await q('SELECT auth_throttle_sweep()');
        let over = false;
        for (const [name, value] of hits) {
          const l = limits[name];
          const [row] = await q<{ n: number }>('SELECT auth_throttle_hit($1, $2, $3) AS n', [bucketOf(name), keyOf(value), l.windowSec]);
          if ((row?.n ?? 0) > l.max) over = true;
        }
        return over;
      }),
    blocked: (hits) =>
      as(null, async (q) => {
        for (const [name, value] of hits) {
          const [row] = await q<{ n: number }>('SELECT auth_throttle_count($1, $2) AS n', [bucketOf(name), keyOf(value)]);
          if ((row?.n ?? 0) >= limits[name].max) return true;
        }
        return false;
      }),
    clear: (hits) =>
      as(null, async (q) => {
        for (const [name, value] of hits) await q('SELECT auth_throttle_clear($1, $2)', [bucketOf(name), keyOf(value)]);
      }),
    minutes: (hits) => Math.ceil(Math.max(...hits.map(([n]) => limits[n].windowSec)) / 60),
  };
}
