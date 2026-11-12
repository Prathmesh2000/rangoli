/** TOTP (RFC 6238: HMAC-SHA1, 30-second steps, 6 digits) and single-use recovery codes. */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bits, the size RFC 4226 recommends. */
export const newTotpSecret = (): Buffer => randomBytes(20);

export const stepAt = (ms: number): number => Math.floor(ms / 1000 / STEP_SECONDS);

export function totpAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const h = createHmac('sha1', secret).update(counter).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 10 ** DIGITS).padStart(DIGITS, '0');
}

/**
 * The time step a code belongs to, allowing one step of clock drift either way, or null. Steps at or before
 * lastStep are refused, so a code cannot be used twice.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastStep = 0): number | null {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return null;
  const now = stepAt(nowMs);
  let found: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    // compare every candidate, so timing does not say which window matched
    const match = timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(given));
    if (match && step > lastStep && found === null) found = step;
  }
  return found;
}

/** What an authenticator app scans or accepts pasted. */
export const otpauthUri = (secret: Buffer, account: string, issuer = 'Rangoli') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${base32(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}`;

// ---------------------------------------------------------------- recovery codes

const RC = 'abcdefghjkmnpqrstuvwxyz23456789'; // no 0/o, 1/l/i
export const RECOVERY_COUNT = 10;

/** 10 characters each, about 50 bits: plenty behind a throttle, and short enough to type. */
export function newRecoveryCodes(n = RECOVERY_COUNT): string[] {
  return Array.from({ length: n }, () => {
    const s = Array.from({ length: 10 }, () => RC[randomInt(RC.length)]).join('');
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

export const normalizeRecovery = (code: string) => code.toLowerCase().replace(/[^a-z0-9]/g, '');
export const recoveryHash = (code: string) => createHash('sha256').update(`rangoli-recovery:${normalizeRecovery(code)}`).digest('hex');
export const looksLikeRecovery = (code: string) => normalizeRecovery(code).length === 10 && !/^\d+$/.test(normalizeRecovery(code));
