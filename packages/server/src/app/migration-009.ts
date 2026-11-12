/**
 * Always-open workflow, workstreams and device frames (ARCHITECTURE.md section 3, work packages 9, 10 and 13).
 * Expand only: nothing is dropped. `projects.stage` and `projects.cycle` stay authoritative this release and
 * the active Main workstream follows them; `items.data.frame` stays each screen's primary frame and
 * screen_frames follows it. The contract migration drops `stage_frozen`, `projects.stage` and `cycle` later.
 *
 *  - orgs.strict_mode: opt-in. Strict mode blocks approval or release when checks fail. An override is an
 *    admin's recorded reason, and the database refuses one from the person who asked for the review.
 *  - workstreams: one Main per (project, cycle), backfilled; the latest is active. Items, stage events and
 *    sign-offs carry a nullable workstream_id, filled in from their cycle when a writer leaves it out.
 *  - screen_frames: a screen has several linked frames (Desktop, Tablet, iPad, Mobile, custom size),
 *    backfilled from each screen's single frame.
 *  - stage_frozen() now always answers false: nothing freezes while a stage is in review.
 *
 * workstreams is not FORCE'd: the SECURITY DEFINER triggers below write it as the table owner, and on a
 * managed server that owner is not a superuser. The app role is still bound by its policies.
 */
export const MIGRATION_009 = {
  id: '009_workstreams_frames',
  sql: /* sql */ `
-- ---------------------------------------------------------------- always open

-- Stages never freeze; the function stays until the contract migration so older callers keep working.
CREATE OR REPLACE FUNCTION stage_frozen(p uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT false $$;

ALTER TABLE orgs ADD COLUMN strict_mode boolean NOT NULL DEFAULT false;

-- The only way to change it: in a browser session, by whoever may manage the organization's settings.
-- has_capability arrives with the roles migration; before it, an org admin. Resolved when called, not now.
CREATE FUNCTION org_set_strict_mode(p_org uuid, p_on boolean) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE allowed boolean;
BEGIN
  IF app_uid() IS NULL OR app_token_id() IS NOT NULL THEN RAISE EXCEPTION 'not allowed' USING ERRCODE = '42501'; END IF;
  IF to_regprocedure('has_capability(uuid,text)') IS NOT NULL THEN
    EXECUTE 'SELECT has_capability($1, ''org.settings.manage'')' INTO allowed USING p_org;
  ELSE
    allowed := org_role_of(p_org) = 'admin';
  END IF;
  IF NOT coalesce(allowed, false) THEN RAISE EXCEPTION 'Only owners and admins can change organization settings' USING ERRCODE = '42501'; END IF;
  UPDATE orgs SET strict_mode = p_on WHERE id = p_org;
  RETURN FOUND;
END $$;

-- ---------------------------------------------------------------- workstreams

CREATE TABLE workstreams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  is_main boolean NOT NULL DEFAULT false,
  cycle integer NOT NULL CHECK (cycle > 0),
  work_type text NOT NULL DEFAULT 'feature' CHECK (work_type IN ('full', 'feature', 'fix', 'regulated')),
  stage text NOT NULL DEFAULT 'discovery' CHECK (stage IN ('discovery','define','ia','wireframes','visual','prototype','testing','handoff','launch')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  closed_at timestamptz,
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX workstreams_main_cycle ON workstreams (project_id, cycle) WHERE is_main;
CREATE UNIQUE INDEX workstreams_one_active_main ON workstreams (project_id) WHERE is_main AND status = 'active';

-- One Main per project and cycle. Existing projects ran the whole lifecycle, so they are Full.
INSERT INTO workstreams (project_id, org_id, name, is_main, cycle, work_type, stage, status, created_by, created_at, closed_at)
SELECT p.id, p.org_id, 'Main', true, c,
       'full',
       CASE WHEN c = p.cycle THEN p.stage ELSE 'launch' END,
       CASE WHEN c = p.cycle THEN 'active' ELSE 'closed' END,
       p.created_by, p.created_at,
       CASE WHEN c = p.cycle THEN NULL ELSE p.updated_at END
FROM projects p CROSS JOIN LATERAL generate_series(1, p.cycle) AS c;

ALTER TABLE items ADD COLUMN workstream_id uuid;
ALTER TABLE stage_events ADD COLUMN workstream_id uuid;
ALTER TABLE stage_signoffs ADD COLUMN workstream_id uuid;
UPDATE items x SET workstream_id = w.id FROM workstreams w WHERE w.project_id = x.project_id AND w.is_main AND w.cycle = x.cycle;
UPDATE stage_events x SET workstream_id = w.id FROM workstreams w WHERE w.project_id = x.project_id AND w.is_main AND w.cycle = x.cycle;
UPDATE stage_signoffs x SET workstream_id = w.id FROM workstreams w WHERE w.project_id = x.project_id AND w.is_main AND w.cycle = x.cycle;
-- a row can only name a workstream of its own project
ALTER TABLE items ADD CONSTRAINT items_workstream_fkey FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id);
ALTER TABLE stage_events ADD CONSTRAINT stage_events_workstream_fkey FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id);
ALTER TABLE stage_signoffs ADD CONSTRAINT stage_signoffs_workstream_fkey FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id);
CREATE INDEX items_workstream ON items (workstream_id);
CREATE INDEX stage_events_workstream ON stage_events (workstream_id);
CREATE INDEX stage_signoffs_workstream ON stage_signoffs (workstream_id);

-- Writers that do not know about workstreams yet land in their cycle's Main.
CREATE FUNCTION fill_workstream() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.workstream_id IS NULL THEN
    SELECT id INTO NEW.workstream_id FROM workstreams WHERE project_id = NEW.project_id AND is_main AND cycle = NEW.cycle;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER items_fill_workstream BEFORE INSERT ON items FOR EACH ROW EXECUTE FUNCTION fill_workstream();
CREATE TRIGGER stage_events_fill_workstream BEFORE INSERT ON stage_events FOR EACH ROW EXECUTE FUNCTION fill_workstream();
CREATE TRIGGER stage_signoffs_fill_workstream BEFORE INSERT ON stage_signoffs FOR EACH ROW EXECUTE FUNCTION fill_workstream();

-- Every project starts with Main, whoever creates it and however.
CREATE FUNCTION project_main_workstream() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO workstreams (project_id, org_id, name, is_main, cycle, stage, created_by)
  VALUES (NEW.id, NEW.org_id, 'Main', true, NEW.cycle, NEW.stage, NEW.created_by);
  RETURN NULL;
END $$;
CREATE TRIGGER projects_main_workstream AFTER INSERT ON projects FOR EACH ROW EXECUTE FUNCTION project_main_workstream();

-- Main follows the project's stage; a new cycle closes it and opens the next cycle's Main with the same work type.
CREATE FUNCTION project_follow_workstream() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE prior_type text;
BEGIN
  IF NEW.cycle <> OLD.cycle THEN
    SELECT work_type INTO prior_type FROM workstreams WHERE project_id = NEW.id AND is_main AND status = 'active';
    UPDATE workstreams SET status = 'closed', closed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE project_id = NEW.id AND is_main AND status = 'active';
    INSERT INTO workstreams (project_id, org_id, name, is_main, cycle, work_type, stage, created_by)
      VALUES (NEW.id, NEW.org_id, 'Main', true, NEW.cycle, coalesce(prior_type, 'feature'), NEW.stage, app_uid())
      ON CONFLICT (project_id, cycle) WHERE is_main
      DO UPDATE SET status = 'active', stage = EXCLUDED.stage, closed_at = NULL, updated_at = clock_timestamp();
  ELSIF NEW.stage IS DISTINCT FROM OLD.stage THEN
    UPDATE workstreams SET stage = NEW.stage, updated_at = clock_timestamp() WHERE project_id = NEW.id AND is_main AND status = 'active';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER projects_follow_workstream AFTER UPDATE OF stage, cycle ON projects FOR EACH ROW EXECUTE FUNCTION project_follow_workstream();

-- ---------------------------------------------------------------- strict-mode overrides

CREATE TABLE strict_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  workstream_id uuid,
  cycle integer NOT NULL,
  stage text NOT NULL,
  action text NOT NULL CHECK (action IN ('approve', 'release')),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 1000),
  actor uuid REFERENCES users ON DELETE SET NULL,
  actor_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id)
);
CREATE INDEX strict_overrides_project ON strict_overrides (project_id, cycle, stage);
CREATE TRIGGER strict_overrides_fill_workstream BEFORE INSERT ON strict_overrides FOR EACH ROW EXECUTE FUNCTION fill_workstream();

-- The name comes from the account, never from the statement, and outlives it.
CREATE FUNCTION override_copy_name() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SELECT name INTO NEW.actor_name FROM users WHERE id = NEW.actor;
  NEW.actor_name := coalesce(NEW.actor_name, '');
  RETURN NEW;
END $$;
CREATE TRIGGER strict_overrides_copy_name BEFORE INSERT ON strict_overrides FOR EACH ROW EXECUTE FUNCTION override_copy_name();

-- ---------------------------------------------------------------- screen frames

-- Where a top-level frame is and how big, read from the stored design (page checkpoints first). Invoker's rights.
CREATE FUNCTION design_frame_of(p uuid, node text) RETURNS TABLE (page_id text, w integer, h integer)
LANGUAGE sql STABLE SET search_path = public, pg_temp
AS $$
  WITH found AS (
    SELECT dp.page_id, dp.data->'nodes'->node AS n, 0 AS pri FROM design_pages dp
      WHERE dp.project_id = p AND dp.page_id <> '' AND json_typeof(dp.data->'nodes') = 'object'
    UNION ALL
    SELECT pg.key, pg.value->'nodes'->node, 1 FROM designs d
      CROSS JOIN LATERAL json_each(CASE WHEN json_typeof(d.data->'pages') = 'object' THEN d.data->'pages' ELSE '{}'::json END) pg
      WHERE d.project_id = p AND json_typeof(pg.value->'nodes') = 'object'
  )
  SELECT f.page_id,
    CASE WHEN f.n->'size'->'w'->>'kind' = 'fixed' AND (f.n->'size'->'w'->>'v') ~ '^[0-9]+(\\.[0-9]+)?$' THEN least(greatest(round((f.n->'size'->'w'->>'v')::numeric)::int, 1), 20000) END,
    CASE WHEN f.n->'size'->'h'->>'kind' = 'fixed' AND (f.n->'size'->'h'->>'v') ~ '^[0-9]+(\\.[0-9]+)?$' THEN least(greatest(round((f.n->'size'->'h'->>'v')::numeric)::int, 1), 20000) END
  FROM found f WHERE f.n IS NOT NULL AND json_typeof(f.n) = 'object'
  ORDER BY f.pri LIMIT 1
$$;

-- Mirrors deviceForWidth() in the engine.
CREATE FUNCTION device_class(w integer) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp
AS $$ SELECT CASE WHEN w IS NULL THEN 'desktop' WHEN w < 600 THEN 'mobile' WHEN w < 900 THEN 'tablet' WHEN w < 1200 THEN 'ipad' ELSE 'desktop' END $$;

ALTER TABLE items ADD CONSTRAINT items_id_project_key UNIQUE (id, project_id);

CREATE TABLE screen_frames (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  screen_id uuid NOT NULL,
  device text NOT NULL CHECK (device IN ('desktop', 'tablet', 'ipad', 'mobile', 'custom')),
  w integer NOT NULL CHECK (w BETWEEN 1 AND 20000),
  h integer NOT NULL CHECK (h BETWEEN 1 AND 20000),
  page_id text,
  frame_node text NOT NULL CHECK (length(frame_node) BETWEEN 1 AND 40),
  is_primary boolean NOT NULL DEFAULT false,
  linked_from uuid REFERENCES screen_frames ON DELETE SET NULL,
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- a frame on the canvas belongs to one screen
  UNIQUE (project_id, frame_node),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (screen_id, project_id) REFERENCES items (id, project_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX screen_frames_one_primary ON screen_frames (screen_id) WHERE is_primary;
CREATE INDEX screen_frames_screen ON screen_frames (screen_id);

INSERT INTO screen_frames (project_id, org_id, screen_id, device, w, h, page_id, frame_node, is_primary, created_by, created_at)
SELECT i.project_id, i.org_id, i.id, device_class(f.w), coalesce(f.w, 1440), coalesce(f.h, 900), f.page_id, i.data->>'frame', true, i.created_by, i.updated_at
FROM items i LEFT JOIN LATERAL design_frame_of(i.project_id, i.data->>'frame') f ON true
WHERE i.kind = 'screen' AND coalesce(i.data->>'frame', '') <> '' AND length(i.data->>'frame') <= 40
ON CONFLICT (project_id, frame_node) DO NOTHING;

-- A screen's primary frame (items.data.frame) and its screen_frames row stay in step, whoever sets it.
-- A previous primary that is still on the canvas stays linked as another device frame.
CREATE FUNCTION screen_frame_follow() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
DECLARE
  was text := CASE WHEN TG_OP = 'UPDATE' THEN nullif(OLD.data->>'frame', '') END;
  now_ text := nullif(NEW.data->>'frame', '');
  f record;
BEGIN
  IF NEW.kind <> 'screen' OR was IS NOT DISTINCT FROM now_ THEN RETURN NULL; END IF;
  IF was IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM design_frame_of(NEW.project_id, was)) THEN
      UPDATE screen_frames SET is_primary = false, updated_at = clock_timestamp() WHERE screen_id = NEW.id AND frame_node = was;
    ELSE
      DELETE FROM screen_frames WHERE screen_id = NEW.id AND frame_node = was AND is_primary;
    END IF;
  END IF;
  IF now_ IS NOT NULL AND length(now_) <= 40 THEN
    UPDATE screen_frames SET is_primary = false, updated_at = clock_timestamp() WHERE screen_id = NEW.id AND is_primary AND frame_node <> now_;
    SELECT * INTO f FROM design_frame_of(NEW.project_id, now_);
    INSERT INTO screen_frames (project_id, org_id, screen_id, device, w, h, page_id, frame_node, is_primary, created_by)
      VALUES (NEW.project_id, NEW.org_id, NEW.id, device_class(f.w), coalesce(f.w, 1440), coalesce(f.h, 900), f.page_id, now_, true, app_uid())
      ON CONFLICT (project_id, frame_node) DO UPDATE SET screen_id = EXCLUDED.screen_id, is_primary = true, updated_at = clock_timestamp();
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER items_screen_frame AFTER INSERT OR UPDATE OF data ON items FOR EACH ROW EXECUTE FUNCTION screen_frame_follow();

-- ---------------------------------------------------------------- grants and policies

REVOKE ALL ON FUNCTION org_set_strict_mode(uuid, boolean), fill_workstream(), project_main_workstream(), project_follow_workstream(), override_copy_name(), screen_frame_follow(), design_frame_of(uuid, text), device_class(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION org_set_strict_mode(uuid, boolean), design_frame_of(uuid, text), device_class(integer) TO rangoli_app;

GRANT SELECT, INSERT, UPDATE ON workstreams TO rangoli_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON screen_frames TO rangoli_app;
GRANT SELECT, INSERT ON strict_overrides TO rangoli_app;

ALTER TABLE workstreams ENABLE ROW LEVEL SECURITY;
ALTER TABLE screen_frames ENABLE ROW LEVEL SECURITY;
ALTER TABLE screen_frames FORCE ROW LEVEL SECURITY;
ALTER TABLE strict_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE strict_overrides FORCE ROW LEVEL SECURITY;

CREATE POLICY workstreams_read ON workstreams FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY workstreams_add ON workstreams FOR INSERT TO rangoli_app WITH CHECK (created_by = app_uid() AND project_role_of(project_id) IN ('admin', 'designer'));
CREATE POLICY workstreams_change ON workstreams FOR UPDATE TO rangoli_app
  USING (project_role_of(project_id) IN ('admin', 'designer'))
  WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));

CREATE POLICY screen_frames_read ON screen_frames FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY screen_frames_add ON screen_frames FOR INSERT TO rangoli_app WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));
CREATE POLICY screen_frames_change ON screen_frames FOR UPDATE TO rangoli_app
  USING (project_role_of(project_id) IN ('admin', 'designer'))
  WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));
CREATE POLICY screen_frames_remove ON screen_frames FOR DELETE TO rangoli_app USING (project_role_of(project_id) IN ('admin', 'designer'));

-- Insert only. An override is an admin's, in a browser session, and never the person who asked for the review.
CREATE POLICY strict_overrides_read ON strict_overrides FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY strict_overrides_add ON strict_overrides FOR INSERT TO rangoli_app WITH CHECK (
  actor = app_uid()
  AND app_token_id() IS NULL
  AND project_role_of(project_id) = 'admin'
  AND (action <> 'approve' OR review_requester(project_id, cycle, stage) IS DISTINCT FROM app_uid())
);
`,
};
