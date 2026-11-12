/**
 * Version-bound approvals (PRD §8.6, §10; ARCHITECTURE §3 "007 approval", built here as 010; work packages 11 and 17).
 *
 *  - snapshots: an immutable copy of the design, its lifecycle items, annotations and screen-frame links, with the
 *    content and library hashes, the canonical-form and engine versions, and a signature over the hashes. Insert
 *    only: no UPDATE or DELETE grant, and a trigger refuses an update even from the owner.
 *  - snapshot_screens and snapshot_assets can only be added in the transaction that made their snapshot, so a
 *    snapshot is complete when it commits and nothing joins it later. A design asset a snapshot uses cannot be
 *    deleted (a trigger with a clear message, and a foreign key behind it); deleting the project still works.
 *  - approvals bind a review request to one snapshot, with named approvers and an any or all rule.
 *    approval_decisions keep the approver's name after their account is gone, the exceptions accepted with notes,
 *    and when the second factor was proved. Nobody decides a review they asked for, whatever their role; an API
 *    token never decides; a decision needs a verified email and, for anyone who must use MFA, a second factor
 *    proved within five minutes on one of their live sessions.
 *  - releases record what shipped: a snapshot, a checklist and notes. In a solo organization it is "released by";
 *    a team release references an approved snapshot or an accepted exception (a release override by someone
 *    else). Strict mode refuses anything else; otherwise it is recorded as unapproved.
 *  - fixes start from a released frame with a note, keeping the hash it had when released (before and after).
 *  - share_links: snapshot-only links for stakeholders and developers, stored as a SHA-256 of a 256-bit token,
 *    expiring (30 days by default, a year at most) and revocable. Read without a session only through
 *    share_link_* functions, which answer for a live link and nothing else.
 *
 * None of these tables is FORCE'd: the SECURITY DEFINER helpers read them as the owner, which on a managed server
 * is not a superuser. The app role is still bound by every policy.
 */
export const MIGRATION_010 = {
  id: '010_snapshots_approvals',
  sql: /* sql */ `
-- ---------------------------------------------------------------- shared triggers

-- Records of decisions and releases are never edited, by anyone. The one change let through is a column becoming
-- NULL, which is what deleting an account does to the ids that pointed at it (the copied names stay).
CREATE FUNCTION refuse_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM jsonb_each(to_jsonb(NEW)) n JOIN jsonb_each(to_jsonb(OLD)) o USING (key)
    WHERE n.value IS DISTINCT FROM o.value AND n.value <> 'null'::jsonb
  ) THEN
    RAISE EXCEPTION '% cannot be changed once recorded', TG_TABLE_NAME USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- Copies a person's name from their account into a *_name column, so the record keeps it after the account goes.
-- TG_ARGV[0] is the column holding the person's id, TG_ARGV[1] the column to fill.
CREATE FUNCTION copy_person_name() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE who uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid; n text;
BEGIN
  SELECT name INTO n FROM users WHERE id = who;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[1], coalesce(n, '')));
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------- snapshots

CREATE TABLE snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  workstream_id uuid,
  cycle integer NOT NULL CHECK (cycle > 0),
  stage text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('review', 'baseline', 'release', 'manual')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  -- the design's operation sequence when it was taken
  seq bigint NOT NULL DEFAULT 0,
  -- json: key order matters to token and component listings, as in designs.data
  data json NOT NULL,
  -- where the design moves once snapshots go to object storage; data stays authoritative until then
  s3_key text,
  items jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(items) = 'array'),
  annotations jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(annotations) = 'array'),
  frames jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(frames) = 'array'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  library_hash text NOT NULL CHECK (library_hash ~ '^[0-9a-f]{64}$'),
  canon_version text NOT NULL CHECK (length(canon_version) BETWEEN 1 AND 40),
  engine_version text NOT NULL CHECK (length(engine_version) BETWEEN 1 AND 40),
  signature text NOT NULL CHECK (signature ~ '^[0-9a-f]{64}$'),
  signing_key text NOT NULL CHECK (signing_key ~ '^[0-9a-f]{16}$'),
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_by_name text NOT NULL DEFAULT '',
  created_tx bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id)
);
CREATE INDEX snapshots_project ON snapshots (project_id, created_at DESC);
CREATE TRIGGER snapshots_fill_workstream BEFORE INSERT ON snapshots FOR EACH ROW EXECUTE FUNCTION fill_workstream();
CREATE TRIGGER snapshots_copy_name BEFORE INSERT ON snapshots FOR EACH ROW EXECUTE FUNCTION copy_person_name('created_by', 'created_by_name');
CREATE TRIGGER snapshots_immutable BEFORE UPDATE ON snapshots FOR EACH ROW EXECUTE FUNCTION refuse_update();

-- The transaction a snapshot was made in, whatever the statement said: its screens and assets join it there or never.
CREATE FUNCTION snapshot_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp
AS $$
BEGIN
  NEW.created_tx := txid_current();
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER snapshots_stamp BEFORE INSERT ON snapshots FOR EACH ROW EXECUTE FUNCTION snapshot_stamp();

-- Whether this snapshot was made by the caller in the current transaction.
CREATE FUNCTION snapshot_open(s uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT EXISTS (SELECT 1 FROM snapshots WHERE id = s AND created_by = app_uid() AND created_tx = txid_current()) $$;

CREATE TABLE snapshot_screens (
  snapshot_id uuid NOT NULL,
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  -- the frame's node id: unique in a document
  screen_key text NOT NULL CHECK (length(screen_key) BETWEEN 1 AND 200),
  -- the lifecycle screen it is a frame of, when it is linked to one (no foreign key: the item may go later)
  screen_id uuid,
  name text NOT NULL DEFAULT '' CHECK (length(name) <= 200),
  page_id text NOT NULL CHECK (length(page_id) BETWEEN 1 AND 200),
  device text,
  screen_hash text NOT NULL CHECK (screen_hash ~ '^[0-9a-f]{64}$'),
  root_hash text NOT NULL CHECK (root_hash ~ '^[0-9a-f]{64}$'),
  deps json NOT NULL,
  PRIMARY KEY (snapshot_id, screen_key),
  FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE TRIGGER snapshot_screens_immutable BEFORE UPDATE ON snapshot_screens FOR EACH ROW EXECUTE FUNCTION refuse_update();

CREATE TABLE snapshot_assets (
  snapshot_id uuid NOT NULL,
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  file text NOT NULL,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  mime text NOT NULL,
  size integer,
  PRIMARY KEY (snapshot_id, file),
  FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  -- NO ACTION, checked at the end of the statement: deleting the whole project removes both sides together,
  -- deleting only the asset is refused
  FOREIGN KEY (project_id, file) REFERENCES design_assets (project_id, file)
);
CREATE INDEX snapshot_assets_file ON snapshot_assets (project_id, file);
CREATE TRIGGER snapshot_assets_immutable BEFORE UPDATE ON snapshot_assets FOR EACH ROW EXECUTE FUNCTION refuse_update();

-- A clear refusal before the foreign key's. Deleting the project (the project row is gone by then) passes.
CREATE FUNCTION design_asset_in_use() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
     AND EXISTS (SELECT 1 FROM snapshot_assets WHERE project_id = OLD.project_id AND file = OLD.file) THEN
    RAISE EXCEPTION 'This image is part of a saved snapshot, so it cannot be deleted.' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER design_assets_in_use BEFORE DELETE ON design_assets FOR EACH ROW EXECUTE FUNCTION design_asset_in_use();

-- ---------------------------------------------------------------- approvals

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  workstream_id uuid,
  cycle integer NOT NULL CHECK (cycle > 0),
  stage text NOT NULL,
  rule text NOT NULL DEFAULT 'any' CHECK (rule IN ('any', 'all')),
  -- named approvers; empty means any approver on the project
  approvers uuid[] NOT NULL DEFAULT '{}',
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  requested_by uuid REFERENCES users ON DELETE SET NULL,
  requested_by_name text NOT NULL DEFAULT '',
  withdrawn_at timestamptz,
  withdrawn_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id),
  CONSTRAINT approvals_all_needs_names CHECK (rule = 'any' OR cardinality(approvers) > 0),
  CONSTRAINT approvals_not_self CHECK (requested_by IS NULL OR NOT (requested_by = ANY (approvers))),
  CONSTRAINT approvals_withdrawn CHECK (withdrawn_by IS NULL OR withdrawn_at IS NOT NULL)
);
CREATE INDEX approvals_project ON approvals (project_id, cycle, stage, created_at DESC);
CREATE INDEX approvals_snapshot ON approvals (snapshot_id);
CREATE TRIGGER approvals_fill_workstream BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION fill_workstream();
CREATE TRIGGER approvals_copy_name BEFORE INSERT ON approvals FOR EACH ROW EXECUTE FUNCTION copy_person_name('requested_by', 'requested_by_name');

-- Who asked for this approval. NULL once their account is gone, which no one is.
CREATE FUNCTION approval_requester(a uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT requested_by FROM approvals WHERE id = a $$;

CREATE TABLE approval_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id uuid NOT NULL,
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  -- copied from the approval by the trigger below: the decision is on that exact version
  snapshot_id uuid NOT NULL,
  content_hash text NOT NULL,
  approver_id uuid REFERENCES users ON DELETE SET NULL,
  approver_name text NOT NULL DEFAULT '',
  decision text NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 2000),
  -- [{ check, note }]: failing checks accepted at approval, each with a note
  exceptions jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(exceptions) = 'array'),
  mfa_at timestamptz,
  via text NOT NULL DEFAULT 'app' CHECK (via IN ('app', 'link')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (approval_id, project_id) REFERENCES approvals (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX approval_decisions_approval ON approval_decisions (approval_id, created_at);
CREATE TRIGGER approval_decisions_immutable BEFORE UPDATE ON approval_decisions FOR EACH ROW EXECUTE FUNCTION refuse_update();

-- A second factor this person proved on one of their live sessions within the last five minutes, at exactly p_at.
CREATE FUNCTION approval_mfa_fresh(p_at timestamptz) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT p_at IS NOT NULL AND p_at > now() - interval '5 minutes' AND EXISTS (
    SELECT 1 FROM auth_sessions s
    WHERE s.user_id = app_uid() AND s.expires_at > now() AND s.mfa_at IS NOT NULL
      AND abs(extract(epoch FROM s.mfa_at - p_at)) < 0.002
  )
$$;

-- What the statement cannot be trusted to say: the version decided on, the name, and that the approval is open,
-- names this person if it names anyone, and that they just proved who they are.
CREATE FUNCTION approval_decision_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE ap approvals; snap_hash text;
BEGIN
  SELECT * INTO ap FROM approvals WHERE id = NEW.approval_id AND project_id = NEW.project_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'That review does not exist.' USING ERRCODE = 'P0001'; END IF;
  IF ap.withdrawn_at IS NOT NULL THEN RAISE EXCEPTION 'This review was withdrawn, so there is nothing to decide.' USING ERRCODE = 'P0001'; END IF;
  IF cardinality(ap.approvers) > 0 AND NOT (app_uid() = ANY (ap.approvers)) THEN
    RAISE EXCEPTION 'This review names its approvers, and you are not one of them.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT app_email_verified() THEN RAISE EXCEPTION 'Verify your email address before deciding a review.' USING ERRCODE = 'P0001'; END IF;
  IF mfa_required(app_uid()) AND NOT approval_mfa_fresh(NEW.mfa_at) THEN
    RAISE EXCEPTION 'Confirm it is you with a code from your authenticator app, then decide again.' USING ERRCODE = 'P0001';
  END IF;
  SELECT content_hash INTO snap_hash FROM snapshots WHERE id = ap.snapshot_id;
  NEW.snapshot_id := ap.snapshot_id;
  NEW.content_hash := snap_hash;
  NEW.created_at := clock_timestamp();
  SELECT name INTO NEW.approver_name FROM users WHERE id = NEW.approver_id;
  NEW.approver_name := coalesce(NEW.approver_name, '');
  RETURN NEW;
END $$;
CREATE TRIGGER approval_decisions_guard BEFORE INSERT ON approval_decisions FOR EACH ROW EXECUTE FUNCTION approval_decision_guard();

-- open, approved, changes_requested or withdrawn, from each approver's latest decision and the rule
CREATE FUNCTION approval_status(a uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  WITH ap AS (SELECT * FROM approvals WHERE id = a),
  latest AS (
    SELECT DISTINCT ON (coalesce(approver_id::text, 'former:' || id::text)) approver_id, decision
    FROM approval_decisions WHERE approval_id = a
    ORDER BY coalesce(approver_id::text, 'former:' || id::text), created_at DESC, id
  )
  SELECT CASE
    WHEN ap.withdrawn_at IS NOT NULL THEN 'withdrawn'
    WHEN EXISTS (SELECT 1 FROM latest WHERE decision = 'changes_requested') THEN 'changes_requested'
    WHEN ap.rule = 'any' AND EXISTS (SELECT 1 FROM latest WHERE decision = 'approved') THEN 'approved'
    WHEN ap.rule = 'all' AND NOT EXISTS (
      SELECT 1 FROM unnest(ap.approvers) x WHERE NOT EXISTS (SELECT 1 FROM latest l WHERE l.approver_id = x AND l.decision = 'approved')
    ) THEN 'approved'
    ELSE 'open'
  END
  FROM ap
$$;

-- An organization with one person in it: Release replaces approval there.
CREATE FUNCTION org_is_solo(o uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$ SELECT (SELECT count(*) FROM org_members WHERE org_id = o) = 1 $$;

-- ---------------------------------------------------------------- releases and fixes

CREATE TABLE releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  workstream_id uuid,
  cycle integer NOT NULL CHECK (cycle > 0),
  snapshot_id uuid NOT NULL,
  -- what lets it ship: an approved snapshot, an accepted exception, a solo organization, or (outside strict mode) nothing
  basis text NOT NULL CHECK (basis IN ('approval', 'exception', 'solo', 'unapproved')),
  approval_id uuid,
  override_id uuid REFERENCES strict_overrides ON DELETE SET NULL,
  fix_id uuid,
  checklist jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(checklist) = 'array'),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 4000),
  released_by uuid REFERENCES users ON DELETE SET NULL,
  released_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (approval_id, project_id) REFERENCES approvals (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id),
  CONSTRAINT releases_approval_basis CHECK ((basis = 'approval') = (approval_id IS NOT NULL))
);
CREATE INDEX releases_project ON releases (project_id, created_at DESC);
CREATE TRIGGER releases_fill_workstream BEFORE INSERT ON releases FOR EACH ROW EXECUTE FUNCTION fill_workstream();
CREATE TRIGGER releases_immutable BEFORE UPDATE ON releases FOR EACH ROW EXECUTE FUNCTION refuse_update();

-- The basis has to be true, whatever the statement claims.
CREATE FUNCTION release_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE solo boolean := org_is_solo(NEW.org_id); is_strict boolean; ap approvals; ov strict_overrides;
BEGIN
  SELECT o.strict_mode OR coalesce((SELECT w.work_type = 'regulated' FROM workstreams w WHERE w.project_id = NEW.project_id AND w.is_main AND w.status = 'active'), false)
    INTO is_strict FROM orgs o WHERE o.id = NEW.org_id;
  IF NEW.basis = 'solo' AND NOT solo THEN
    RAISE EXCEPTION 'Only a one-person organization releases without approval.' USING ERRCODE = 'P0001';
  ELSIF NEW.basis = 'approval' THEN
    SELECT * INTO ap FROM approvals WHERE id = NEW.approval_id AND project_id = NEW.project_id;
    IF NOT FOUND OR ap.snapshot_id <> NEW.snapshot_id OR approval_status(ap.id) <> 'approved' THEN
      RAISE EXCEPTION 'That snapshot is not approved.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.basis = 'exception' THEN
    SELECT * INTO ov FROM strict_overrides WHERE id = NEW.override_id AND project_id = NEW.project_id;
    IF NOT FOUND OR ov.action <> 'release' OR ov.cycle <> NEW.cycle OR ov.actor IS NOT DISTINCT FROM NEW.released_by THEN
      RAISE EXCEPTION 'A release exception has to be accepted by someone other than the person releasing.' USING ERRCODE = 'P0001';
    END IF;
  ELSIF NEW.basis = 'unapproved' AND (solo OR is_strict) THEN
    RAISE EXCEPTION 'Strict mode is on: a release needs an approved snapshot or an accepted exception.' USING ERRCODE = 'P0001';
  END IF;
  SELECT name INTO NEW.released_by_name FROM users WHERE id = NEW.released_by;
  NEW.released_by_name := coalesce(NEW.released_by_name, '');
  NEW.created_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER releases_guard BEFORE INSERT ON releases FOR EACH ROW EXECUTE FUNCTION release_guard();

CREATE TABLE fixes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  -- the Fix workstream the change is made in
  workstream_id uuid,
  release_id uuid NOT NULL,
  -- the released snapshot, and the frame in it being fixed: the "before"
  snapshot_id uuid NOT NULL,
  frame_node text NOT NULL CHECK (length(frame_node) BETWEEN 1 AND 200),
  screen_id uuid,
  before_hash text NOT NULL CHECK (before_hash ~ '^[0-9a-f]{64}$'),
  note text NOT NULL CHECK (length(btrim(note)) BETWEEN 1 AND 2000),
  created_by uuid REFERENCES users ON DELETE SET NULL,
  created_by_name text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (id, project_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (release_id, project_id) REFERENCES releases (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots (id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (workstream_id, project_id) REFERENCES workstreams (id, project_id)
);
CREATE INDEX fixes_project ON fixes (project_id, created_at DESC);
CREATE TRIGGER fixes_copy_name BEFORE INSERT ON fixes FOR EACH ROW EXECUTE FUNCTION copy_person_name('created_by', 'created_by_name');
CREATE TRIGGER fixes_immutable BEFORE UPDATE ON fixes FOR EACH ROW EXECUTE FUNCTION refuse_update();
ALTER TABLE releases ADD CONSTRAINT releases_fix_fkey FOREIGN KEY (fix_id, project_id) REFERENCES fixes (id, project_id) ;

-- ---------------------------------------------------------------- share links

CREATE TABLE share_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  snapshot_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('stakeholder', 'developer')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 120),
  created_by uuid REFERENCES users ON DELETE SET NULL,
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 days',
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE,
  FOREIGN KEY (snapshot_id, project_id) REFERENCES snapshots (id, project_id) ON DELETE CASCADE,
  CONSTRAINT share_links_expiry CHECK (expires_at > created_at AND expires_at <= created_at + interval '366 days')
);
CREATE INDEX share_links_project ON share_links (project_id, created_at DESC);

-- What a live link opens, for a request with no session. Nothing for a revoked, expired or unknown link.
CREATE FUNCTION share_link_open(p_hash text) RETURNS TABLE (
  link_id uuid, kind text, project_id uuid, org_id uuid, project_name text, snapshot_id uuid, snapshot_name text, cycle integer,
  content_hash text, library_hash text, canon_version text, engine_version text, signature text, signing_key text,
  created_by_name text, created_at timestamptz, expires_at timestamptz, data json, items jsonb, annotations jsonb, frames jsonb,
  approval_id uuid, approval_status text
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT l.id, l.kind, p.id, p.org_id, p.name, s.id, s.name, s.cycle, s.content_hash, s.library_hash, s.canon_version, s.engine_version,
         s.signature, s.signing_key, s.created_by_name, s.created_at, l.expires_at, s.data, s.items, s.annotations, s.frames,
         a.id, CASE WHEN a.id IS NULL THEN NULL ELSE approval_status(a.id) END
  FROM share_links l
  JOIN snapshots s ON s.id = l.snapshot_id
  JOIN projects p ON p.id = l.project_id
  LEFT JOIN LATERAL (SELECT id FROM approvals WHERE snapshot_id = s.id AND withdrawn_at IS NULL ORDER BY created_at DESC LIMIT 1) a ON true
  WHERE l.token_hash = p_hash AND l.revoked_at IS NULL AND l.expires_at > now()
$$;

-- The bytes of the images a live link's snapshot uses, and only those.
CREATE FUNCTION share_link_assets(p_hash text) RETURNS TABLE (file text, mime text, storage text, bytes bytea, sha256 text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT a.file, a.mime, d.storage, d.bytes, a.sha256
  FROM share_links l
  JOIN snapshot_assets a ON a.snapshot_id = l.snapshot_id
  JOIN design_assets d ON d.project_id = a.project_id AND d.file = a.file
  WHERE l.token_hash = p_hash AND l.revoked_at IS NULL AND l.expires_at > now()
$$;

-- ---------------------------------------------------------------- grants

REVOKE ALL ON FUNCTION refuse_update(), copy_person_name(), snapshot_stamp(), snapshot_open(uuid), design_asset_in_use(), approval_requester(uuid),
  approval_mfa_fresh(timestamptz), approval_decision_guard(), approval_status(uuid), org_is_solo(uuid), release_guard(),
  share_link_open(text), share_link_assets(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION snapshot_open(uuid), approval_requester(uuid), approval_status(uuid), org_is_solo(uuid), share_link_open(text), share_link_assets(text) TO rangoli_app;

-- insert only, except withdrawing an approval and revoking a link
GRANT SELECT, INSERT ON snapshots, snapshot_screens, snapshot_assets, approval_decisions, releases, fixes TO rangoli_app;
GRANT SELECT, INSERT ON approvals TO rangoli_app;
GRANT UPDATE (withdrawn_at, withdrawn_by) ON approvals TO rangoli_app;
-- the token hash is never read back
GRANT SELECT (id, project_id, org_id, snapshot_id, kind, label, created_by, expires_at, revoked_at, revoked_by, created_at), INSERT ON share_links TO rangoli_app;
GRANT UPDATE (revoked_at, revoked_by) ON share_links TO rangoli_app;

ALTER TABLE snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshot_screens ENABLE ROW LEVEL SECURITY;
ALTER TABLE snapshot_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE share_links ENABLE ROW LEVEL SECURITY;

-- a token session stays inside the projects its token names
SELECT token_scope_policy(t) FROM unnest(ARRAY['snapshots', 'snapshot_screens', 'snapshot_assets', 'approvals', 'approval_decisions', 'releases', 'fixes', 'share_links']) t;

-- ---------------------------------------------------------------- policies

CREATE POLICY snapshots_read ON snapshots FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
-- a release snapshot is the releaser's; any other is a designer's
CREATE POLICY snapshots_add ON snapshots FOR INSERT TO rangoli_app WITH CHECK (
  created_by = app_uid()
  AND has_capability(project_id, CASE WHEN kind = 'release' THEN 'release' ELSE 'design.edit' END)
);

CREATE POLICY snapshot_screens_read ON snapshot_screens FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY snapshot_screens_add ON snapshot_screens FOR INSERT TO rangoli_app WITH CHECK (snapshot_open(snapshot_id));
CREATE POLICY snapshot_assets_read ON snapshot_assets FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY snapshot_assets_add ON snapshot_assets FOR INSERT TO rangoli_app WITH CHECK (snapshot_open(snapshot_id));

CREATE POLICY approvals_read ON approvals FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY approvals_add ON approvals FOR INSERT TO rangoli_app WITH CHECK (
  requested_by = app_uid() AND app_token_id() IS NULL AND has_capability(project_id, 'design.edit') AND withdrawn_at IS NULL
);
CREATE POLICY approvals_withdraw ON approvals FOR UPDATE TO rangoli_app
  USING (withdrawn_at IS NULL AND app_token_id() IS NULL AND has_capability(project_id, 'design.edit'))
  WITH CHECK (withdrawn_by = app_uid() AND withdrawn_at IS NOT NULL);

CREATE POLICY approval_decisions_read ON approval_decisions FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
-- ARCHITECTURE §3: every role, admins included, and never through a token
CREATE POLICY approval_decide ON approval_decisions FOR INSERT TO rangoli_app WITH CHECK (
  approver_id = app_uid()
  AND app_token_id() IS NULL
  AND has_capability(project_id, 'approve')
  AND approval_requester(approval_id) IS DISTINCT FROM app_uid()
);

CREATE POLICY releases_read ON releases FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY releases_add ON releases FOR INSERT TO rangoli_app WITH CHECK (
  released_by = app_uid() AND app_token_id() IS NULL AND has_capability(project_id, 'release')
);

CREATE POLICY fixes_read ON fixes FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY fixes_add ON fixes FOR INSERT TO rangoli_app WITH CHECK (
  created_by = app_uid() AND app_token_id() IS NULL AND has_capability(project_id, 'design.edit')
);

-- stakeholder links are a designer's to hand out; developer links come with export rights
CREATE POLICY share_links_read ON share_links FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY share_links_add ON share_links FOR INSERT TO rangoli_app WITH CHECK (
  created_by = app_uid() AND app_token_id() IS NULL AND revoked_at IS NULL
  AND has_capability(project_id, CASE WHEN kind = 'developer' THEN 'export.run' ELSE 'design.edit' END)
);
CREATE POLICY share_links_revoke ON share_links FOR UPDATE TO rangoli_app
  USING (revoked_at IS NULL AND app_token_id() IS NULL AND (created_by = app_uid() OR has_capability(project_id, 'members.manage')))
  WITH CHECK (revoked_by = app_uid() AND revoked_at IS NOT NULL);
`,
};
