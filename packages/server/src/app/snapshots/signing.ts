/**
 * Signing snapshot hashes, so a record can be checked later: HMAC-SHA256 over the canonical form of what a snapshot
 * claims (its hashes, versions, screens and assets), with a key from configuration. KMS replaces the key later;
 * the record keeps a key id so rotation can verify old signatures with the previous key.
 *
 *   RANGOLI_SIGNING_KEY           32 bytes as hex or base64, or a passphrase of 32+ characters
 *   RANGOLI_SIGNING_KEY_PREVIOUS  still verifies, never signs
 *
 * A hosted deployment refuses to start without its own key. Local and embedded use fall back to a fixed key and
 * say so, as the MFA key does.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { canonicalize } from '@rangoli/engine';
import { logger } from '../../telemetry/log.js';
import { parseKey } from '../identity/config.js';

const LOCAL_DEFAULT_KEY = createHash('sha256').update('rangoli local signing key: not for hosted use').digest();

/** What a snapshot's signature covers. Field order does not matter: it is canonicalized. */
export interface SignedClaim {
  snapshot: string;
  project: string;
  contentHash: string;
  libraryHash: string;
  canonVersion: string;
  engineVersion: string;
  /** [screen key, screen hash], sorted */
  screens: [string, string][];
  /** [file, sha256], sorted */
  assets: [string, string][];
  createdBy: string;
}

export interface Signer {
  /** id of the key that signs now: the first 16 hex characters of its SHA-256 */
  readonly keyId: string;
  sign(claim: SignedClaim): { signature: string; keyId: string };
  /** true when the signature matches under the key it names (current or previous) */
  verify(claim: SignedClaim, signature: string, keyId: string): boolean;
}

const idOf = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 16);

export const claimText = (claim: SignedClaim): string =>
  canonicalize({ v: 1, ...claim, screens: [...claim.screens].sort((a, b) => a[0].localeCompare(b[0])), assets: [...claim.assets].sort((a, b) => a[0].localeCompare(b[0])) });

export function createSigner(key: Buffer, previous?: Buffer): Signer {
  const keys = new Map<string, Buffer>([[idOf(key), key]]);
  if (previous) keys.set(idOf(previous), previous);
  const mac = (k: Buffer, claim: SignedClaim) => createHmac('sha256', k).update(`rangoli-snapshot\n${claimText(claim)}`).digest('hex');
  const keyId = idOf(key);
  return {
    keyId,
    sign: (claim) => ({ signature: mac(key, claim), keyId }),
    verify: (claim, signature, id) => {
      const k = keys.get(id);
      if (!k || !/^[0-9a-f]{64}$/.test(signature)) return false;
      return timingSafeEqual(Buffer.from(mac(k, claim), 'hex'), Buffer.from(signature, 'hex'));
    },
  };
}

type Env = Record<string, string | undefined>;

/** The signer for this deployment, from the environment. */
export function resolveSigner(opts: { hosted: boolean; key?: string; previousKey?: string }, env: Env = process.env): Signer {
  const text = opts.key ?? env.RANGOLI_SIGNING_KEY;
  const previousText = opts.previousKey ?? env.RANGOLI_SIGNING_KEY_PREVIOUS;
  if (opts.hosted && !text) throw new Error('RANGOLI_SIGNING_KEY is not set. A hosted deployment needs its own key to sign approved snapshots (openssl rand -hex 32).');
  const key = text ? parseKey(text, 'RANGOLI_SIGNING_KEY') : LOCAL_DEFAULT_KEY;
  if (opts.hosted && key.equals(LOCAL_DEFAULT_KEY)) throw new Error('RANGOLI_SIGNING_KEY is the local default key. Use a key of your own.');
  if (!text && opts.hosted === false && env.NODE_ENV === 'production') logger.warn('RANGOLI_SIGNING_KEY is not set: snapshots are signed with the local default key.');
  return createSigner(key, previousText ? parseKey(previousText, 'RANGOLI_SIGNING_KEY_PREVIOUS') : undefined);
}
