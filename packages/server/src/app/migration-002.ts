/** Review cycle per stage, designers as reviewers, object storage for images, password reset. */
export const MIGRATION_002 = {
  id: '002_review_s3_reset',
  sql: /* sql */ `
ALTER TABLE stage_events DROP CONSTRAINT stage_events_kind_check;
ALTER TABLE stage_events ADD CONSTRAINT stage_events_kind_check
  CHECK (kind IN ('created','advance','send_back','override','new_cycle','review_requested','review_withdrawn'));

-- ---------------------------------------------------------------- review

-- Who asked for the review open on this stage, if one is open.
CREATE FUNCTION review_requester(p uuid, c integer, s text) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE WHEN kind = 'review_requested' THEN actor END
  FROM stage_events WHERE project_id = p AND cycle = c AND to_stage = s
  ORDER BY created_at DESC LIMIT 1
$$;

-- The current stage is out for review or approved, so its work must not change underneath the decision.
CREATE FUNCTION stage_frozen(p uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT e.kind = 'review_requested' AND NOT EXISTS (
    SELECT 1 FROM stage_signoffs f
    WHERE f.project_id = p AND f.cycle = pr.cycle AND f.stage = pr.stage
      AND f.decision = 'changes_requested' AND f.created_at >= e.created_at
  )
  FROM projects pr
  JOIN LATERAL (
    SELECT kind, created_at FROM stage_events x
    WHERE x.project_id = pr.id AND x.cycle = pr.cycle AND x.to_stage = pr.stage
    ORDER BY x.created_at DESC LIMIT 1
  ) e ON true
  WHERE pr.id = p
$$;

-- Designers review too, but not a review they asked for themselves.
DROP POLICY signoffs_add ON stage_signoffs;
CREATE POLICY signoffs_add ON stage_signoffs FOR INSERT TO rangoli_app WITH CHECK (
  reviewer = app_uid() AND (
    project_role_of(project_id) IN ('admin', 'reviewer')
    OR (project_role_of(project_id) = 'designer' AND review_requester(project_id, cycle, stage) <> app_uid())
  )
);

-- ---------------------------------------------------------------- object storage
-- The row stays the access decision; storage says where its bytes live, so existing images keep working.

ALTER TABLE design_assets
  ALTER COLUMN bytes DROP NOT NULL,
  ADD COLUMN storage text NOT NULL DEFAULT 'db' CHECK (storage IN ('db', 's3')),
  ADD COLUMN size integer,
  ADD CONSTRAINT design_assets_has_bytes CHECK (storage = 's3' OR bytes IS NOT NULL);

-- ---------------------------------------------------------------- password reset

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION auth_reset_create(p_email text, p_hash text, p_expires timestamptz) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE u users;
BEGIN
  SELECT * INTO u FROM users WHERE email = p_email;
  IF NOT FOUND THEN RETURN NULL; END IF;
  DELETE FROM password_resets WHERE user_id = u.id;
  INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (p_hash, u.id, p_expires);
  RETURN u.name;
END $$;

-- Single use, and it signs the account out everywhere.
CREATE FUNCTION auth_reset_consume(p_hash text, p_password_hash text) RETURNS boolean
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
  RETURN true;
END $$;

REVOKE ALL ON FUNCTION review_requester(uuid, integer, text), stage_frozen(uuid), auth_reset_create(text, text, timestamptz), auth_reset_consume(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION review_requester(uuid, integer, text), stage_frozen(uuid), auth_reset_create(text, text, timestamptz), auth_reset_consume(text, text) TO rangoli_app;
`,
};
