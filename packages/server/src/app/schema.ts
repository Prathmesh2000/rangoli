/**
 * Database schema. Row-level security is the tenant boundary, not a second layer behind the app:
 *
 *  - The app logs in as `rangoli_login` and runs every request as `rangoli_app`. Neither owns anything
 *    or can bypass RLS, and the login role cannot become anyone else, even through SQL injection.
 *  - `app.user_id` is set per transaction; with no user, every policy returns no rows.
 *  - Every tenant table carries org_id, and composite foreign keys stop a row pointing across orgs.
 *  - Password hashes and session tokens are not readable by `rangoli_app` at all.
 *  - Helper functions are SECURITY DEFINER so policies can read membership without recursing.
 */
import { MIGRATION_002 } from './migration-002.js';
import { MIGRATION_003 } from './migration-003.js';
import { MIGRATION_006 } from './migration-006.js';
import { MIGRATION_007 } from './migration-007.js';
import { MIGRATION_009 } from './migration-009.js';
import { MIGRATION_008 } from './migration-008.js';
import { MIGRATION_010 } from './migration-010.js';
import { MIGRATION_011 } from './migration-011.js';

export const MIGRATIONS: { id: string; sql: string }[] = [
  {
    id: '001_tenancy',
    sql: /* sql */ `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rangoli_app') THEN
    CREATE ROLE rangoli_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT rangoli_app TO CURRENT_USER;
DO $$ BEGIN
  -- what the application logs in as: it can become rangoli_app and nothing else
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'rangoli_login') THEN
    CREATE ROLE rangoli_login LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
GRANT rangoli_app TO rangoli_login;
GRANT USAGE ON SCHEMA public TO rangoli_app;

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND position('@' IN email) > 1),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE auth_sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  token_hash text NOT NULL UNIQUE,
  last_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- ---------------------------------------------------------------- tenancy

CREATE TABLE orgs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  slug text NOT NULL UNIQUE,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE org_members (
  org_id uuid NOT NULL REFERENCES orgs ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'designer', 'reviewer')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX org_members_user ON org_members (user_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  role text NOT NULL CHECK (role IN ('admin', 'designer', 'reviewer')),
  token_hash text NOT NULL UNIQUE,
  project_ids uuid[] NOT NULL DEFAULT '{}',
  invited_by uuid REFERENCES users ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX invites_org ON invites (org_id);

CREATE TABLE projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  description text NOT NULL DEFAULT '',
  stage text NOT NULL DEFAULT 'discovery' CHECK (stage IN ('discovery','define','ia','wireframes','visual','prototype','testing','handoff','launch')),
  cycle integer NOT NULL DEFAULT 1 CHECK (cycle > 0),
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, org_id)
);
CREATE INDEX projects_org ON projects (org_id);

CREATE TABLE project_members (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  added_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, user_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  -- leaving the org removes project access in the same statement
  FOREIGN KEY (org_id, user_id) REFERENCES org_members (org_id, user_id) ON DELETE CASCADE
);
CREATE INDEX project_members_user ON project_members (user_id);

-- ---------------------------------------------------------------- design data
-- json (not jsonb) on purpose: key order is meaningful to token and component listings.

CREATE TABLE designs (
  project_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  data json NOT NULL,
  updated_by uuid REFERENCES users ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE design_reviews (
  project_id uuid PRIMARY KEY,
  org_id uuid NOT NULL,
  data json NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE design_versions (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  version_id text NOT NULL,
  data json NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, version_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE design_assets (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  file text NOT NULL,
  mime text NOT NULL,
  bytes bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, file),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- lifecycle

CREATE TABLE items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('brief','research','problem','persona','story','screen','flow','test_task','test_session','finding','metric','feedback')),
  cycle integer NOT NULL,
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'open',
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX items_project ON items (project_id, kind);
CREATE UNIQUE INDEX items_singleton ON items (project_id, kind) WHERE kind IN ('brief', 'problem');

-- Append-only: there is no UPDATE or DELETE policy on these two tables.
CREATE TABLE stage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  cycle integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('created','advance','send_back','override','new_cycle')),
  from_stage text,
  to_stage text NOT NULL,
  actor uuid REFERENCES users ON DELETE SET NULL,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX stage_events_project ON stage_events (project_id, created_at);

CREATE TABLE stage_signoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  cycle integer NOT NULL,
  stage text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','changes_requested')),
  note text NOT NULL DEFAULT '',
  reviewer uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX stage_signoffs_project ON stage_signoffs (project_id, created_at);

CREATE TABLE audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES orgs ON DELETE CASCADE,
  project_id uuid,
  actor uuid REFERENCES users ON DELETE SET NULL,
  action text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX audit_org ON audit_log (org_id, created_at DESC);

-- ---------------------------------------------------------------- policy helpers

CREATE FUNCTION app_uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;

CREATE FUNCTION org_role_of(o uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT role FROM org_members WHERE org_id = o AND user_id = app_uid() $$;

-- Admins reach every project in their org; everyone else needs an explicit assignment.
CREATE FUNCTION project_role_of(p uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT m.role
    FROM projects pr
    JOIN org_members m ON m.org_id = pr.org_id AND m.user_id = app_uid()
    WHERE pr.id = p
      AND (m.role = 'admin' OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p AND pm.user_id = app_uid()))
  $$;

CREATE FUNCTION shares_org_with(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM org_members a JOIN org_members b ON a.org_id = b.org_id
      WHERE a.user_id = app_uid() AND b.user_id = u
    )
  $$;

-- ---------------------------------------------------------------- privileged operations
-- Each runs one operation the caller could not do alone, and checks the caller itself.

CREATE FUNCTION auth_signup(p_email text, p_name text, p_hash text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ INSERT INTO users (email, name, password_hash) VALUES (p_email, p_name, p_hash) ON CONFLICT (email) DO NOTHING RETURNING id $$;

CREATE FUNCTION auth_has_users() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM users) $$;

CREATE FUNCTION auth_credentials(p_email text) RETURNS TABLE (id uuid, password_hash text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id, password_hash FROM users WHERE email = p_email $$;

CREATE FUNCTION auth_session_create(p_hash text, p_user uuid, p_expires timestamptz) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (p_hash, p_user, p_expires) $$;

CREATE FUNCTION auth_session_user(p_hash text) RETURNS TABLE (id uuid, email text, name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT u.id, u.email, u.name FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = p_hash AND s.expires_at > now() $$;

CREATE FUNCTION auth_session_delete(p_hash text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM auth_sessions WHERE token_hash = p_hash $$;

CREATE FUNCTION auth_token_user(p_hash text) RETURNS TABLE (id uuid, email text, name text)
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH t AS (UPDATE api_tokens SET last_used_at = now() WHERE token_hash = p_hash RETURNING user_id)
  SELECT u.id, u.email, u.name FROM t JOIN users u ON u.id = t.user_id
$$;

CREATE FUNCTION my_tokens() RETURNS TABLE (id uuid, name text, last_used_at timestamptz, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT id, name, last_used_at, created_at FROM api_tokens WHERE user_id = app_uid() ORDER BY created_at DESC $$;

CREATE FUNCTION token_create(p_name text, p_hash text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ INSERT INTO api_tokens (user_id, name, token_hash) VALUES (app_uid(), p_name, p_hash) RETURNING id $$;

CREATE FUNCTION token_delete(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp
AS $$ DELETE FROM api_tokens WHERE id = p_id AND user_id = app_uid() $$;

CREATE FUNCTION create_org(p_name text) RETURNS TABLE (id uuid, slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  base text := coalesce(nullif(trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')), ''), 'org');
  candidate text := base;
  n integer := 1;
  new_id uuid;
BEGIN
  IF app_uid() IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  WHILE EXISTS (SELECT 1 FROM orgs o WHERE o.slug = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  INSERT INTO orgs (name, slug, created_by) VALUES (p_name, candidate, app_uid()) RETURNING orgs.id INTO new_id;
  INSERT INTO org_members (org_id, user_id, role) VALUES (new_id, app_uid(), 'admin');
  RETURN QUERY SELECT new_id, candidate;
END $$;

CREATE FUNCTION create_project(p_org uuid, p_name text, p_description text, p_doc json) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE new_id uuid;
BEGIN
  IF org_role_of(p_org) IS NULL OR org_role_of(p_org) NOT IN ('admin', 'designer') THEN
    RAISE EXCEPTION 'only admins and designers can create projects' USING ERRCODE = '42501';
  END IF;
  INSERT INTO projects (org_id, name, description, created_by) VALUES (p_org, p_name, p_description, app_uid()) RETURNING id INTO new_id;
  INSERT INTO project_members (project_id, org_id, user_id, added_by) VALUES (new_id, p_org, app_uid(), app_uid());
  INSERT INTO designs (project_id, org_id, data, updated_by) VALUES (new_id, p_org, p_doc, app_uid());
  INSERT INTO design_reviews (project_id, org_id, data) VALUES (new_id, p_org, '{}');
  INSERT INTO stage_events (project_id, org_id, cycle, kind, to_stage, actor) VALUES (new_id, p_org, 1, 'created', 'discovery', app_uid());
  RETURN new_id;
END $$;

CREATE FUNCTION invite_preview(p_hash text) RETURNS TABLE (org_name text, email text, role text, status text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT o.name, i.email, i.role,
    CASE WHEN i.accepted_at IS NOT NULL THEN 'accepted'
         WHEN i.revoked_at IS NOT NULL THEN 'revoked'
         WHEN i.expires_at <= now() THEN 'expired'
         ELSE 'valid' END
  FROM invites i JOIN orgs o ON o.id = i.org_id WHERE i.token_hash = p_hash
$$;

CREATE FUNCTION accept_invite(p_hash text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE inv invites; me users; result text;
BEGIN
  SELECT * INTO me FROM users WHERE id = app_uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  SELECT * INTO inv FROM invites WHERE token_hash = p_hash FOR UPDATE;
  IF NOT FOUND OR inv.accepted_at IS NOT NULL OR inv.revoked_at IS NOT NULL OR inv.expires_at <= now() THEN
    RAISE EXCEPTION 'This invite is no longer valid' USING ERRCODE = 'P0001';
  END IF;
  -- the link only works for the address it was sent to, so a forwarded link is useless
  IF inv.email <> me.email THEN
    RAISE EXCEPTION 'This invite was sent to a different email address' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO org_members (org_id, user_id, role) VALUES (inv.org_id, me.id, inv.role)
    ON CONFLICT (org_id, user_id) DO NOTHING;
  INSERT INTO project_members (project_id, org_id, user_id, added_by)
    SELECT p.id, p.org_id, me.id, inv.invited_by FROM projects p WHERE p.org_id = inv.org_id AND p.id = ANY (inv.project_ids)
    ON CONFLICT DO NOTHING;
  UPDATE invites SET accepted_at = now() WHERE id = inv.id;
  SELECT slug INTO result FROM orgs WHERE id = inv.org_id;
  RETURN result;
END $$;

-- An org can never lose its last admin (row lock on the org serializes concurrent removals).
CREATE FUNCTION keep_one_admin() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.role = 'admin' AND (TG_OP = 'DELETE' OR NEW.role <> 'admin') THEN
    PERFORM 1 FROM orgs WHERE id = OLD.org_id FOR UPDATE;
    IF FOUND AND NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = OLD.org_id AND role = 'admin' AND user_id <> OLD.user_id) THEN
      RAISE EXCEPTION 'An organization needs at least one admin' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER org_members_keep_admin BEFORE UPDATE OR DELETE ON org_members FOR EACH ROW EXECUTE FUNCTION keep_one_admin();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO rangoli_app;

-- ---------------------------------------------------------------- grants (only what policies then narrow)
-- auth_sessions and api_tokens get no grant: reachable only through the functions above.

GRANT SELECT (id, email, name, created_at), UPDATE (name) ON users TO rangoli_app;
GRANT SELECT, UPDATE, DELETE ON orgs TO rangoli_app;
GRANT SELECT, UPDATE, DELETE ON org_members TO rangoli_app;
GRANT SELECT, INSERT, UPDATE ON invites TO rangoli_app;
GRANT SELECT, UPDATE, DELETE ON projects TO rangoli_app;
GRANT SELECT, INSERT, DELETE ON project_members TO rangoli_app;
GRANT SELECT, UPDATE ON designs, design_reviews TO rangoli_app;
GRANT SELECT, INSERT ON design_versions TO rangoli_app;
GRANT SELECT, INSERT, DELETE ON design_assets TO rangoli_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON items TO rangoli_app;
GRANT SELECT, INSERT ON stage_events, stage_signoffs, audit_log TO rangoli_app;

-- ---------------------------------------------------------------- row level security

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE orgs ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE designs ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE stage_signoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY users_read ON users FOR SELECT TO rangoli_app USING (id = app_uid() OR shares_org_with(id));
CREATE POLICY users_self ON users FOR UPDATE TO rangoli_app USING (id = app_uid()) WITH CHECK (id = app_uid());

CREATE POLICY orgs_read ON orgs FOR SELECT TO rangoli_app USING (org_role_of(id) IS NOT NULL);
CREATE POLICY orgs_update ON orgs FOR UPDATE TO rangoli_app USING (org_role_of(id) = 'admin') WITH CHECK (org_role_of(id) = 'admin');
CREATE POLICY orgs_delete ON orgs FOR DELETE TO rangoli_app USING (org_role_of(id) = 'admin');

CREATE POLICY org_members_read ON org_members FOR SELECT TO rangoli_app USING (org_role_of(org_id) IS NOT NULL);
CREATE POLICY org_members_update ON org_members FOR UPDATE TO rangoli_app USING (org_role_of(org_id) = 'admin') WITH CHECK (org_role_of(org_id) = 'admin');
CREATE POLICY org_members_delete ON org_members FOR DELETE TO rangoli_app USING (org_role_of(org_id) = 'admin' OR user_id = app_uid());

CREATE POLICY invites_admin ON invites FOR ALL TO rangoli_app USING (org_role_of(org_id) = 'admin') WITH CHECK (org_role_of(org_id) = 'admin');

CREATE POLICY projects_read ON projects FOR SELECT TO rangoli_app USING (project_role_of(id) IS NOT NULL);
CREATE POLICY projects_update ON projects FOR UPDATE TO rangoli_app USING (project_role_of(id) IN ('admin', 'designer')) WITH CHECK (project_role_of(id) IN ('admin', 'designer'));
CREATE POLICY projects_delete ON projects FOR DELETE TO rangoli_app USING (org_role_of(org_id) = 'admin');

CREATE POLICY project_members_read ON project_members FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY project_members_add ON project_members FOR INSERT TO rangoli_app WITH CHECK (org_role_of(org_id) = 'admin');
CREATE POLICY project_members_remove ON project_members FOR DELETE TO rangoli_app USING (org_role_of(org_id) = 'admin');

CREATE POLICY designs_read ON designs FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY designs_write ON designs FOR UPDATE TO rangoli_app USING (project_role_of(project_id) IN ('admin', 'designer')) WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));

CREATE POLICY reviews_read ON design_reviews FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY reviews_write ON design_reviews FOR UPDATE TO rangoli_app USING (project_role_of(project_id) IS NOT NULL) WITH CHECK (project_role_of(project_id) IS NOT NULL);

CREATE POLICY versions_read ON design_versions FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY versions_add ON design_versions FOR INSERT TO rangoli_app WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));

CREATE POLICY assets_read ON design_assets FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY assets_add ON design_assets FOR INSERT TO rangoli_app WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));
CREATE POLICY assets_remove ON design_assets FOR DELETE TO rangoli_app USING (project_role_of(project_id) IN ('admin', 'designer'));

CREATE POLICY items_read ON items FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
-- reviewers may log findings and feedback, and may only change their own
CREATE POLICY items_add ON items FOR INSERT TO rangoli_app WITH CHECK (
  created_by = app_uid() AND (project_role_of(project_id) IN ('admin', 'designer') OR (project_role_of(project_id) = 'reviewer' AND kind IN ('finding', 'feedback')))
);
CREATE POLICY items_change ON items FOR UPDATE TO rangoli_app
  USING (project_role_of(project_id) IN ('admin', 'designer') OR (project_role_of(project_id) = 'reviewer' AND kind IN ('finding', 'feedback') AND created_by = app_uid()))
  WITH CHECK (project_role_of(project_id) IN ('admin', 'designer') OR (project_role_of(project_id) = 'reviewer' AND kind IN ('finding', 'feedback') AND created_by = app_uid()));
CREATE POLICY items_remove ON items FOR DELETE TO rangoli_app
  USING (project_role_of(project_id) IN ('admin', 'designer') OR (project_role_of(project_id) = 'reviewer' AND kind IN ('finding', 'feedback') AND created_by = app_uid()));

CREATE POLICY events_read ON stage_events FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY events_add ON stage_events FOR INSERT TO rangoli_app WITH CHECK (
  actor = app_uid() AND (project_role_of(project_id) = 'admin' OR (project_role_of(project_id) = 'designer' AND kind <> 'override'))
);

CREATE POLICY signoffs_read ON stage_signoffs FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
-- designers cannot approve their own work
CREATE POLICY signoffs_add ON stage_signoffs FOR INSERT TO rangoli_app WITH CHECK (reviewer = app_uid() AND project_role_of(project_id) IN ('admin', 'reviewer'));

CREATE POLICY audit_read ON audit_log FOR SELECT TO rangoli_app USING (org_role_of(org_id) = 'admin');
CREATE POLICY audit_add ON audit_log FOR INSERT TO rangoli_app WITH CHECK (actor = app_uid() AND org_role_of(org_id) IS NOT NULL);
`,
  },
  MIGRATION_002,
  MIGRATION_003,
  MIGRATION_006,
  MIGRATION_007,
  MIGRATION_009,
  MIGRATION_008,
  MIGRATION_010,
  MIGRATION_011,
];
