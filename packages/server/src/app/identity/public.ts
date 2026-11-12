/**
 * The routes that run before anyone is signed in: sign-up, sign-in and its second factor, email verification,
 * password reset and sign-out. Every one of them is throttled in the database, by email, by address and
 * across everyone, so the limits hold across processes and restarts.
 */
import { z } from 'zod';
import { DUMMY_HASH, hashPassword, newToken, tokenHash, verifyPassword } from '../auth.js';
import { addressKey } from '../http/client-ip.js';
import type { AppCore, PublicRoute } from '../http/context.js';
import { readJson } from '../http/body.js';
import { HttpError } from '../http/errors.js';
import { checkSecondFactor, sendVerification } from './factors.js';
import { email, password, personName } from './schemas.js';
import type { Sessions } from './sessions.js';
import { createThrottle, tooMany, type Hit } from './throttle.js';

const code = z.string().trim().min(6, 'Enter the code').max(20);

export function createIdentityPublicRoutes(core: AppCore, sessions: Sessions): PublicRoute {
  const { as, notify, originOf } = core;
  const throttle = createThrottle(as, core.identity.limits);

  return async (req, res, url, json) => {
    if (req.method !== 'POST' || !url.pathname.startsWith('/api/auth/')) return false;
    const ip = addressKey(core.clientIp(req));

    if (url.pathname === '/api/auth/signup') {
      const b = z.object({ email, name: personName, password, invite: z.string().max(200).optional() }).parse(await readJson(req));
      const hits: Hit[] = [['signupIp', ip], ['signupGlobal', '*']];
      if (await throttle.hit(hits)) throw tooMany(throttle.minutes(hits));
      if (core.inviteOnly) {
        const [{ any_users: exists } = { any_users: false }] = await as(null, (q) => q<{ any_users: boolean }>(`SELECT auth_has_users() AS any_users`));
        const [inv] = b.invite ? await as(null, (q) => q<{ email: string; status: string }>(`SELECT * FROM invite_preview($1)`, [tokenHash(b.invite!)])) : [];
        if (exists && !(inv?.status === 'valid' && inv.email === b.email)) throw new HttpError(403, 'This workspace is invite only. Ask an admin for an invite.');
      }
      const [row] = await as(null, async (q) => q<{ id: string | null }>(`SELECT auth_signup($1, $2, $3) AS id`, [b.email, b.name, await hashPassword(b.password)]));
      if (!row?.id) throw new HttpError(409, 'An account with this email already exists. Sign in instead.');
      await sendVerification(core, req, row.id);
      await sessions.startSession(res, row.id);
      json(200, { ok: true, verifyEmail: true });
      return true;
    }

    if (url.pathname === '/api/auth/login') {
      const b = z.object({ email, password: z.string().max(200) }).parse(await readJson(req));
      // per email: counted before the check, atomically, so parallel guesses cannot slip past the limit
      const perEmail: Hit[] = [['loginEmail', b.email]];
      const failures: Hit[] = [['loginIp', ip], ['loginGlobal', '*']];
      if ((await throttle.hit(perEmail)) || (await throttle.blocked(failures))) throw tooMany(throttle.minutes([...perEmail, ...failures]));
      const [cred] = await as(null, (q) => q<{ id: string; password_hash: string }>(`SELECT * FROM auth_credentials($1)`, [b.email]));
      const ok = await verifyPassword(b.password, cred?.password_hash ?? DUMMY_HASH);
      if (!cred || !ok) {
        await throttle.hit(failures);
        throw new HttpError(401, 'That email and password do not match.');
      }
      await throttle.clear(perEmail);
      const [m] = await as(null, (q) => q<{ enabled: boolean }>(`SELECT auth_mfa_enabled($1) AS enabled`, [cred.id]));
      if (m?.enabled) {
        await sessions.startMfaChallenge(res, cred.id);
        json(200, { mfa: true });
        return true;
      }
      await sessions.startSession(res, cred.id);
      json(200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/auth/mfa') {
      const b = z.object({ code }).parse(await readJson(req));
      const challenge = sessions.mfaChallenge(req);
      const [owner] = challenge ? await as(null, (q) => q<{ user_id: string }>(`SELECT user_id FROM auth_mfa_secret($1)`, [challenge])) : [];
      if (!challenge || !owner) throw new HttpError(401, 'Your sign-in timed out. Enter your password again.', { restart: true });
      const perUser: Hit[] = [['mfaUser', owner.user_id]];
      const failures: Hit[] = [['mfaIp', ip]];
      if ((await throttle.hit(perUser)) || (await throttle.blocked(failures))) throw tooMany(throttle.minutes([...perUser, ...failures]));
      const proof = await checkSecondFactor(core, challenge, null, b.code);
      if (!proof) {
        await throttle.hit(failures);
        throw new HttpError(401, 'That code did not work. Check your authenticator app and try again.');
      }
      const userId = await sessions.endMfaChallenge(res, challenge);
      if (userId !== proof.userId) throw new HttpError(401, 'Your sign-in timed out. Enter your password again.', { restart: true });
      await throttle.clear(perUser);
      await sessions.startSession(res, userId, { mfa: true });
      json(200, { ok: true, recoveryLeft: proof.method === 'recovery' ? proof.recoveryLeft : undefined });
      return true;
    }

    if (url.pathname === '/api/auth/verify') {
      const b = z.object({ token: z.string().min(10).max(200) }).parse(await readJson(req));
      const [row] = await as(null, (q) => q<{ id: string | null }>(`SELECT auth_verify_consume($1) AS id`, [tokenHash(b.token)]));
      if (!row?.id) throw new HttpError(400, 'This link has expired or was already used. Sign in and ask for a new one.');
      // the same browser gains a privilege: give it a new session token
      const me = await sessions.currentUser(req);
      if (me?.id === row.id) await sessions.rotate(req, res);
      json(200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/auth/forgot') {
      const b = z.object({ email }).parse(await readJson(req));
      const wide: Hit[] = [['resetIp', ip], ['resetGlobal', '*']];
      if (await throttle.hit(wide)) throw tooMany(throttle.minutes(wide));
      // past the per-email limit the answer stays the same, so it does not say whether the account exists
      if (!(await throttle.hit([['resetEmail', b.email]]))) {
        const token = newToken();
        const [row] = await as(null, (q) => q<{ name: string | null }>(`SELECT auth_reset_create($1, $2, now() + interval '1 hour') AS name`, [b.email, tokenHash(token)]));
        if (row?.name) notify([b.email], 'Reset your Rangoli password', `Hi ${row.name},\n\nSet a new password: ${originOf(req)}/reset/${token}\n\nThis link expires in an hour. If you did not ask for it, you can ignore this.`);
      }
      json(200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/auth/reset') {
      const b = z.object({ token: z.string().min(10).max(200), password }).parse(await readJson(req));
      const failures: Hit[] = [['resetIp', ip]];
      if (await throttle.blocked(failures)) throw tooMany(throttle.minutes(failures));
      const [row] = await as(null, async (q) => q<{ ok: boolean }>(`SELECT auth_reset_consume($1, $2) AS ok`, [tokenHash(b.token), await hashPassword(b.password)]));
      if (!row?.ok) {
        await throttle.hit(failures);
        throw new HttpError(400, 'This reset link has expired or was already used. Ask for a new one.');
      }
      json(200, { ok: true });
      return true;
    }

    if (url.pathname === '/api/auth/logout') {
      await sessions.endSession(req, res);
      json(200, { ok: true });
      return true;
    }
    return false;
  };
}
