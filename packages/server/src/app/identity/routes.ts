/**
 * The signed-in person's own account: profile, email verification, two-step sign-in (TOTP and recovery
 * codes), step-up re-authentication, and their agent API tokens.
 */
import { z } from 'zod';
import { newToken, tokenHash, verifyPassword } from '../auth.js';
import { addressKey } from '../http/client-ip.js';
import type { AppCore, Ctx } from '../http/context.js';
import { HttpError } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import { TOKEN_DEFAULT_DAYS } from './config.js';
import { checkSecondFactor, sendVerification } from './factors.js';
import { TOKEN_SCOPES } from './scopes.js';
import { personName } from './schemas.js';
import type { SessionUser } from './sessions.js';
import { createThrottle, tooMany, type Hit } from './throttle.js';
import { base32, newRecoveryCodes, newTotpSecret, otpauthUri, recoveryHash, verifyTotp } from './totp.js';

const code = z.string().trim().min(6, 'Enter the code').max(20);
const me = (c: Ctx) => c.user as SessionUser;

export function registerIdentityRoutes(router: Router, core: AppCore): void {
  const on = router.on.bind(router);
  const { sessions, identity } = core;
  const throttle = createThrottle(core.as, identity.limits);

  /** Runs a second-factor or password check under the MFA limits, per person and per address. */
  const guarded = async <T>(c: Ctx, check: () => Promise<T | null>, wrong: string): Promise<T> => {
    const perUser: Hit[] = [['mfaUser', c.user.id]];
    const failures: Hit[] = [['mfaIp', addressKey(core.clientIp(c.req))]];
    if ((await throttle.hit(perUser)) || (await throttle.blocked(failures))) throw tooMany(throttle.minutes([...perUser, ...failures]));
    const out = await check();
    if (out === null) {
      await throttle.hit(failures);
      throw new HttpError(400, wrong);
    }
    await throttle.clear(perUser);
    return out;
  };
  const requireVerified = (c: Ctx, what: string) => {
    if (!me(c).email_verified) throw new HttpError(403, `Verify your email address before ${what}.`, { verifyEmail: true });
  };

  on('GET', '/api/me', async (c) => {
    const u = me(c);
    const { orgs, mfa } = await c.as(async (q) => ({
      orgs: await q(`SELECT o.id, o.name, o.slug, m.role, my_capabilities(o.id, 'org') AS can FROM orgs o JOIN org_members m ON m.org_id = o.id WHERE m.user_id = app_uid() ORDER BY o.name`),
      mfa: (await q<{ recovery_left: number; required: boolean }>(`SELECT recovery_left, required FROM auth_mfa_secret(NULL)`))[0],
    }));
    c.json(200, {
      user: { id: u.id, email: u.email, name: u.name },
      orgs,
      security: {
        emailVerified: u.email_verified,
        mfaEnabled: u.mfa_enabled,
        mfaRequired: !!mfa?.required,
        recoveryLeft: u.mfa_enabled ? mfa?.recovery_left ?? 0 : 0,
        // false on a local server: links land in the server log instead of an inbox
        mailDelivers: core.mail.delivers,
      },
    });
  });

  on('PATCH', '/api/me', async (c) => {
    const b = await c.body(z.object({ name: personName }));
    await c.as((q) => q(`UPDATE users SET name = $1 WHERE id = app_uid()`, [b.name]));
    c.json(200, { ok: true });
  });

  // ---- email verification

  on('POST', '/api/me/verify', async (c) => {
    if (me(c).email_verified) throw new HttpError(409, 'Your email address is already verified.');
    const hits: Hit[] = [['verifyUser', c.user.id]];
    if (await throttle.hit(hits)) throw tooMany(throttle.minutes(hits));
    await sendVerification(core, c.req, c.user.id);
    c.json(200, { ok: true, mailDelivers: core.mail.delivers });
  });

  // ---- step-up: prove it is you again, for the next 5 minutes

  on('POST', '/api/auth/step-up', async (c) => {
    const b = await c.body(z.object({ password: z.string().max(200).optional(), code: code.optional() }).refine((v) => !!v.password !== !!v.code, 'Enter your password or a code'));
    const u = me(c);
    if (b.code) {
      await guarded(c, () => checkSecondFactor(core, null, u.id, b.code!), 'That code did not work.');
      await sessions.rotate(c.req, c.res, { reauth: true, mfa: true });
    } else {
      await guarded(c, async () => {
        const [cred] = await core.as(null, (q) => q<{ password_hash: string }>(`SELECT * FROM auth_credentials($1)`, [u.email]));
        return cred && (await verifyPassword(b.password!, cred.password_hash)) ? true : null;
      }, 'That password is not right.');
      await sessions.rotate(c.req, c.res, { reauth: true });
    }
    c.json(200, { ok: true });
  });

  // ---- two-step sign-in

  on('POST', '/api/me/mfa/setup', async (c) => {
    const u = me(c);
    if (u.mfa_enabled) throw new HttpError(409, 'Two-step sign-in is already on.');
    // changing how you sign in needs a fresh password, so a borrowed session cannot lock the owner out
    await core.stepUp(c.req, { verifiedEmail: false });
    const secret = newTotpSecret();
    await c.as((q) => q(`SELECT auth_mfa_begin($1)`, [identity.box.seal(secret, u.id)]));
    c.json(200, { secret: base32(secret), uri: otpauthUri(secret, u.email) });
  });

  on('POST', '/api/me/mfa/enable', async (c) => {
    const b = await c.body(z.object({ code }));
    const u = me(c);
    const codes = newRecoveryCodes();
    await guarded(c, async () => {
      const [row] = await c.as((q) => q<{ pending_enc: string | null; last_step: string | number }>(`SELECT pending_enc, last_step FROM auth_mfa_secret(NULL)`));
      const secret = row?.pending_enc ? identity.box.open(row.pending_enc, u.id) : null;
      if (!row?.pending_enc || !secret) throw new HttpError(409, 'Start setting up two-step sign-in again.');
      const step = verifyTotp(secret, b.code, Date.now(), Number(row.last_step));
      if (step === null) return null;
      const [done] = await c.as((q) => q<{ ok: boolean }>(`SELECT auth_mfa_enable($1, $2, $3) AS ok`, [row.pending_enc, codes.map(recoveryHash), step]));
      return done?.ok ? true : null;
    }, 'That code did not work. Check the time on your phone and try the newest code.');
    // a privilege change: new token here, and every other browser signs in again with the second factor
    await sessions.rotate(c.req, c.res, { reauth: true, mfa: true });
    await sessions.endOtherSessions(c.req);
    c.json(200, { ok: true, recoveryCodes: codes });
  });

  on('POST', '/api/me/mfa/recovery', async (c) => {
    const b = await c.body(z.object({ code }));
    const u = me(c);
    if (!u.mfa_enabled) throw new HttpError(409, 'Two-step sign-in is off.');
    await guarded(c, () => checkSecondFactor(core, null, u.id, b.code), 'That code did not work.');
    const codes = newRecoveryCodes();
    await c.as((q) => q(`SELECT auth_mfa_set_recovery($1)`, [codes.map(recoveryHash)]));
    c.json(200, { ok: true, recoveryCodes: codes });
  });

  on('POST', '/api/me/mfa/disable', async (c) => {
    const b = await c.body(z.object({ code }));
    const u = me(c);
    if (!u.mfa_enabled) throw new HttpError(409, 'Two-step sign-in is already off.');
    await guarded(c, () => checkSecondFactor(core, null, u.id, b.code), 'That code did not work.');
    await c.as((q) => q(`SELECT auth_mfa_disable()`));
    await sessions.rotate(c.req, c.res);
    await sessions.endOtherSessions(c.req);
    c.json(200, { ok: true });
  });

  // ---- access tokens (agents)

  on('GET', '/api/tokens', async (c) => {
    const rows = await c.as(async (q) => {
      const tokens = await q<{ project_ids: string[] | null }>(`SELECT * FROM my_tokens()`);
      const ids = [...new Set(tokens.flatMap((t) => t.project_ids ?? []))];
      const names = ids.length ? await q<{ id: string; name: string }>(`SELECT id, name FROM projects WHERE id = ANY ($1::uuid[])`, [ids]) : [];
      const byId = new Map(names.map((p) => [p.id, p.name]));
      // a project you can no longer open stays listed by id only
      return tokens.map((t) => ({ ...t, projects: (t.project_ids ?? []).map((id) => ({ id, name: byId.get(id) ?? null })) }));
    });
    c.json(200, rows);
  });

  on('POST', '/api/tokens', async (c) => {
    const b = await c.body(z.object({
      name: z.string().trim().min(1, 'Name the token').max(80),
      projects: z.array(z.string().uuid()).min(1, 'Choose a project for this token').max(20),
      scopes: z.array(z.enum(TOKEN_SCOPES)).min(1, 'Choose at least one thing the token may do'),
      days: z.number().int().min(1).max(365).default(TOKEN_DEFAULT_DAYS),
    }));
    requireVerified(c, 'creating tokens');
    const token = newToken('rng_');
    const [row] = await c.as((q) => q<{ id: string }>(`SELECT token_create($1, $2, $3::uuid[], $4::text[], $5) AS id`, [b.name, tokenHash(token), b.projects, [...new Set(b.scopes)], b.days]));
    c.json(200, { id: row!.id, token });
  });

  on('DELETE', `/api/tokens/${U}`, async (c) => {
    await c.as((q) => q(`SELECT token_delete($1)`, [c.p[0]]));
    c.json(200, { ok: true });
  });
}
