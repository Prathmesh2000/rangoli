/**
 * Browser sessions (an HttpOnly cookie) and agent API tokens: turning a request into a person.
 *
 * A session lasts 14 days from sign-in at most, and ends after 24 hours without use. Over HTTPS the cookie is
 * `__Host-` prefixed: Secure, host-only, Path=/, so a sibling subdomain cannot set or shadow it. The cookie's
 * token is replaced whenever what the session may do changes (rotation), and the old one stops working.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { newToken, tokenHash } from '../auth.js';
import type { As, User } from '../http/context.js';
import { HttpError } from '../http/errors.js';
import { appendCookie, cookies } from '../http/headers.js';
import { MFA_CHALLENGE_SECONDS, SESSION_DAYS, SESSION_IDLE_SECONDS, STEP_UP_MS, type IdentityConfig } from './config.js';
import type { TokenScope } from './scopes.js';

/** The signed-in person, as their session sees them. */
export interface SessionUser extends User {
  email_verified: boolean;
  mfa_enabled: boolean;
  /** when this browser last proved the password (sign-in or step-up) */
  auth_at: string;
  /** when this browser last proved the second factor */
  mfa_at: string | null;
  expires_at: string;
}

export interface TokenUser extends User {
  token_id: string;
  /** null only for a legacy token, which reaches every project its owner can */
  project_ids: string[] | null;
  scopes: TokenScope[];
  legacy: boolean;
}

export interface Sessions {
  readonly cookieName: string;
  /** Signs this browser in as userId. mfa: the second factor was just proved. */
  startSession(res: ServerResponse, userId: string, opts?: { mfa?: boolean }): Promise<void>;
  /** Signs this browser out, whether or not its session still exists. */
  endSession(req: IncomingMessage, res: ServerResponse): Promise<void>;
  /** The person this browser's session cookie belongs to, within the absolute and idle limits. */
  currentUser(req: IncomingMessage): Promise<SessionUser | null>;
  /**
   * Replaces this browser's session token, keeping its absolute limit. Call on any privilege change.
   * reauth / mfa record that the password / second factor was just proved (step-up).
   */
  rotate(req: IncomingMessage, res: ServerResponse, opts?: { reauth?: boolean; mfa?: boolean }): Promise<boolean>;
  /** Signs out every other browser of this session's person. */
  endOtherSessions(req: IncomingMessage): Promise<void>;
  /** The person an API token (rng_…) belongs to. With projectId, only if the token covers that project. */
  tokenUser(bearer: string, projectId?: string): Promise<TokenUser | undefined>;

  /** After the password, before the second factor: a short-lived, single-use challenge cookie. */
  startMfaChallenge(res: ServerResponse, userId: string): Promise<void>;
  /** The hash of this browser's pending challenge, if it sent one. */
  mfaChallenge(req: IncomingMessage): string | undefined;
  /** Ends the challenge (single use) and returns whose it was, if it was still valid. */
  endMfaChallenge(res: ServerResponse, hash: string): Promise<string | null>;
}

export function createSessions(as: As, config: Pick<IdentityConfig, 'secureCookies'>): Sessions {
  const secure = config.secureCookies;
  const name = secure ? '__Host-rangoli_session' : 'rangoli_session';
  const mfaName = secure ? '__Host-rangoli_mfa' : 'rangoli_mfa';
  const cookie = (n: string, value: string, maxAge: number) => `${n}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.max(0, Math.floor(maxAge))}${secure ? '; Secure' : ''}`;
  const sessionCookie = (res: ServerResponse, token: string, maxAge: number) => appendCookie(res, cookie(name, token, maxAge));
  const current = (req: IncomingMessage) => cookies(req)[name];

  return {
    cookieName: name,
    startSession: async (res, userId, opts = {}) => {
      const token = newToken();
      await as(null, (q) => q(`SELECT auth_session_create($1, $2, now() + make_interval(days => $3), $4)`, [tokenHash(token), userId, SESSION_DAYS, !!opts.mfa]));
      sessionCookie(res, token, SESSION_DAYS * 86400);
    },
    endSession: async (req, res) => {
      const token = current(req);
      if (token) await as(null, (q) => q(`SELECT auth_session_delete($1)`, [tokenHash(token)]));
      sessionCookie(res, '', 0);
    },
    currentUser: async (req) => {
      const token = current(req);
      if (!token) return null;
      const [u] = await as(null, (q) => q<SessionUser>(`SELECT * FROM auth_session_user($1, $2)`, [tokenHash(token), SESSION_IDLE_SECONDS]));
      return u ?? null;
    },
    rotate: async (req, res, opts = {}) => {
      const old = current(req);
      if (!old) return false;
      const token = newToken();
      const [row] = await as(null, (q) => q<{ expires: Date | string | null }>(`SELECT auth_session_rotate($1, $2, $3, $4) AS expires`, [tokenHash(old), tokenHash(token), !!opts.reauth, !!opts.mfa]));
      if (!row?.expires) return false;
      sessionCookie(res, token, (new Date(row.expires).getTime() - Date.now()) / 1000);
      return true;
    },
    endOtherSessions: async (req) => {
      const token = current(req);
      if (token) await as(null, (q) => q(`SELECT auth_session_end_others($1)`, [tokenHash(token)]));
    },
    tokenUser: async (bearer, projectId) => {
      const [t] = await as(null, (q) => q<TokenUser>(`SELECT * FROM auth_token_user($1)`, [tokenHash(bearer)]));
      if (!t) return undefined;
      if (projectId && t.project_ids && !t.project_ids.includes(projectId)) return undefined;
      return t;
    },

    startMfaChallenge: async (res, userId) => {
      const token = newToken();
      await as(null, (q) => q(`SELECT auth_mfa_challenge_create($1, $2, now() + make_interval(secs => $3))`, [tokenHash(token), userId, MFA_CHALLENGE_SECONDS]));
      appendCookie(res, cookie(mfaName, token, MFA_CHALLENGE_SECONDS));
    },
    mfaChallenge: (req) => {
      const token = cookies(req)[mfaName];
      return token ? tokenHash(token) : undefined;
    },
    endMfaChallenge: async (res, hash) => {
      appendCookie(res, cookie(mfaName, '', 0));
      const [row] = await as(null, (q) => q<{ id: string | null }>(`SELECT auth_mfa_challenge_end($1) AS id`, [hash]));
      return row?.id ?? null;
    },
  };
}

// ---------------------------------------------------------------- step-up

export interface StepUpOptions {
  /** how recent the proof must be; 5 minutes by default */
  withinMs?: number;
  /** also refuse anyone who has not verified their email (default true) */
  verifiedEmail?: boolean;
  /** this is an approval: a named approver must have MFA on, and must have just used it */
  approval?: boolean;
}

export interface StepUpResult {
  user: SessionUser;
  /** when the second factor was proved, for the decision record; null without MFA */
  mfaAt: string | null;
}

export type StepUp = (req: IncomingMessage, opts?: StepUpOptions) => Promise<StepUpResult>;

/**
 * For routes that must know the person is at the keyboard right now: approving above all. Throws 403 with a
 * field the app reads to show the right prompt: verifyEmail, mfaSetup, or stepUp ('mfa' or 'password'),
 * which POST /api/auth/step-up answers.
 *
 *   const { user, mfaAt } = await core.stepUp(c.req, { approval: true });
 */
export function createStepUp(as: As, sessions: Sessions): StepUp {
  return async (req, opts = {}) => {
    const user = await sessions.currentUser(req);
    if (!user) throw new HttpError(401, 'Sign in to continue');
    if (opts.verifiedEmail !== false && !user.email_verified) throw new HttpError(403, 'Verify your email address first.', { verifyEmail: true });
    if (opts.approval && !user.mfa_enabled) {
      const [row] = await as(user.id, (q) => q<{ required: boolean }>(`SELECT mfa_required(app_uid()) AS required`));
      if (row?.required) throw new HttpError(403, 'Approvers need two-step sign-in. Turn it on in Security.', { mfaSetup: true });
    }
    const within = opts.withinMs ?? STEP_UP_MS;
    const fresh = (t: string | null) => !!t && Date.now() - new Date(t).getTime() <= within;
    if (user.mfa_enabled) {
      if (!fresh(user.mfa_at)) throw new HttpError(403, 'Enter a code from your authenticator app to continue.', { stepUp: 'mfa' });
    } else if (!fresh(user.auth_at)) {
      throw new HttpError(403, 'Enter your password to continue.', { stepUp: 'password' });
    }
    return { user, mfaAt: user.mfa_enabled ? user.mfa_at : null };
  };
}
