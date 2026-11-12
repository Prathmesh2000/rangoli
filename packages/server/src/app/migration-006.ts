/**
 * The design operation log. Expand only: the `designs` blob stays authoritative for any project that has no
 * checkpoint here yet, so this ships behind the RANGOLI_DESIGN_LOG flag and rolls back by turning it off.
 *
 *  - design_ops: one row per change, append-only (no UPDATE or DELETE grant). (project_id, seq) fences any
 *    second writer: a duplicate sequence number is a refused commit.
 *  - design_pages: the current checkpoint of each page, and '' for the document outside pages.
 *  - design_checkpoints: every checkpoint taken, keyed by the seq it describes.
 *
 * Every row states who wrote it and RLS confirms it, per row, so a group commit cannot misattribute a change.
 */
export const MIGRATION_006 = {
  id: '006_design_ops',
  sql: /* sql */ `
CREATE TABLE design_ops (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  seq bigint NOT NULL CHECK (seq > 0),
  page_id text NOT NULL,
  actor_kind text NOT NULL CHECK (actor_kind IN ('human', 'agent', 'system')),
  actor_id uuid REFERENCES users ON DELETE SET NULL,
  token_id uuid,
  run_id uuid,
  author text NOT NULL,
  label text,
  -- json, not jsonb: nothing queries inside it, and key order must survive for faithful replay
  ops json NOT NULL,
  inverse json NOT NULL,
  touched text[] NOT NULL DEFAULT '{}',
  undo_of bigint,
  redo_of bigint,
  no_history boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, seq),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX design_ops_tail ON design_ops (project_id, page_id, seq);
CREATE INDEX design_ops_touched ON design_ops USING gin (touched);

CREATE TABLE design_pages (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  page_id text NOT NULL,
  data json NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 0),
  hash char(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, page_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE design_checkpoints (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  page_id text NOT NULL,
  seq bigint NOT NULL CHECK (seq >= 0),
  data json NOT NULL,
  hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, page_id, seq),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

GRANT SELECT, INSERT ON design_ops, design_checkpoints TO rangoli_app;
GRANT SELECT, INSERT, UPDATE ON design_pages TO rangoli_app;

ALTER TABLE design_ops ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_ops FORCE ROW LEVEL SECURITY;
ALTER TABLE design_pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_pages FORCE ROW LEVEL SECURITY;
ALTER TABLE design_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE design_checkpoints FORCE ROW LEVEL SECURITY;

CREATE POLICY design_ops_read ON design_ops FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY design_ops_add ON design_ops FOR INSERT TO rangoli_app WITH CHECK (
  actor_id = app_uid()
  AND token_id IS NOT DISTINCT FROM app_token_id()
  AND actor_kind = CASE WHEN app_token_id() IS NULL THEN 'human' ELSE 'agent' END
  AND project_role_of(project_id) IN ('admin', 'designer')
);

CREATE POLICY design_pages_read ON design_pages FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY design_pages_add ON design_pages FOR INSERT TO rangoli_app WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));
CREATE POLICY design_pages_change ON design_pages FOR UPDATE TO rangoli_app
  USING (project_role_of(project_id) IN ('admin', 'designer'))
  WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));

CREATE POLICY design_checkpoints_read ON design_checkpoints FOR SELECT TO rangoli_app USING (project_role_of(project_id) IS NOT NULL);
CREATE POLICY design_checkpoints_add ON design_checkpoints FOR INSERT TO rangoli_app WITH CHECK (project_role_of(project_id) IN ('admin', 'designer'));
`,
};
