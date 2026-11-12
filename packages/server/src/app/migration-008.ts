/**
 * Organization roles and project roles (PRD §9, §10; ARCHITECTURE §3 "004 roles", built here as 008).
 *
 *  - org_members.role becomes owner, admin, member or guest. Exactly one owner per organization: a partial unique
 *    index stops a second, a deferred constraint trigger stops none, and only `transfer_org` moves it.
 *  - project_members gains `role` (lead, designer, researcher, product_manager, developer, reviewer, viewer)
 *    and `is_approver`, the Approver designation.
 *  - `role_capabilities` holds packages/engine/src/capabilities.ts as rows, and `has_capability(scope, cap)` is the
 *    one check every policy uses. With an API token it also intersects the token's scopes (007), and organization
 *    capabilities are never reachable through a token. The write rules for agents stay in the server.
 *  - Runs after 007 (token scopes) and 009 (workstreams, screen frames, strict overrides), and moves 009's
 *    policies onto has_capability as well.
 *  - An account owns at most one organization (`orgs.owner_id`, grandfathering accounts that already own several)
 *    and an organization holds at most 100 projects, counted under a row lock on the organization.
 *
 * Backfill: admin becomes Owner (the creator, else the longest-standing admin) or Admin, and Lead on every project
 * it could reach; designer becomes Member with project Designer; reviewer becomes Member with project Reviewer.
 * Everyone who could sign off before is an approver. The tables are small, so each step is one statement.
 */
export const MIGRATION_008 = {
  id: '008_roles',
  sql: /* sql */ `
-- ---------------------------------------------------------------- the role table, from capabilities.ts

CREATE TABLE role_capabilities (
  level text NOT NULL CHECK (level IN ('org', 'project')),
  role text NOT NULL,
  capability text NOT NULL,
  PRIMARY KEY (level, role, capability)
);

INSERT INTO role_capabilities (level, role, capability)
SELECT 'org', unnest(v.roles), v.capability FROM (VALUES
  ('org.members.manage',   ARRAY['owner', 'admin']),
  ('org.billing.manage',   ARRAY['owner', 'billing_admin']),
  ('org.settings.manage',  ARRAY['owner', 'admin']),
  ('org.library.maintain', ARRAY['owner', 'admin', 'library_maintainer']),
  ('org.audit.read',       ARRAY['owner', 'auditor']),
  ('org.directory.read',   ARRAY['owner', 'admin', 'member', 'billing_admin', 'library_maintainer', 'auditor']),
  ('org.projects.create',  ARRAY['owner', 'admin', 'member']),
  ('org.projects.delete',  ARRAY['owner', 'admin']),
  ('org.delete',           ARRAY['owner']),
  ('org.transfer',         ARRAY['owner'])
) AS v (capability, roles);

INSERT INTO role_capabilities (level, role, capability)
SELECT 'project', unnest(v.roles), v.capability FROM (VALUES
  ('design.view',       ARRAY['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer', 'viewer']),
  ('comment',           ARRAY['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer']),
  ('design.edit',       ARRAY['lead', 'designer']),
  ('suggestion.accept', ARRAY['lead', 'designer']),
  ('evidence.add',      ARRAY['lead', 'designer', 'researcher', 'product_manager', 'reviewer']),
  ('decision.record',   ARRAY['lead', 'designer', 'product_manager']),
  ('decision.propose',  ARRAY['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer']),
  ('transcript.read',   ARRAY['lead', 'researcher']),
  ('task.create',       ARRAY['lead', 'designer', 'researcher', 'product_manager', 'developer']),
  ('export.run',        ARRAY['lead', 'designer', 'developer']),
  ('export.view',       ARRAY['lead', 'designer', 'product_manager', 'developer']),
  ('release',           ARRAY['lead', 'designer']),
  ('approve',           ARRAY['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer']),
  ('members.manage',    ARRAY['lead']),
  ('override.strict',   ARRAY['lead'])
) AS v (capability, roles);

-- What each token scope can reach. Capabilities no agent may hold (approve, members, transcripts, accepting
-- suggestions, releases, decisions, tasks, anything at organization level) appear under no scope at all.
CREATE TABLE token_scope_grants (
  scope text NOT NULL,
  capability text NOT NULL,
  PRIMARY KEY (scope, capability)
);
INSERT INTO token_scope_grants (scope, capability) VALUES
  ('read', 'design.view'),
  ('propose', 'design.view'), ('propose', 'comment'), ('propose', 'decision.propose'),
  ('draft', 'design.view'), ('draft', 'comment'), ('draft', 'decision.propose'), ('draft', 'design.edit'),
  ('items', 'evidence.add'), ('items', 'decision.propose'),
  ('export', 'export.run'), ('export', 'export.view');

-- reachable only through the functions below
ALTER TABLE role_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE token_scope_grants ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------- organization roles

DROP TRIGGER org_members_keep_admin ON org_members;
DROP FUNCTION keep_one_admin();
ALTER TABLE org_members DROP CONSTRAINT org_members_role_check;

-- ---------------------------------------------------------------- project roles

ALTER TABLE project_members ADD COLUMN role text, ADD COLUMN is_approver boolean NOT NULL DEFAULT false;

-- admins reached every project in their organization without a row; they keep that reach, as Lead
INSERT INTO project_members (project_id, org_id, user_id, role)
  SELECT p.id, p.org_id, m.user_id, 'lead' FROM projects p JOIN org_members m ON m.org_id = p.org_id AND m.role = 'admin'
  ON CONFLICT (project_id, user_id) DO NOTHING;
-- everyone could sign off before (designers on reviews they did not ask for), so everyone stays an approver
UPDATE project_members pm
  SET role = CASE m.role WHEN 'admin' THEN 'lead' WHEN 'designer' THEN 'designer' ELSE 'reviewer' END, is_approver = true
  FROM org_members m WHERE m.org_id = pm.org_id AND m.user_id = pm.user_id;

ALTER TABLE project_members
  ALTER COLUMN role SET DEFAULT 'viewer',
  ALTER COLUMN role SET NOT NULL,
  ADD CONSTRAINT project_members_role_check CHECK (role IN ('lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer', 'viewer'));

-- ---------------------------------------------------------------- owners

-- No foreign key action: an account that owns an organization cannot be deleted until it hands it over.
ALTER TABLE orgs ADD COLUMN owner_id uuid REFERENCES users, ADD COLUMN owner_legacy boolean NOT NULL DEFAULT false;

-- the creator if still an admin, else the longest-standing admin, else the longest-standing member
UPDATE orgs o SET owner_id = (
  SELECT m.user_id FROM org_members m WHERE m.org_id = o.id
  ORDER BY (m.role = 'admin' AND m.user_id IS NOT DISTINCT FROM o.created_by) DESC, (m.role = 'admin') DESC, m.created_at, m.user_id
  LIMIT 1
);
-- accounts that already own several keep them all; the earliest is the one that counts toward the limit
UPDATE orgs o SET owner_legacy = true
  WHERE EXISTS (SELECT 1 FROM orgs e WHERE e.owner_id = o.owner_id AND (e.created_at, e.id) < (o.created_at, o.id));

UPDATE org_members m
  SET role = CASE WHEN o.owner_id = m.user_id THEN 'owner' WHEN m.role = 'admin' THEN 'admin' ELSE 'member' END
  FROM orgs o WHERE o.id = m.org_id;

ALTER TABLE org_members ADD CONSTRAINT org_members_role_check CHECK (role IN ('owner', 'admin', 'member', 'guest'));
CREATE UNIQUE INDEX org_members_one_owner ON org_members (org_id) WHERE role = 'owner';
CREATE UNIQUE INDEX orgs_one_per_owner ON orgs (owner_id) WHERE NOT owner_legacy;

-- ---------------------------------------------------------------- invites carry the project role

ALTER TABLE invites DROP CONSTRAINT invites_role_check;
ALTER TABLE invites ADD COLUMN project_role text NOT NULL DEFAULT 'designer', ADD COLUMN is_approver boolean NOT NULL DEFAULT false;
UPDATE invites SET
  project_role = CASE role WHEN 'admin' THEN 'lead' WHEN 'reviewer' THEN 'reviewer' ELSE 'designer' END,
  is_approver = true,
  role = CASE role WHEN 'admin' THEN 'admin' ELSE 'member' END;
ALTER TABLE invites
  ADD CONSTRAINT invites_role_check CHECK (role IN ('admin', 'member', 'guest')),
  ADD CONSTRAINT invites_project_role_check CHECK (project_role IN ('lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer', 'viewer')),
  -- a guest is someone from outside, in one project
  ADD CONSTRAINT invites_guest_one_project CHECK (role <> 'guest' OR cardinality(project_ids) = 1);

-- ---------------------------------------------------------------- the one check

-- Whether the token behind this request may reach this capability on this project. 007's token_scopes_on()
-- answers for a live token of this person that names the project, and is NULL otherwise, so a token
-- reaches nothing outside the projects it names whatever its scopes.
CREATE FUNCTION token_allows(p_project uuid, cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM token_scope_grants g WHERE g.capability = cap AND g.scope = ANY (coalesce(token_scopes_on(p_project), '{}'::text[]))) $$;

-- scope is the organization for org.* capabilities and the project for every other one
CREATE FUNCTION has_capability(p_scope uuid, p_cap text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT CASE
    WHEN app_uid() IS NULL OR p_scope IS NULL THEN false
    WHEN p_cap LIKE 'org.%' THEN app_token_id() IS NULL AND EXISTS (
      SELECT 1 FROM org_members m
      JOIN role_capabilities rc ON rc.level = 'org' AND rc.role = m.role AND rc.capability = p_cap
      WHERE m.org_id = p_scope AND m.user_id = app_uid()
    )
    ELSE EXISTS (
      SELECT 1 FROM project_members pm
      JOIN role_capabilities rc ON rc.level = 'project' AND rc.role = pm.role AND rc.capability = p_cap
      WHERE pm.project_id = p_scope AND pm.user_id = app_uid()
        -- approving needs the Approver designation, and a solo organization has no approval: Release replaces it
        AND (p_cap <> 'approve' OR (pm.is_approver AND (SELECT count(*) FROM org_members o WHERE o.org_id = pm.org_id) > 1))
    ) AND (app_token_id() IS NULL OR token_allows(p_scope, p_cap))
  END
$$;

-- everything the caller holds on a project ('project') or an organization ('org'), for the app's own checks
CREATE FUNCTION my_capabilities(p_scope uuid, p_level text) RETURNS text[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT coalesce(array_agg(c ORDER BY c), '{}')
  FROM (SELECT DISTINCT capability AS c FROM role_capabilities WHERE level = p_level) x
  WHERE has_capability(p_scope, c)
$$;

-- capabilities.ts EVIDENCE_ITEM_KINDS: sources and evidence; the rest of the lifecycle is the design plan
CREATE FUNCTION item_capability(k text) RETURNS text LANGUAGE sql IMMUTABLE
AS $$ SELECT CASE WHEN k IN ('research', 'test_session', 'finding', 'feedback', 'metric') THEN 'evidence.add' ELSE 'design.edit' END $$;

-- ---------------------------------------------------------------- membership helpers

CREATE OR REPLACE FUNCTION project_role_of(p uuid) RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$ SELECT role FROM project_members WHERE project_id = p AND user_id = app_uid() $$;

-- whether the caller works in a project of this organization with u
CREATE FUNCTION shares_project_in(o uuid, u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (
      SELECT 1 FROM project_members a JOIN project_members b ON b.project_id = a.project_id
      WHERE a.org_id = o AND a.user_id = app_uid() AND b.user_id = u
    )
  $$;

-- whose name and email the caller may see: the organization directory, or the people they work with
CREATE OR REPLACE FUNCTION shares_org_with(u uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM project_members a JOIN project_members b ON b.project_id = a.project_id WHERE a.user_id = app_uid() AND b.user_id = u)
        OR EXISTS (SELECT 1 FROM org_members b WHERE b.user_id = u AND has_capability(b.org_id, 'org.directory.read'))
  $$;

-- ---------------------------------------------------------------- one owner per organization

-- orgs.owner_id follows whoever holds the owner role
CREATE FUNCTION org_owner_sync() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE orgs SET owner_legacy = owner_legacy AND owner_id = NEW.user_id, owner_id = NEW.user_id WHERE id = NEW.org_id;
  RETURN NULL;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'That person already owns an organization. An account can own one.' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER org_members_owner_sync AFTER INSERT OR UPDATE OF role ON org_members
  FOR EACH ROW WHEN (NEW.role = 'owner') EXECUTE FUNCTION org_owner_sync();

-- The owner never leaves or changes role except through transfer_org. Deleting the organization removes its
-- members after the organization row is gone, which this lets through.
CREATE FUNCTION org_member_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.role = 'owner' AND (TG_OP = 'DELETE' OR NEW.role <> 'owner')
     AND current_setting('rangoli.handover', true) IS DISTINCT FROM OLD.org_id::text
     AND EXISTS (SELECT 1 FROM orgs WHERE id = OLD.org_id) THEN
    RAISE EXCEPTION 'The owner cannot leave or change role. Hand the organization over first.' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.role = 'guest' AND OLD.role <> 'guest'
     AND (SELECT count(*) FROM project_members WHERE org_id = NEW.org_id AND user_id = NEW.user_id) > 1 THEN
    RAISE EXCEPTION 'A guest works in one project. Remove them from the others first.' USING ERRCODE = 'P0001';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER org_members_guard BEFORE UPDATE OR DELETE ON org_members FOR EACH ROW EXECUTE FUNCTION org_member_guard();

CREATE FUNCTION org_owner_assert(o uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM orgs WHERE id = o) AND (SELECT count(*) FROM org_members WHERE org_id = o AND role = 'owner') <> 1 THEN
    RAISE EXCEPTION 'An organization needs exactly one owner.' USING ERRCODE = 'P0001';
  END IF;
END $$;

-- checked at commit, so a handover can demote and promote in either order
CREATE FUNCTION org_owner_check_members() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN PERFORM org_owner_assert(OLD.org_id); ELSE PERFORM org_owner_assert(NEW.org_id); END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER org_members_owner_check AFTER INSERT OR UPDATE OR DELETE ON org_members
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION org_owner_check_members();

CREATE FUNCTION org_owner_check_orgs() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM org_owner_assert(NEW.id);
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER orgs_owner_check AFTER INSERT ON orgs
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION org_owner_check_orgs();

CREATE FUNCTION transfer_org(p_org uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT has_capability(p_org, 'org.transfer') THEN
    RAISE EXCEPTION 'Only the owner can hand the organization over' USING ERRCODE = '42501';
  END IF;
  IF p_user = app_uid() THEN RETURN; END IF;
  PERFORM 1 FROM orgs WHERE id = p_org FOR UPDATE;
  IF NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org AND user_id = p_user AND role IN ('admin', 'member')) THEN
    RAISE EXCEPTION 'The new owner has to be a member of the organization first' USING ERRCODE = 'P0001';
  END IF;
  PERFORM set_config('rangoli.handover', p_org::text, true);
  UPDATE org_members SET role = 'admin' WHERE org_id = p_org AND role = 'owner';
  UPDATE org_members SET role = 'owner' WHERE org_id = p_org AND user_id = p_user;
  PERFORM set_config('rangoli.handover', '', true);
END $$;

-- When someone's organization role changes or they are removed, their browsers sign in again, so nothing cached
-- in a session outlives the change. Only for someone else in an organization the caller manages, never the
-- owner, never through a token. (Capabilities are read live on every request regardless.)
CREATE FUNCTION member_sessions_end(p_org uuid, p_user uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF app_token_id() IS NOT NULL OR NOT has_capability(p_org, 'org.members.manage') THEN
    RAISE EXCEPTION 'Only owners and admins can do that' USING ERRCODE = '42501';
  END IF;
  -- only a current member other than the owner and the caller: call it before removing someone
  IF p_user = app_uid() OR NOT EXISTS (SELECT 1 FROM org_members WHERE org_id = p_org AND user_id = p_user AND role <> 'owner') THEN RETURN; END IF;
  DELETE FROM auth_sessions WHERE user_id = p_user;
END $$;

-- ---------------------------------------------------------------- guests and limits

CREATE FUNCTION guest_one_project() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM org_members WHERE org_id = NEW.org_id AND user_id = NEW.user_id AND role = 'guest')
     AND EXISTS (SELECT 1 FROM project_members WHERE org_id = NEW.org_id AND user_id = NEW.user_id AND project_id <> NEW.project_id) THEN
    RAISE EXCEPTION 'A guest works in one project. Make them a member to add them to another.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER project_members_guest BEFORE INSERT ON project_members FOR EACH ROW EXECUTE FUNCTION guest_one_project();

-- A 101st project is refused. The row lock on the organization makes concurrent creations count one at a time.
CREATE FUNCTION projects_limit() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM 1 FROM orgs WHERE id = NEW.org_id FOR UPDATE;
  IF (SELECT count(*) FROM projects WHERE org_id = NEW.org_id) >= 100 THEN
    RAISE EXCEPTION 'An organization can have at most 100 projects.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER projects_limit BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION projects_limit();

-- ---------------------------------------------------------------- privileged operations

CREATE OR REPLACE FUNCTION create_org(p_name text) RETURNS TABLE (id uuid, slug text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  base text := coalesce(nullif(trim(both '-' from regexp_replace(lower(p_name), '[^a-z0-9]+', '-', 'g')), ''), 'org');
  candidate text := base;
  n integer := 1;
  new_id uuid;
BEGIN
  IF app_uid() IS NULL THEN RAISE EXCEPTION 'not signed in' USING ERRCODE = '42501'; END IF;
  IF app_token_id() IS NOT NULL THEN RAISE EXCEPTION 'Agents cannot create organizations' USING ERRCODE = '42501'; END IF;
  IF EXISTS (SELECT 1 FROM orgs o WHERE o.owner_id = app_uid()) THEN
    RAISE EXCEPTION 'You already own an organization. You can still join others as a member or guest.' USING ERRCODE = 'P0001';
  END IF;
  WHILE EXISTS (SELECT 1 FROM orgs o WHERE o.slug = candidate) LOOP
    n := n + 1;
    candidate := base || '-' || n;
  END LOOP;
  INSERT INTO orgs (name, slug, created_by, owner_id) VALUES (p_name, candidate, app_uid(), app_uid()) RETURNING orgs.id INTO new_id;
  INSERT INTO org_members (org_id, user_id, role) VALUES (new_id, app_uid(), 'owner');
  RETURN QUERY SELECT new_id, candidate;
END $$;

-- the person who creates a project leads it, and is its first approver
CREATE OR REPLACE FUNCTION create_project(p_org uuid, p_name text, p_description text, p_doc json) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE new_id uuid;
BEGIN
  IF NOT has_capability(p_org, 'org.projects.create') THEN
    RAISE EXCEPTION 'Only owners, admins and members can create projects' USING ERRCODE = '42501';
  END IF;
  INSERT INTO projects (org_id, name, description, created_by) VALUES (p_org, p_name, p_description, app_uid()) RETURNING id INTO new_id;
  INSERT INTO project_members (project_id, org_id, user_id, added_by, role, is_approver) VALUES (new_id, p_org, app_uid(), app_uid(), 'lead', true);
  INSERT INTO designs (project_id, org_id, data, updated_by) VALUES (new_id, p_org, p_doc, app_uid());
  INSERT INTO design_reviews (project_id, org_id, data) VALUES (new_id, p_org, '{}');
  INSERT INTO stage_events (project_id, org_id, cycle, kind, to_stage, actor) VALUES (new_id, p_org, 1, 'created', 'discovery', app_uid());
  RETURN new_id;
END $$;

CREATE OR REPLACE FUNCTION accept_invite(p_hash text) RETURNS text
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
  -- a guest invited in properly becomes a member; nobody already inside is demoted by an invite
  INSERT INTO org_members (org_id, user_id, role) VALUES (inv.org_id, me.id, inv.role)
    ON CONFLICT (org_id, user_id) DO UPDATE SET role = EXCLUDED.role WHERE org_members.role = 'guest' AND EXCLUDED.role <> 'guest';
  INSERT INTO project_members (project_id, org_id, user_id, added_by, role, is_approver)
    SELECT p.id, p.org_id, me.id, inv.invited_by, inv.project_role, inv.is_approver FROM projects p WHERE p.org_id = inv.org_id AND p.id = ANY (inv.project_ids)
    ON CONFLICT DO NOTHING;
  UPDATE invites SET accepted_at = now() WHERE id = inv.id;
  SELECT slug INTO result FROM orgs WHERE id = inv.org_id;
  RETURN result;
END $$;

REVOKE ALL ON FUNCTION token_allows(uuid, text), member_sessions_end(uuid, uuid), has_capability(uuid, text), my_capabilities(uuid, text), item_capability(text),
  shares_project_in(uuid, uuid), org_owner_sync(), org_member_guard(), org_owner_assert(uuid), org_owner_check_members(), org_owner_check_orgs(),
  transfer_org(uuid, uuid), guest_one_project(), projects_limit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION has_capability(uuid, text), my_capabilities(uuid, text), item_capability(text), shares_project_in(uuid, uuid), transfer_org(uuid, uuid), member_sessions_end(uuid, uuid) TO rangoli_app;

-- 009's project tables get 007's guard too: a token session stays inside the projects its token names
SELECT token_scope_policy(t) FROM unnest(ARRAY['workstreams', 'screen_frames', 'strict_overrides']) t;

-- ---------------------------------------------------------------- grants

-- the owner and its limit change only through create_org and transfer_org
REVOKE UPDATE ON orgs FROM rangoli_app;
GRANT UPDATE (name) ON orgs TO rangoli_app;
REVOKE UPDATE ON org_members FROM rangoli_app;
GRANT UPDATE (role) ON org_members TO rangoli_app;
GRANT UPDATE (role, is_approver) ON project_members TO rangoli_app;

-- ---------------------------------------------------------------- policies: every decision goes through has_capability

DROP POLICY IF EXISTS orgs_update ON orgs;
DROP POLICY IF EXISTS orgs_delete ON orgs;
CREATE POLICY orgs_update ON orgs FOR UPDATE TO rangoli_app USING (has_capability(id, 'org.settings.manage')) WITH CHECK (has_capability(id, 'org.settings.manage'));
CREATE POLICY orgs_delete ON orgs FOR DELETE TO rangoli_app USING (has_capability(id, 'org.delete'));

DROP POLICY IF EXISTS org_members_read ON org_members;
DROP POLICY IF EXISTS org_members_update ON org_members;
DROP POLICY IF EXISTS org_members_delete ON org_members;
-- a guest sees itself and the people in its project, not the organization
CREATE POLICY org_members_read ON org_members FOR SELECT TO rangoli_app
  USING (user_id = app_uid() OR has_capability(org_id, 'org.directory.read') OR shares_project_in(org_id, user_id));
-- nobody makes, unmakes or removes the owner here: that is transfer_org's job
CREATE POLICY org_members_update ON org_members FOR UPDATE TO rangoli_app
  USING (role <> 'owner' AND has_capability(org_id, 'org.members.manage'))
  WITH CHECK (role <> 'owner' AND has_capability(org_id, 'org.members.manage'));
CREATE POLICY org_members_delete ON org_members FOR DELETE TO rangoli_app
  USING (role <> 'owner' AND (user_id = app_uid() OR has_capability(org_id, 'org.members.manage')));

DROP POLICY IF EXISTS invites_admin ON invites;
CREATE POLICY invites_manage ON invites FOR ALL TO rangoli_app USING (has_capability(org_id, 'org.members.manage')) WITH CHECK (has_capability(org_id, 'org.members.manage'));

DROP POLICY IF EXISTS projects_read ON projects;
DROP POLICY IF EXISTS projects_update ON projects;
DROP POLICY IF EXISTS projects_delete ON projects;
-- people who manage the organization see that its projects exist, so they can staff them, but not their content
CREATE POLICY projects_read ON projects FOR SELECT TO rangoli_app USING (has_capability(id, 'design.view') OR has_capability(org_id, 'org.members.manage'));
CREATE POLICY projects_update ON projects FOR UPDATE TO rangoli_app USING (has_capability(id, 'design.edit')) WITH CHECK (has_capability(id, 'design.edit'));
CREATE POLICY projects_delete ON projects FOR DELETE TO rangoli_app USING (has_capability(org_id, 'org.projects.delete'));

DROP POLICY IF EXISTS project_members_read ON project_members;
DROP POLICY IF EXISTS project_members_add ON project_members;
DROP POLICY IF EXISTS project_members_remove ON project_members;
CREATE POLICY project_members_read ON project_members FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view') OR has_capability(org_id, 'org.members.manage'));
CREATE POLICY project_members_add ON project_members FOR INSERT TO rangoli_app WITH CHECK (has_capability(project_id, 'members.manage') OR has_capability(org_id, 'org.members.manage'));
CREATE POLICY project_members_change ON project_members FOR UPDATE TO rangoli_app
  USING (has_capability(project_id, 'members.manage') OR has_capability(org_id, 'org.members.manage'))
  WITH CHECK (has_capability(project_id, 'members.manage') OR has_capability(org_id, 'org.members.manage'));
CREATE POLICY project_members_remove ON project_members FOR DELETE TO rangoli_app USING (has_capability(project_id, 'members.manage') OR has_capability(org_id, 'org.members.manage'));

DROP POLICY IF EXISTS designs_read ON designs;
DROP POLICY IF EXISTS designs_write ON designs;
CREATE POLICY designs_read ON designs FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY designs_write ON designs FOR UPDATE TO rangoli_app USING (has_capability(project_id, 'design.edit')) WITH CHECK (has_capability(project_id, 'design.edit'));

-- comments, suggestions and agent requests live in this row
DROP POLICY IF EXISTS reviews_read ON design_reviews;
DROP POLICY IF EXISTS reviews_write ON design_reviews;
CREATE POLICY reviews_read ON design_reviews FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY reviews_write ON design_reviews FOR UPDATE TO rangoli_app USING (has_capability(project_id, 'comment')) WITH CHECK (has_capability(project_id, 'comment'));

DROP POLICY IF EXISTS versions_read ON design_versions;
DROP POLICY IF EXISTS versions_add ON design_versions;
CREATE POLICY versions_read ON design_versions FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY versions_add ON design_versions FOR INSERT TO rangoli_app WITH CHECK (has_capability(project_id, 'design.edit'));

DROP POLICY IF EXISTS assets_read ON design_assets;
DROP POLICY IF EXISTS assets_add ON design_assets;
DROP POLICY IF EXISTS assets_remove ON design_assets;
CREATE POLICY assets_read ON design_assets FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY assets_add ON design_assets FOR INSERT TO rangoli_app WITH CHECK (has_capability(project_id, 'design.edit'));
CREATE POLICY assets_remove ON design_assets FOR DELETE TO rangoli_app USING (has_capability(project_id, 'design.edit'));

-- evidence is added by anyone holding evidence.add, who then changes only their own; the plan needs design.edit
DROP POLICY IF EXISTS items_read ON items;
DROP POLICY IF EXISTS items_add ON items;
DROP POLICY IF EXISTS items_change ON items;
DROP POLICY IF EXISTS items_remove ON items;
CREATE POLICY items_read ON items FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY items_add ON items FOR INSERT TO rangoli_app WITH CHECK (created_by = app_uid() AND has_capability(project_id, item_capability(kind)));
CREATE POLICY items_change ON items FOR UPDATE TO rangoli_app
  USING (has_capability(project_id, 'design.edit') OR (created_by = app_uid() AND has_capability(project_id, item_capability(kind))))
  WITH CHECK (has_capability(project_id, 'design.edit') OR (created_by = app_uid() AND has_capability(project_id, item_capability(kind))));
CREATE POLICY items_remove ON items FOR DELETE TO rangoli_app
  USING (has_capability(project_id, 'design.edit') OR (created_by = app_uid() AND has_capability(project_id, item_capability(kind))));

DROP POLICY IF EXISTS events_read ON stage_events;
DROP POLICY IF EXISTS events_add ON stage_events;
CREATE POLICY events_read ON stage_events FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY events_add ON stage_events FOR INSERT TO rangoli_app WITH CHECK (
  actor = app_uid() AND has_capability(project_id, CASE WHEN kind = 'override' THEN 'override.strict' ELSE 'design.edit' END)
);

-- Only a named approver decides, only on a review that is open, never their own, never through a token.
DROP POLICY IF EXISTS signoffs_read ON stage_signoffs;
DROP POLICY IF EXISTS signoffs_add ON stage_signoffs;
CREATE POLICY signoffs_read ON stage_signoffs FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY signoffs_add ON stage_signoffs FOR INSERT TO rangoli_app WITH CHECK (
  reviewer = app_uid()
  AND app_token_id() IS NULL
  AND review_requester(project_id, cycle, stage) IS NOT NULL
  AND review_requester(project_id, cycle, stage) <> app_uid()
  AND has_capability(project_id, 'approve')
);

DROP POLICY IF EXISTS audit_read ON audit_log;
CREATE POLICY audit_read ON audit_log FOR SELECT TO rangoli_app USING (has_capability(org_id, 'org.audit.read'));

DROP POLICY IF EXISTS design_ops_read ON design_ops;
DROP POLICY IF EXISTS design_ops_add ON design_ops;
CREATE POLICY design_ops_read ON design_ops FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY design_ops_add ON design_ops FOR INSERT TO rangoli_app WITH CHECK (
  actor_id = app_uid()
  AND token_id IS NOT DISTINCT FROM app_token_id()
  AND actor_kind = CASE WHEN app_token_id() IS NULL THEN 'human' ELSE 'agent' END
  AND has_capability(project_id, 'design.edit')
);

DROP POLICY IF EXISTS design_pages_read ON design_pages;
DROP POLICY IF EXISTS design_pages_add ON design_pages;
DROP POLICY IF EXISTS design_pages_change ON design_pages;
CREATE POLICY design_pages_read ON design_pages FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY design_pages_add ON design_pages FOR INSERT TO rangoli_app WITH CHECK (has_capability(project_id, 'design.edit'));
CREATE POLICY design_pages_change ON design_pages FOR UPDATE TO rangoli_app USING (has_capability(project_id, 'design.edit')) WITH CHECK (has_capability(project_id, 'design.edit'));

-- 009's tables, written before roles existed
DROP POLICY IF EXISTS workstreams_read ON workstreams;
DROP POLICY IF EXISTS workstreams_add ON workstreams;
DROP POLICY IF EXISTS workstreams_change ON workstreams;
CREATE POLICY workstreams_read ON workstreams FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY workstreams_add ON workstreams FOR INSERT TO rangoli_app WITH CHECK (created_by = app_uid() AND has_capability(project_id, 'design.edit'));
CREATE POLICY workstreams_change ON workstreams FOR UPDATE TO rangoli_app USING (has_capability(project_id, 'design.edit')) WITH CHECK (has_capability(project_id, 'design.edit'));

DROP POLICY IF EXISTS screen_frames_read ON screen_frames;
DROP POLICY IF EXISTS screen_frames_add ON screen_frames;
DROP POLICY IF EXISTS screen_frames_change ON screen_frames;
DROP POLICY IF EXISTS screen_frames_remove ON screen_frames;
CREATE POLICY screen_frames_read ON screen_frames FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY screen_frames_add ON screen_frames FOR INSERT TO rangoli_app WITH CHECK (has_capability(project_id, 'design.edit'));
CREATE POLICY screen_frames_change ON screen_frames FOR UPDATE TO rangoli_app USING (has_capability(project_id, 'design.edit')) WITH CHECK (has_capability(project_id, 'design.edit'));
CREATE POLICY screen_frames_remove ON screen_frames FOR DELETE TO rangoli_app USING (has_capability(project_id, 'design.edit'));

-- an override is the Lead's, in a browser session, and never on a review they asked for
DROP POLICY IF EXISTS strict_overrides_read ON strict_overrides;
DROP POLICY IF EXISTS strict_overrides_add ON strict_overrides;
CREATE POLICY strict_overrides_read ON strict_overrides FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY strict_overrides_add ON strict_overrides FOR INSERT TO rangoli_app WITH CHECK (
  actor = app_uid()
  AND app_token_id() IS NULL
  AND has_capability(project_id, 'override.strict')
  AND (action <> 'approve' OR review_requester(project_id, cycle, stage) IS DISTINCT FROM app_uid())
);

DROP POLICY IF EXISTS design_checkpoints_read ON design_checkpoints;
DROP POLICY IF EXISTS design_checkpoints_add ON design_checkpoints;
CREATE POLICY design_checkpoints_read ON design_checkpoints FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY design_checkpoints_add ON design_checkpoints FOR INSERT TO rangoli_app WITH CHECK (has_capability(project_id, 'design.edit'));
`,
};
