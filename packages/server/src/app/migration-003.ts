/** Nobody decides their own review, agents never sign off, a reset ends API tokens, decisions outlive accounts. */
export const MIGRATION_003 = {
  id: '003_access_boundaries',
  sql: /* sql */ `
-- ---------------------------------------------------------------- who is acting

-- Set per transaction while a request runs on an API token. Empty for a browser session.
CREATE FUNCTION app_token_id() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.token_id', true), '')::uuid $$;

DROP FUNCTION auth_token_user(text);
CREATE FUNCTION auth_token_user(p_hash text) RETURNS TABLE (id uuid, email text, name text, token_id uuid)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH t AS (UPDATE api_tokens SET last_used_at = now() WHERE token_hash = p_hash RETURNING id, user_id)
  SELECT u.id, u.email, u.name, t.id FROM t JOIN users u ON u.id = t.user_id
$$;

-- ---------------------------------------------------------------- sign-offs

-- Whatever your role, a review you asked for is someone else's to decide. Agents never decide.
-- A designer also needs a review to be open; admins and reviewers keep being able to record one without it.
DROP POLICY signoffs_add ON stage_signoffs;
CREATE POLICY signoffs_add ON stage_signoffs FOR INSERT TO rangoli_app WITH CHECK (
  reviewer = app_uid()
  AND app_token_id() IS NULL
  AND review_requester(project_id, cycle, stage) IS DISTINCT FROM app_uid()
  AND (
    project_role_of(project_id) IN ('admin', 'reviewer')
    OR (project_role_of(project_id) = 'designer' AND review_requester(project_id, cycle, stage) IS NOT NULL)
  )
);

-- A decision stays on the record after the account behind it is gone, under the name it was made with.
ALTER TABLE stage_signoffs ADD COLUMN reviewer_name text;
UPDATE stage_signoffs f SET reviewer_name = u.name FROM users u WHERE u.id = f.reviewer;
ALTER TABLE stage_signoffs
  ALTER COLUMN reviewer_name SET NOT NULL,
  ALTER COLUMN reviewer DROP NOT NULL,
  DROP CONSTRAINT stage_signoffs_reviewer_fkey,
  ADD CONSTRAINT stage_signoffs_reviewer_fkey FOREIGN KEY (reviewer) REFERENCES users ON DELETE SET NULL;

-- The name comes from the account, never from the statement.
CREATE FUNCTION signoff_copy_name() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT name INTO NEW.reviewer_name FROM users WHERE id = NEW.reviewer;
  RETURN NEW;
END $$;
CREATE TRIGGER stage_signoffs_copy_name BEFORE INSERT ON stage_signoffs FOR EACH ROW EXECUTE FUNCTION signoff_copy_name();

-- ---------------------------------------------------------------- password reset

-- Single use, and it ends every way into the account: browser sessions and API tokens.
CREATE OR REPLACE FUNCTION auth_reset_consume(p_hash text, p_password_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE target uuid;
BEGIN
  UPDATE password_resets SET used_at = now()
    WHERE token_hash = p_hash AND used_at IS NULL AND expires_at > now()
    RETURNING user_id INTO target;
  IF target IS NULL THEN RETURN false; END IF;
  UPDATE users SET password_hash = p_password_hash WHERE id = target;
  DELETE FROM auth_sessions WHERE user_id = target;
  DELETE FROM api_tokens WHERE user_id = target;
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION app_token_id(), auth_token_user(text), signoff_copy_name() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_token_id(), auth_token_user(text) TO rangoli_app;
`,
};
