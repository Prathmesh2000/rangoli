/** Proofs shared by sign-in, step-up and account settings: the second factor, and the verification mail. */
import type { IncomingMessage } from 'node:http';
import { newToken, tokenHash } from '../auth.js';
import type { Q } from '../db.js';
import type { AppCore } from '../http/context.js';
import { VERIFY_HOURS } from './config.js';
import { looksLikeRecovery, recoveryHash, verifyTotp } from './totp.js';

export interface FactorResult {
  userId: string;
  method: 'totp' | 'recovery';
  /** recovery codes still unused */
  recoveryLeft: number;
}

/**
 * Checks a TOTP code or a recovery code. challenge: the sign-in challenge hash, or null for the signed-in
 * person (then userId must be theirs). A TOTP code works once; a recovery code is spent.
 */
export async function checkSecondFactor(core: Pick<AppCore, 'as' | 'identity'>, challenge: string | null, userId: string | null, code: string): Promise<FactorResult | null> {
  const run = <T>(fn: (q: Q) => Promise<T>) => core.as(challenge ? null : userId, fn);
  type Row = { user_id: string; secret_enc: string | null; last_step: string | number; recovery_left: number };
  const [row] = await run((q) => q<Row>(`SELECT * FROM auth_mfa_secret($1)`, [challenge]));
  if (!row?.secret_enc) return null;
  if (looksLikeRecovery(code)) {
    const [r] = await run((q) => q<{ remaining: number | null }>(`SELECT auth_mfa_use_recovery($1, $2) AS remaining`, [challenge, recoveryHash(code)]));
    return r?.remaining === null || r?.remaining === undefined ? null : { userId: row.user_id, method: 'recovery', recoveryLeft: r.remaining };
  }
  const secret = core.identity.box.open(row.secret_enc, row.user_id);
  if (!secret) return null;
  const step = verifyTotp(secret, code, Date.now(), Number(row.last_step));
  if (step === null) return null;
  const [m] = await run((q) => q<{ ok: boolean }>(`SELECT auth_mfa_mark_step($1, $2) AS ok`, [challenge, step]));
  return m?.ok ? { userId: row.user_id, method: 'totp', recoveryLeft: row.recovery_left } : null;
}

/** Sends a verification link to the person's own address. False when there was nothing to send. */
export async function sendVerification(core: Pick<AppCore, 'as' | 'notify' | 'originOf'>, req: IncomingMessage, userId: string): Promise<boolean> {
  const token = newToken();
  const [row] = await core.as(userId, (q) => q<{ email: string; name: string }>(`SELECT * FROM auth_verify_create($1, now() + make_interval(hours => $2))`, [tokenHash(token), VERIFY_HOURS]));
  if (!row) return false;
  core.notify(
    [row.email],
    'Confirm your email for Rangoli',
    `Hi ${row.name},\n\nConfirm this is your address: ${core.originOf(req)}/verify/${token}\n\nUntil you do, you can look around but not invite people, create agent tokens or approve work. The link expires in ${VERIFY_HOURS} hours. If you did not create a Rangoli account, you can ignore this.`,
  );
  return true;
}
