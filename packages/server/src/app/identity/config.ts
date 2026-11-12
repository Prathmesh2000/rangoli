/**
 * Identity settings, resolved once at start. Hosted production refuses to start on anything only fit for a
 * laptop: no MFA encryption key, or mail that only reaches the server log (which would put live reset and
 * verification links in the logs).
 */
import { createHash } from 'node:crypto';
import { logger } from '../../telemetry/log.js';
import type { Mailer } from '../infra.js';
import { secretBox, type SecretBox } from './secret-box.js';

export interface Limit {
  max: number;
  windowSec: number;
}

/** Throttle rules. Login, MFA and reset count failures; signup and reset requests count every attempt. */
export const DEFAULT_LIMITS = {
  loginEmail: { max: 10, windowSec: 15 * 60 },
  loginIp: { max: 50, windowSec: 15 * 60 },
  loginGlobal: { max: 5000, windowSec: 15 * 60 },
  signupIp: { max: 30, windowSec: 60 * 60 },
  signupGlobal: { max: 1000, windowSec: 60 * 60 },
  resetEmail: { max: 5, windowSec: 60 * 60 },
  resetIp: { max: 20, windowSec: 60 * 60 },
  resetGlobal: { max: 1000, windowSec: 60 * 60 },
  mfaUser: { max: 10, windowSec: 15 * 60 },
  mfaIp: { max: 50, windowSec: 15 * 60 },
  verifyUser: { max: 5, windowSec: 60 * 60 },
} satisfies Record<string, Limit>;
export type LimitName = keyof typeof DEFAULT_LIMITS;

export interface IdentityOptions {
  /** hosted production: strict about keys and mail. Default: NODE_ENV=production on a Postgres server */
  hosted?: boolean;
  /** RANGOLI_MFA_KEY: 32 bytes as hex or base64, or a passphrase of 32+ characters */
  mfaKey?: string;
  /** RANGOLI_MFA_KEY_PREVIOUS: still decrypts, never encrypts (key rotation) */
  mfaPreviousKey?: string;
  /** RANGOLI_TRUSTED_PROXIES: proxies in front of the app that append to x-forwarded-for */
  trustedProxies?: number;
  limits?: Partial<Record<LimitName, Limit>>;
}

export interface IdentityConfig {
  hosted: boolean;
  /** cookies are Secure and __Host- prefixed */
  secureCookies: boolean;
  box: SecretBox;
  trustedProxies: number;
  limits: Record<LimitName, Limit>;
}

export const SESSION_DAYS = 14;
export const SESSION_IDLE_SECONDS = 24 * 60 * 60;
export const STEP_UP_MS = 5 * 60 * 1000;
export const MFA_CHALLENGE_SECONDS = 5 * 60;
export const VERIFY_HOURS = 48;
export const TOKEN_DEFAULT_DAYS = 90;

/** Only ever acceptable where the database is on the same disk as the key: embedded and local use. */
const LOCAL_DEFAULT_KEY = createHash('sha256').update('rangoli local MFA key: not for hosted use').digest();

/** Accepts 32 raw bytes as hex or base64, or derives them from a long passphrase. */
export function parseKey(value: string, name = 'RANGOLI_MFA_KEY'): Buffer {
  const v = value.trim();
  if (/^[0-9a-f]{64}$/i.test(v)) return Buffer.from(v, 'hex');
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) {
    const b = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b;
  }
  if (v.length >= 32) return createHash('sha256').update(v).digest();
  throw new Error(`${name} is too short: use 32 random bytes as hex or base64 (for example: openssl rand -hex 32).`);
}

type Env = Record<string, string | undefined>;

export function resolveIdentityConfig(opts: IdentityOptions & { driver: 'pglite' | 'postgres'; mail: Mailer; publicUrl?: string }, env: Env = process.env): IdentityConfig {
  const hosted = opts.hosted ?? (env.NODE_ENV === 'production' && opts.driver === 'postgres');
  const keyText = opts.mfaKey ?? env.RANGOLI_MFA_KEY;
  const previousText = opts.mfaPreviousKey ?? env.RANGOLI_MFA_KEY_PREVIOUS;
  if (hosted && !keyText) throw new Error('RANGOLI_MFA_KEY is not set. A hosted deployment needs its own key to encrypt MFA secrets (openssl rand -hex 32).');
  if (hosted && !opts.mail.delivers) throw new Error('No mail sender is configured (set SES_FROM). A hosted deployment cannot write password reset and verification links to its logs.');
  const key = keyText ? parseKey(keyText) : LOCAL_DEFAULT_KEY;
  if (hosted && key.equals(LOCAL_DEFAULT_KEY)) throw new Error('RANGOLI_MFA_KEY is the local default key. Use a key of your own.');
  if (!keyText && opts.driver === 'postgres') logger.warn('RANGOLI_MFA_KEY is not set: MFA secrets use the local default key. Fine for local use, never for a hosted deployment.');
  const previous = previousText ? parseKey(previousText, 'RANGOLI_MFA_KEY_PREVIOUS') : undefined;

  const proxiesText = env.RANGOLI_TRUSTED_PROXIES;
  const proxies = opts.trustedProxies ?? (proxiesText !== undefined && proxiesText !== '' ? Number(proxiesText) : opts.publicUrl ? 1 : 0);
  if (!Number.isInteger(proxies) || proxies < 0 || proxies > 10) throw new Error('RANGOLI_TRUSTED_PROXIES must be a whole number from 0 to 10.');

  return {
    hosted,
    secureCookies: !!opts.publicUrl?.startsWith('https:'),
    box: secretBox(key, previous),
    trustedProxies: proxies,
    limits: { ...DEFAULT_LIMITS, ...opts.limits },
  };
}
