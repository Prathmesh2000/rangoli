/**
 * Encryption at rest for small secrets (TOTP seeds): AES-256-GCM with a random nonce, bound to its owner so a
 * ciphertext copied onto another account does not decrypt. Format: v1.<key id>.<iv>.<tag>.<ciphertext>.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SecretBox {
  seal(plain: Buffer, owner: string): string;
  /** null when it was not sealed for this owner by a key we hold */
  open(sealed: string, owner: string): Buffer | null;
}

const keyId = (key: Buffer) => createHash('sha256').update(key).digest('hex').slice(0, 8);
const aad = (owner: string) => Buffer.from(`rangoli-secret:${owner}`);

export function secretBox(current: Buffer, previous?: Buffer): SecretBox {
  if (current.length !== 32 || (previous && previous.length !== 32)) throw new Error('Encryption keys are 32 bytes.');
  const keys = new Map<string, Buffer>([[keyId(current), current], ...(previous ? [[keyId(previous), previous] as [string, Buffer]] : [])]);
  return {
    seal: (plain, owner) => {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', current, iv);
      c.setAAD(aad(owner));
      const ct = Buffer.concat([c.update(plain), c.final()]);
      return ['v1', keyId(current), iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
    },
    open: (sealed, owner) => {
      const [v, kid, iv, tag, ct] = sealed.split('.');
      const key = kid ? keys.get(kid) : undefined;
      if (v !== 'v1' || !key || !iv || !tag || ct === undefined) return null;
      try {
        const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        d.setAAD(aad(owner));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
      } catch {
        return null;
      }
    },
  };
}
