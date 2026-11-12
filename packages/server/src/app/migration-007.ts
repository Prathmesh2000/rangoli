/**
 * Identity: verified email, TOTP multi-factor sign-in, session limits and step-up, scoped API tokens,
 * and a throttle shared by every app process.
 *
 *  - Nothing here is readable by rangoli_app directly. The new users columns get no column grant, and the new
 *    tables get no grant at all: every read and write goes through a SECURITY DEFINER function that checks the
 *    caller itself, as the 001 credential functions do.
 *  - MFA secrets arrive already encrypted by the app (AES-256-GCM, key from configuration). The database only
 *    ever holds ciphertext, so a dump or an injection does not yield a usable second factor.
 *  - API tokens become project-scoped, scoped by capability and expiring. Tokens made before this migration are
 *    marked legacy: they keep their old reach for a 30-day grace period and then expire (see LEGACY below).
 *  - A restrictive policy on every project table keeps a token session inside the projects its token names,
 *    whatever the permissive policies (now or in later migrations) allow.
 */
export const MIGRATION_007 = {
  id: '007_identity',
  sql: /* sql */ `
-- ---------------------------------------------------------------- accounts

ALTER TABLE users
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN mfa_secret_enc text,
  ADD COLUMN mfa_pending_enc text,
  ADD COLUMN mfa_enabled_at timestamptz,
  ADD COLUMN mfa_recovery text[] NOT NULL DEFAULT '{}',
  ADD COLUMN mfa_last_step bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT users_mfa_complete CHECK ((mfa_enabled_at IS NULL) = (mfa_secret_enc IS NULL));

CREATE TABLE email_verifications (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  -- the address the link was sent to: it verifies that address and no other
  email text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX email_verifications_user ON email_verifications (user_id);

-- ---------------------------------------------------------------- sessions
-- expires_at is the absolute limit (14 days from sign-in, kept across rotation); last_seen_at drives the idle
-- limit; auth_at and mfa_at are when this browser last proved the password and the second factor (step-up).

ALTER TABLE auth_sessions
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN auth_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN mfa_at timestamptz;
CREATE INDEX auth_sessions_user ON auth_sessions (user_id);

-- Password accepted, second factor still owed. Short-lived and single use.
CREATE TABLE auth_mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------- throttle
-- Shared by every process and survives restarts. Keys are SHA-256 of the email or address, never the value.

CREATE TABLE auth_throttle (
  bucket text NOT NULL CHECK (bucket ~ '^[a-z][a-z_.]{1,40}$'),
  key text NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  hits integer NOT NULL CHECK (hits > 0),
  window_ends timestamptz NOT NULL,
  PRIMARY KEY (bucket, key)
);
CREATE INDEX auth_throttle_ends ON auth_throttle (window_ends);

-- ---------------------------------------------------------------- API tokens
-- LEGACY: tokens made before scopes existed. They keep reaching every project their owner can, with every
-- scope, until expires_at (30 days from this migration), and the token screen asks for a replacement. A later
-- release drops the legacy flag and the NULL project list (contract step).

ALTER TABLE api_tokens
  ADD COLUMN org_id uuid REFERENCES orgs ON DELETE CASCADE,
  ADD COLUMN project_ids uuid[],
  ADD COLUMN scopes text[],
  ADD COLUMN expires_at timestamptz,
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN legacy boolean NOT NULL DEFAULT false;
UPDATE api_tokens SET legacy = true, scopes = '{read,propose,draft,items,export,jobs}', expires_at = now() + interval '30 days';
ALTER TABLE api_tokens
  ALTER COLUMN scopes SET NOT NULL,
  ALTER COLUMN expires_at SET NOT NULL,
  ADD CONSTRAINT api_tokens_scopes CHECK (cardinality(scopes) > 0 AND scopes <@ '{read,propose,draft,items,export,jobs}'::text[]),
  ADD CONSTRAINT api_tokens_scoped CHECK (legacy OR (org_id IS NOT NULL AND project_ids IS NOT NULL AND cardinality(project_ids) BETWEEN 1 AND 100));
CREATE INDEX api_tokens_user ON api_tokens (user_id);

-- ---------------------------------------------------------------- RLS on the new tables (no grants: functions only)

-- Not FORCEd: the owner-defined functions below are the only way in, and they need to reach the rows.
ALTER TABLE email_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_throttle ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- helpers other modules may use

-- The signed-in person has proved they receive mail at their address.
CREATE FUNCTION app_email_verified() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT coalesce((SELECT email_verified_at IS NOT NULL FROM users WHERE id = app_uid()), false) $$;

-- Whether this person must use a second factor: anyone named as an approver.
-- project_members.is_approver arrives with the roles migration; until then nobody is named, so this is false.
-- When that column exists, replace this body with the plain query.
CREATE FUNCTION mfa_required(u uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r boolean := false;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'public.project_members'::regclass AND attname = 'is_approver' AND NOT attisdropped) THEN
    EXECUTE 'SELECT EXISTS (SELECT 1 FROM project_members WHERE user_id = $1 AND is_approver)' INTO r USING u;
  END IF;
  RETURN coalesce(r, false);
END $$;

-- The current token (if any) is live, belongs to the current person and names this project.
-- True for a browser session, which has no token.
CREATE FUNCTION token_covers(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app_token_id() IS NULL OR EXISTS (
    SELECT 1 FROM api_tokens t
    WHERE t.id = app_token_id() AND t.user_id = app_uid() AND t.revoked_at IS NULL AND t.expires_at > now()
      AND ((t.legacy AND t.project_ids IS NULL) OR p_project = ANY (t.project_ids))
  )
$$;

-- The current token (if any) carries this scope. For has_capability to intersect with a role.
CREATE FUNCTION token_has_scope(p_scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app_token_id() IS NULL OR EXISTS (
    SELECT 1 FROM api_tokens t
    WHERE t.id = app_token_id() AND t.user_id = app_uid() AND t.revoked_at IS NULL AND t.expires_at > now() AND p_scope = ANY (t.scopes)
  )
$$;

-- ---------------------------------------------------------------- verified email is required to invite and to decide

CREATE FUNCTION require_verified_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = app_uid() AND email_verified_at IS NOT NULL) THEN
    RAISE EXCEPTION '%', TG_ARGV[0] USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invites_need_verified_email BEFORE INSERT ON invites FOR EACH ROW
  EXECUTE FUNCTION require_verified_email('Verify your email address before inviting people.');
CREATE TRIGGER signoffs_need_verified_email BEFORE INSERT ON stage_signoffs FOR EACH ROW
  EXECUTE FUNCTION require_verified_email('Verify your email address before deciding a review.');

-- ---------------------------------------------------------------- a token stays inside its projects
-- Restrictive: ANDed with whatever permissive policies exist now or are added later.

CREATE POLICY projects_token_scope ON projects AS RESTRICTIVE FOR ALL TO rangoli_app
  USING (app_token_id() IS NULL OR token_covers(id)) WITH CHECK (app_token_id() IS NULL OR token_covers(id));
-- Any table with project_id gets the same guard. Later migrations call this for the tables they add
-- (workstreams, screen_frames and strict_overrides from 009 need it): SELECT token_scope_policy('workstreams');
-- Owner only: no grant to rangoli_app.
CREATE FUNCTION token_scope_policy(t text) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  EXECUTE format('CREATE POLICY %I ON %I AS RESTRICTIVE FOR ALL TO rangoli_app USING (app_token_id() IS NULL OR token_covers(project_id)) WITH CHECK (app_token_id() IS NULL OR token_covers(project_id))', t || '_token_scope', t);
END $$;
REVOKE ALL ON FUNCTION token_scope_policy(text) FROM PUBLIC;
SELECT token_scope_policy(t) FROM unnest(ARRAY['project_members','designs','design_reviews','design_versions','design_assets','items','stage_events','stage_signoffs','design_ops','design_pages','design_checkpoints']) t;
-- the audit log is org-wide: a token never reads it, and writes only about projects it covers
CREATE POLICY audit_log_token_scope ON audit_log AS RESTRICTIVE FOR SELECT TO rangoli_app USING (app_token_id() IS NULL);
CREATE POLICY audit_log_token_write ON audit_log AS RESTRICTIVE FOR INSERT TO rangoli_app
  WITH CHECK (app_token_id() IS NULL OR (project_id IS NOT NULL AND token_covers(project_id)));
-- agents never manage people
CREATE POLICY invites_no_token ON invites AS RESTRICTIVE FOR ALL TO rangoli_app USING (app_token_id() IS NULL) WITH CHECK (app_token_id() IS NULL);

-- ---------------------------------------------------------------- email verification

-- For the signed-in person. NULL when already verified.
CREATE FUNCTION auth_verify_create(p_hash text, p_expires timestamptz) RETURNS TABLE (email text, name text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE id = app_uid();
  IF NOT FOUND OR u.email_verified_at IS NOT NULL THEN RETURN; END IF;
  DELETE FROM email_verifications WHERE user_id = u.id;
  INSERT INTO email_verifications (token_hash, user_id, email, expires_at) VALUES (p_hash, u.id, u.email, p_expires);
  RETURN QUERY SELECT u.email, u.name;
END $$;

-- Works signed out (the link may open in another browser). Single use. Returns the account verified.
CREATE FUNCTION auth_verify_consume(p_hash text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v email_verifications;
BEGIN
  DELETE FROM email_verifications WHERE token_hash = p_hash RETURNING * INTO v;
  IF NOT FOUND OR v.expires_at <= now() THEN RETURN NULL; END IF;
  UPDATE users SET email_verified_at = coalesce(email_verified_at, now()) WHERE id = v.user_id AND email = v.email;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN v.user_id;
END $$;

-- ---------------------------------------------------------------- sessions

DROP FUNCTION auth_session_create(text, uuid, timestamptz);
CREATE FUNCTION auth_session_create(p_hash text, p_user uuid, p_expires timestamptz, p_mfa boolean) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO auth_sessions (token_hash, user_id, expires_at, auth_at, mfa_at)
  VALUES (p_hash, p_user, p_expires, now(), CASE WHEN p_mfa THEN now() END)
$$;

-- The session behind a cookie, within both limits. Touches last_seen_at at most once a minute, and removes a
-- session found past either limit.
DROP FUNCTION auth_session_user(text);
CREATE FUNCTION auth_session_user(p_hash text, p_idle_seconds integer) RETURNS TABLE (
  id uuid, email text, name text, email_verified boolean, mfa_enabled boolean,
  auth_at timestamptz, mfa_at timestamptz, expires_at timestamptz
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE s auth_sessions;
BEGIN
  SELECT * INTO s FROM auth_sessions WHERE token_hash = p_hash;
  IF NOT FOUND THEN RETURN; END IF;
  IF s.expires_at <= now() OR s.last_seen_at <= now() - make_interval(secs => p_idle_seconds) THEN
    DELETE FROM auth_sessions WHERE token_hash = p_hash;
    RETURN;
  END IF;
  IF s.last_seen_at < now() - interval '1 minute' THEN
    UPDATE auth_sessions SET last_seen_at = now() WHERE token_hash = p_hash;
  END IF;
  RETURN QUERY SELECT u.id, u.email, u.name, u.email_verified_at IS NOT NULL, u.mfa_enabled_at IS NOT NULL, s.auth_at, s.mfa_at, s.expires_at
    FROM users u WHERE u.id = s.user_id;
END $$;

-- A new token for the same session: same absolute limit. p_reauth / p_mfa record a fresh proof.
CREATE FUNCTION auth_session_rotate(p_old text, p_new text, p_reauth boolean, p_mfa boolean) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE s auth_sessions;
BEGIN
  DELETE FROM auth_sessions WHERE token_hash = p_old AND expires_at > now() RETURNING * INTO s;
  IF NOT FOUND THEN RETURN NULL; END IF;
  INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at, last_seen_at, auth_at, mfa_at)
  VALUES (p_new, s.user_id, s.expires_at, s.created_at, now(),
          CASE WHEN p_reauth OR p_mfa THEN now() ELSE s.auth_at END,
          CASE WHEN p_mfa THEN now() ELSE s.mfa_at END);
  RETURN s.expires_at;
END $$;

-- Every other browser signed in as this session's person is signed out.
CREATE FUNCTION auth_session_end_others(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM auth_sessions WHERE user_id = (SELECT user_id FROM auth_sessions WHERE token_hash = p_hash) AND token_hash <> p_hash $$;

-- ---------------------------------------------------------------- MFA
-- p_challenge names the person during sign-in (no session yet); NULL means the signed-in person.

CREATE FUNCTION mfa_subject(p_challenge text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN p_challenge IS NULL THEN app_uid()
    ELSE (SELECT user_id FROM auth_mfa_challenges WHERE token_hash = p_challenge AND expires_at > now()) END
$$;

CREATE FUNCTION auth_mfa_enabled(p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT coalesce((SELECT mfa_enabled_at IS NOT NULL FROM users WHERE id = p_user), false) $$;

CREATE FUNCTION auth_mfa_challenge_create(p_hash text, p_user uuid, p_expires timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  DELETE FROM auth_mfa_challenges WHERE expires_at <= now();
  INSERT INTO auth_mfa_challenges (token_hash, user_id, expires_at) VALUES (p_hash, p_user, p_expires);
$$;

CREATE FUNCTION auth_mfa_challenge_end(p_hash text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM auth_mfa_challenges WHERE token_hash = p_hash AND expires_at > now() RETURNING user_id $$;

-- What the app needs to check a code: ciphertext only, for the subject alone.
CREATE FUNCTION auth_mfa_secret(p_challenge text) RETURNS TABLE (user_id uuid, secret_enc text, pending_enc text, last_step bigint, recovery_left integer, required boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT id, mfa_secret_enc, mfa_pending_enc, mfa_last_step, cardinality(mfa_recovery), mfa_required(id)
  FROM users WHERE id = mfa_subject(p_challenge)
$$;

-- A time step can be used once: replaying a code inside its window fails.
CREATE FUNCTION auth_mfa_mark_step(p_challenge text, p_step bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH u AS (UPDATE users SET mfa_last_step = p_step WHERE id = mfa_subject(p_challenge) AND mfa_last_step < p_step RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u)
$$;

-- Spends one recovery code. Returns how many are left, or NULL if it was not one.
CREATE FUNCTION auth_mfa_use_recovery(p_challenge text, p_code_hash text) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  UPDATE users SET mfa_recovery = array_remove(mfa_recovery, p_code_hash)
  WHERE id = mfa_subject(p_challenge) AND mfa_enabled_at IS NOT NULL AND p_code_hash = ANY (mfa_recovery)
  RETURNING cardinality(mfa_recovery)
$$;

CREATE FUNCTION auth_mfa_begin(p_pending_enc text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_uid() IS NULL OR app_token_id() IS NOT NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  UPDATE users SET mfa_pending_enc = p_pending_enc WHERE id = app_uid();
END $$;

-- Confirms the pending secret (the app has checked a code against it).
CREATE FUNCTION auth_mfa_enable(p_pending_enc text, p_recovery text[], p_step bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_uid() IS NULL OR app_token_id() IS NOT NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  UPDATE users SET mfa_secret_enc = mfa_pending_enc, mfa_pending_enc = NULL, mfa_enabled_at = now(),
    mfa_recovery = p_recovery, mfa_last_step = greatest(mfa_last_step, p_step)
  WHERE id = app_uid() AND mfa_pending_enc = p_pending_enc;
  RETURN FOUND;
END $$;

CREATE FUNCTION auth_mfa_set_recovery(p_recovery text[]) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_uid() IS NULL OR app_token_id() IS NOT NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  UPDATE users SET mfa_recovery = p_recovery WHERE id = app_uid() AND mfa_enabled_at IS NOT NULL;
  RETURN FOUND;
END $$;

CREATE FUNCTION auth_mfa_disable() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_uid() IS NULL OR app_token_id() IS NOT NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  IF mfa_required(app_uid()) THEN
    RAISE EXCEPTION 'You approve work, so two-step sign-in has to stay on.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE users SET mfa_secret_enc = NULL, mfa_pending_enc = NULL, mfa_enabled_at = NULL, mfa_recovery = '{}' WHERE id = app_uid();
END $$;

-- ---------------------------------------------------------------- throttle

-- Hits in the current window, without adding one.
CREATE FUNCTION auth_throttle_count(p_bucket text, p_key text) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT coalesce((SELECT hits FROM auth_throttle WHERE bucket = p_bucket AND key = p_key AND window_ends > now()), 0) $$;

-- Adds a hit atomically and returns the count in the current window.
CREATE FUNCTION auth_throttle_hit(p_bucket text, p_key text, p_window_seconds integer) RETURNS integer
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  INSERT INTO auth_throttle AS t (bucket, key, hits, window_ends) VALUES (p_bucket, p_key, 1, now() + make_interval(secs => p_window_seconds))
  ON CONFLICT (bucket, key) DO UPDATE SET
    hits = CASE WHEN t.window_ends > now() THEN t.hits + 1 ELSE 1 END,
    window_ends = CASE WHEN t.window_ends > now() THEN t.window_ends ELSE excluded.window_ends END
  RETURNING hits
$$;

CREATE FUNCTION auth_throttle_clear(p_bucket text, p_key text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM auth_throttle WHERE bucket = p_bucket AND key = p_key $$;

CREATE FUNCTION auth_throttle_sweep() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM auth_throttle WHERE window_ends < now() - interval '1 hour' $$;

-- ---------------------------------------------------------------- API tokens

DROP FUNCTION token_create(text, text);
CREATE FUNCTION token_create(p_name text, p_hash text, p_projects uuid[], p_scopes text[], p_days integer) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE orgs_seen uuid[]; new_id uuid;
BEGIN
  IF app_uid() IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  -- a token never mints another token
  IF app_token_id() IS NOT NULL THEN RAISE EXCEPTION 'tokens cannot create tokens' USING ERRCODE = '42501'; END IF;
  IF NOT app_email_verified() THEN RAISE EXCEPTION 'Verify your email address before creating tokens.' USING ERRCODE = 'P0001'; END IF;
  IF p_days IS NULL OR p_days < 1 OR p_days > 365 THEN RAISE EXCEPTION 'A token lasts between 1 and 365 days.' USING ERRCODE = 'P0001'; END IF;
  IF cardinality(p_projects) IS NULL OR cardinality(p_projects) < 1 THEN RAISE EXCEPTION 'Choose a project for this token.' USING ERRCODE = 'P0001'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(p_projects) p WHERE project_role_of(p) IS NULL) THEN
    RAISE EXCEPTION 'You can only give a token projects you can open.' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(DISTINCT pr.org_id) INTO orgs_seen FROM projects pr WHERE pr.id = ANY (p_projects);
  IF cardinality(orgs_seen) <> 1 THEN RAISE EXCEPTION 'A token covers projects in one organization.' USING ERRCODE = 'P0001'; END IF;
  INSERT INTO api_tokens (user_id, name, token_hash, org_id, project_ids, scopes, expires_at)
  VALUES (app_uid(), p_name, p_hash, orgs_seen[1], (SELECT array_agg(DISTINCT p) FROM unnest(p_projects) p), p_scopes, now() + make_interval(days => p_days))
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;

DROP FUNCTION my_tokens();
CREATE FUNCTION my_tokens() RETURNS TABLE (
  id uuid, name text, project_ids uuid[], scopes text[], legacy boolean,
  expires_at timestamptz, revoked_at timestamptz, last_used_at timestamptz, created_at timestamptz
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT id, name, project_ids, scopes, legacy, expires_at, revoked_at, last_used_at, created_at FROM api_tokens
  WHERE user_id = app_uid() AND app_token_id() IS NULL
    -- revoked and expired tokens stay listed for a month, so their last use can still be read
    AND coalesce(revoked_at, expires_at) > now() - interval '30 days'
  ORDER BY created_at DESC
$$;

-- Revoke, not delete: the row keeps its last use for the record.
CREATE OR REPLACE FUNCTION token_delete(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ UPDATE api_tokens SET revoked_at = now() WHERE id = p_id AND user_id = app_uid() AND app_token_id() IS NULL AND revoked_at IS NULL $$;

DROP FUNCTION auth_token_user(text);
CREATE FUNCTION auth_token_user(p_hash text) RETURNS TABLE (id uuid, email text, name text, token_id uuid, project_ids uuid[], scopes text[], legacy boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE t api_tokens;
BEGIN
  SELECT * INTO t FROM api_tokens a WHERE a.token_hash = p_hash AND a.revoked_at IS NULL AND a.expires_at > now();
  IF NOT FOUND THEN RETURN; END IF;
  IF t.last_used_at IS NULL OR t.last_used_at < now() - interval '1 minute' THEN
    UPDATE api_tokens SET last_used_at = now() WHERE api_tokens.id = t.id;
  END IF;
  RETURN QUERY SELECT u.id, u.email, u.name, t.id, t.project_ids, t.scopes, t.legacy FROM users u WHERE u.id = t.user_id;
END $$;

-- The scopes the current token holds on this project right now, or NULL when it no longer works there.
-- Checked on every agent tool call, so revoking a token stops a connected agent at its next call.
CREATE FUNCTION token_scopes_on(p_project uuid) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t.scopes FROM api_tokens t
  WHERE t.id = app_token_id() AND t.user_id = app_uid() AND t.revoked_at IS NULL AND t.expires_at > now()
    AND ((t.legacy AND t.project_ids IS NULL) OR p_project = ANY (t.project_ids))
$$;

-- ---------------------------------------------------------------- grants

REVOKE ALL ON FUNCTION
  app_email_verified(), mfa_required(uuid), token_covers(uuid), token_has_scope(text), require_verified_email(), mfa_subject(text),
  auth_verify_create(text, timestamptz), auth_verify_consume(text),
  auth_session_create(text, uuid, timestamptz, boolean), auth_session_user(text, integer), auth_session_rotate(text, text, boolean, boolean), auth_session_end_others(text),
  auth_mfa_enabled(uuid), auth_mfa_challenge_create(text, uuid, timestamptz), auth_mfa_challenge_end(text), auth_mfa_secret(text), auth_mfa_mark_step(text, bigint),
  auth_mfa_use_recovery(text, text), auth_mfa_begin(text), auth_mfa_enable(text, text[], bigint), auth_mfa_set_recovery(text[]), auth_mfa_disable(),
  auth_throttle_count(text, text), auth_throttle_hit(text, text, integer), auth_throttle_clear(text, text), auth_throttle_sweep(),
  token_create(text, text, uuid[], text[], integer), my_tokens(), auth_token_user(text), token_scopes_on(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  app_email_verified(), mfa_required(uuid), token_covers(uuid), token_has_scope(text),
  auth_verify_create(text, timestamptz), auth_verify_consume(text),
  auth_session_create(text, uuid, timestamptz, boolean), auth_session_user(text, integer), auth_session_rotate(text, text, boolean, boolean), auth_session_end_others(text),
  auth_mfa_enabled(uuid), auth_mfa_challenge_create(text, uuid, timestamptz), auth_mfa_challenge_end(text), auth_mfa_secret(text), auth_mfa_mark_step(text, bigint),
  auth_mfa_use_recovery(text, text), auth_mfa_begin(text), auth_mfa_enable(text, text[], bigint), auth_mfa_set_recovery(text[]), auth_mfa_disable(),
  auth_throttle_count(text, text), auth_throttle_hit(text, text, integer), auth_throttle_clear(text, text), auth_throttle_sweep(),
  token_create(text, text, uuid[], text[], integer), my_tokens(), auth_token_user(text), token_scopes_on(uuid)
TO rangoli_app;
`,
};
