/** The signed wire format between the app and the render service. */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Refused } from './execute.js';
import { SHOT_SELECTORS } from './port.js';

export const MAX_BODY_BYTES = 64 * 1024 * 1024;
export const TOKEN_TTL_MS = 120_000;
export const INPUT_ORIGIN = 'https://render-input.rangoli.invalid';

const hmac = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('base64url');
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('base64url');

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

interface Claims {
  aud: 'render';
  jti: string;
  exp: number;
  body: string;
}

/** A token authorizing exactly these body bytes, once, until it expires. */
export function signRequest(secret: string, jti: string, body: Buffer, now = Date.now()): string {
  const claims: Claims = { aud: 'render', jti, exp: now + TOKEN_TTL_MS, body: sha256(body) };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${hmac(secret, payload)}`;
}

export function verifyRequest(secret: string, token: string, body: Buffer, now = Date.now()): Claims {
  const [payload, sig, extra] = token.split('.');
  if (!payload || !sig || extra !== undefined || !sameText(sig, hmac(secret, payload))) throw new Refused(401, 'Bad signature');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Claims;
  if (claims.aud !== 'render') throw new Refused(401, 'Wrong audience');
  if (!(claims.exp > now)) throw new Refused(401, 'Token expired');
  if (!sameText(claims.body, sha256(body))) throw new Refused(401, 'Body does not match its signature');
  return claims;
}

/** Remembers spent token ids until they would have expired anyway. */
export class SpentTokens {
  private readonly spent = new Map<string, number>();

  /** False when this id was already used. */
  use(jti: string, exp: number, now = Date.now()): boolean {
    for (const [id, until] of this.spent) if (until <= now) this.spent.delete(id);
    if (this.spent.has(jti)) return false;
    this.spent.set(jti, exp);
    return true;
  }
}

export const inputUrl = (secret: string, jti: string, n: number, mime: string, dataHash: string) =>
  `${INPUT_ORIGIN}/${jti}/${n}/${hmac(secret, `input|${jti}|${n}|${mime}|${dataHash}`)}`;

const Prepare = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fit'), maxWidth: z.number().min(1).max(8192) }),
  z.object({ kind: z.literal('decodeImages') }),
  z.object({
    kind: z.literal('filmstrip'),
    times: z.array(z.number()).max(10),
    tracks: z.array(z.object({ id: z.string().regex(/^[\w-]+$/), at: z.number() })).max(500),
    exit: z.boolean(),
  }),
]);

const Size = z.number().int().min(1).max(4096);

const ShotBody = z.object({
  kind: z.literal('shot'),
  html: z.string().max(MAX_BODY_BYTES),
  viewport: z.object({ width: Size, height: Size }),
  scale: z.number().min(1).max(3),
  selector: z.enum(SHOT_SELECTORS),
  animations: z.literal('disabled').optional(),
  omitBackground: z.boolean().optional(),
  scene3d: z.boolean().optional(),
  prepare: Prepare.optional(),
});

const EditBody = z.object({
  kind: z.literal('edit'),
  image: z.string().max(MAX_BODY_BYTES),
  mime: z.string().max(64),
  ops: z.array(z.record(z.string(), z.unknown())).max(200),
  format: z.enum(['png', 'jpeg', 'webp']),
  quality: z.number().min(1).max(100),
});

export const RenderRequest = z.object({
  jti: z.string().min(16).max(64),
  job: z.discriminatedUnion('kind', [ShotBody, EditBody]),
  /** Each image's base64 once; inputs below point at these. */
  blobs: z.array(z.string()).max(5000),
  inputs: z.array(z.object({ url: z.string().max(512), mime: z.string().max(64), blob: z.number().int().min(0) })).max(20000),
});

export type RenderRequest = z.infer<typeof RenderRequest>;
