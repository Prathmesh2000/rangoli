/**
 * The agent platform (PRD §11, ARCHITECTURE §3 "008 agents" and §4, work package 14).
 *
 *  - agent_tasks: notes and tasks people leave for agents. Only a person (no token) holding `task.create` inserts
 *    one, so only those are requests; comments never enter this queue.
 *  - agent_jobs: one per note or task, leased with `FOR UPDATE SKIP LOCKED` so two agents never share a job. A
 *    lease runs 5 minutes, is renewed by the run's writes, and its `lease_token` fences a late writer. Expired
 *    leases are reaped: back to waiting if no run began, Could not complete if one had.
 *  - agent_runs: named runs. One open run per token per project. Every design_ops row an agent writes must name its
 *    open run, and agents never write tokens or components directly (suggestions only).
 *  - frame_owners and page_agent_policies: the facts the write rules need (who made a frame; a team import's
 *    Protected or Draft mode per page).
 *  - items: an agent's claim about people (persona, research, finding, feedback, test session) is held.
 *
 * The queue tables are written only through the SECURITY DEFINER functions below, which check the caller, the
 * token and the status machine (packages/engine/src/notes-tasks.ts) themselves. Like 009's workstreams they are not
 * FORCE'd, because those functions run as the table owner, which on a managed server is not a superuser. The app
 * role reads them through policies and cannot write them at all.
 */
export const MIGRATION_011 = {
  id: '011_agent_platform',
  sql: /* sql */ `
-- ---------------------------------------------------------------- runs

CREATE TABLE agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  no integer NOT NULL CHECK (no > 0),
  agent_name text NOT NULL CHECK (length(agent_name) BETWEEN 1 AND 60),
  token_id uuid REFERENCES api_tokens ON DELETE SET NULL,
  authorized_by uuid REFERENCES users ON DELETE SET NULL,
  authorized_name text,
  intent text NOT NULL CHECK (length(intent) BETWEEN 1 AND 500),
  task_id uuid,
  job_id uuid,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed', 'undone')),
  start_seq bigint NOT NULL CHECK (start_seq >= 0),
  end_seq bigint,
  writes integer NOT NULL DEFAULT 0,
  last_write_at timestamptz,
  summary text CHECK (length(summary) <= 2000),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ended_at timestamptz,
  undone_by uuid REFERENCES users ON DELETE SET NULL,
  undone_by_name text,
  undo_report jsonb,
  UNIQUE (project_id, no),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
-- one open run per token per project
CREATE UNIQUE INDEX agent_runs_one_open ON agent_runs (project_id, token_id) WHERE status = 'running';

-- ---------------------------------------------------------------- notes and tasks

CREATE TABLE agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('note', 'task')),
  page_id text CHECK (length(page_id) <= 80),
  target_node text CHECK (length(target_node) <= 80),
  author uuid REFERENCES users ON DELETE SET NULL,
  author_name text NOT NULL CHECK (length(author_name) BETWEEN 1 AND 80),
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  status text NOT NULL DEFAULT 'waiting_for_agent'
    CHECK (status IN ('waiting_for_agent', 'picked_up', 'run_in_progress', 'done_ready_to_review', 'could_not_complete')),
  agent_name text,
  picked_up_at timestamptz,
  run_id uuid REFERENCES agent_runs ON DELETE SET NULL,
  failure_reason text,
  screen jsonb,
  asset text CHECK (length(asset) <= 80),
  device text CHECK (device IN ('desktop', 'tablet', 'mobile')),
  frame text CHECK (length(frame) <= 80),
  history jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- a note is context about something on the canvas
  CHECK (kind <> 'note' OR target_node IS NOT NULL),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX agent_tasks_project ON agent_tasks (project_id, created_at);

CREATE TABLE agent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  task_id uuid NOT NULL UNIQUE REFERENCES agent_tasks ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'leased', 'done', 'failed')),
  lease_until timestamptz,
  lease_token uuid,
  attempts integer NOT NULL DEFAULT 0,
  token_id uuid REFERENCES api_tokens ON DELETE SET NULL,
  agent_name text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((status = 'leased') = (lease_token IS NOT NULL AND lease_until IS NOT NULL)),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);
CREATE INDEX agent_jobs_waiting ON agent_jobs (project_id, created_at) WHERE status = 'waiting';
CREATE INDEX agent_jobs_leased ON agent_jobs (lease_until) WHERE status = 'leased';

-- ---------------------------------------------------------------- write-rule facts

CREATE TABLE frame_owners (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  frame_id text NOT NULL CHECK (length(frame_id) BETWEEN 1 AND 80),
  owner_id uuid REFERENCES users ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, frame_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

CREATE TABLE page_agent_policies (
  project_id uuid NOT NULL,
  org_id uuid NOT NULL,
  page_id text NOT NULL CHECK (length(page_id) BETWEEN 1 AND 80),
  mode text NOT NULL CHECK (mode IN ('protected', 'draft')),
  imported_by uuid REFERENCES users ON DELETE SET NULL,
  set_by uuid NOT NULL REFERENCES users ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (project_id, page_id),
  FOREIGN KEY (project_id, org_id) REFERENCES projects (id, org_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- access

ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE frame_owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE frame_owners FORCE ROW LEVEL SECURITY;
ALTER TABLE page_agent_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_agent_policies FORCE ROW LEVEL SECURITY;

GRANT SELECT ON agent_runs, agent_jobs TO rangoli_app;
GRANT SELECT, INSERT ON agent_tasks, frame_owners TO rangoli_app;
GRANT SELECT, INSERT, UPDATE ON page_agent_policies TO rangoli_app;

CREATE POLICY agent_runs_read ON agent_runs FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY agent_jobs_read ON agent_jobs FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY agent_tasks_read ON agent_tasks FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
-- only a person allowed to leave requests, never a token, and only in the waiting state
CREATE POLICY agent_tasks_add ON agent_tasks FOR INSERT TO rangoli_app WITH CHECK (
  author = app_uid()
  AND app_token_id() IS NULL
  AND has_capability(project_id, 'task.create')
  AND status = 'waiting_for_agent' AND agent_name IS NULL AND run_id IS NULL AND picked_up_at IS NULL AND failure_reason IS NULL AND history = '[]'::jsonb
);
CREATE POLICY frame_owners_read ON frame_owners FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
CREATE POLICY frame_owners_add ON frame_owners FOR INSERT TO rangoli_app WITH CHECK (owner_id = app_uid() AND has_capability(project_id, 'design.edit'));
CREATE POLICY page_agent_policies_read ON page_agent_policies FOR SELECT TO rangoli_app USING (has_capability(project_id, 'design.view'));
-- a person's decision: agents never loosen their own rules
CREATE POLICY page_agent_policies_add ON page_agent_policies FOR INSERT TO rangoli_app
  WITH CHECK (set_by = app_uid() AND app_token_id() IS NULL AND has_capability(project_id, 'design.edit'));
CREATE POLICY page_agent_policies_change ON page_agent_policies FOR UPDATE TO rangoli_app
  USING (app_token_id() IS NULL AND has_capability(project_id, 'design.edit'))
  WITH CHECK (set_by = app_uid() AND app_token_id() IS NULL AND has_capability(project_id, 'design.edit'));

SELECT token_scope_policy(t) FROM unnest(ARRAY['agent_runs', 'agent_tasks', 'agent_jobs', 'frame_owners', 'page_agent_policies']) t;

-- ---------------------------------------------------------------- the queue

-- The caller is an agent (a live token of this person) on this project, with this scope, that can see the design.
CREATE FUNCTION agent_caller_ok(p_project uuid, p_scope text) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT app_uid() IS NOT NULL AND app_token_id() IS NOT NULL
    AND p_scope = ANY (coalesce(token_scopes_on(p_project), '{}'::text[]))
    AND has_capability(p_project, 'design.view')
$$;

CREATE FUNCTION agent_history(p_from text, p_to text, p_event text, p_actor jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE
AS $$ SELECT jsonb_build_array(jsonb_build_object('from', p_from, 'to', p_to, 'event', p_event, 'actor', p_actor, 'at', (extract(epoch FROM clock_timestamp()) * 1000)::bigint)) $$;

-- Every note and task gets its job when it is left.
CREATE FUNCTION agent_task_job() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  INSERT INTO agent_jobs (project_id, org_id, task_id) VALUES (NEW.project_id, NEW.org_id, NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER agent_tasks_job AFTER INSERT ON agent_tasks FOR EACH ROW EXECUTE FUNCTION agent_task_job();

-- Expired leases: nobody started a run, so the item waits again (until it has been dropped three times); a run had
-- begun, so it becomes Could not complete and the run is closed as failed. Safe for anyone to call: it only ever
-- acts on leases that have already run out. p_project NULL reaps everywhere (the server's reaper).
CREATE FUNCTION agent_jobs_reap(p_project uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j record; t agent_tasks; n integer := 0; reason text;
BEGIN
  FOR j IN SELECT * FROM agent_jobs WHERE status = 'leased' AND lease_until < now() AND (p_project IS NULL OR project_id = p_project)
    ORDER BY lease_until FOR UPDATE SKIP LOCKED
  LOOP
    n := n + 1;
    SELECT * INTO t FROM agent_tasks WHERE id = j.task_id FOR UPDATE;
    IF t.status = 'run_in_progress' OR j.attempts >= 3 THEN
      reason := CASE WHEN t.status = 'run_in_progress' THEN coalesce(t.agent_name, 'The agent') || ' stopped answering: its lease ran out during the run.'
                     ELSE 'Picked up ' || j.attempts || ' times without starting.' END;
      UPDATE agent_jobs SET status = 'failed', lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = j.id;
      UPDATE agent_runs SET status = 'failed', ended_at = now(), summary = coalesce(summary, 'The lease ran out before the run ended.')
        WHERE id = t.run_id AND status = 'running';
      UPDATE agent_tasks SET status = 'could_not_complete', failure_reason = reason, updated_at = now(),
        history = history || agent_history(t.status, 'could_not_complete', 'fail', '{"kind":"system"}')
        WHERE id = t.id AND status IN ('picked_up', 'run_in_progress');
    ELSE
      UPDATE agent_jobs SET status = 'waiting', lease_token = NULL, lease_until = NULL, token_id = NULL, agent_name = NULL, updated_at = now() WHERE id = j.id;
      UPDATE agent_tasks SET status = 'waiting_for_agent', agent_name = NULL, picked_up_at = NULL, updated_at = now(),
        history = history || agent_history(t.status, 'waiting_for_agent', 'release', '{"kind":"system"}')
        WHERE id = t.id AND status = 'picked_up';
    END IF;
  END LOOP;
  RETURN n;
END $$;

-- Lease the oldest waiting job. SKIP LOCKED: an agent racing another takes the next row instead of waiting on it.
CREATE FUNCTION agent_job_claim(p_project uuid, p_agent text, p_lease_seconds integer)
RETURNS TABLE (job_id uuid, lease_token uuid, lease_until timestamptz, attempts integer, task_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j agent_jobs;
BEGIN
  IF NOT agent_caller_ok(p_project, 'jobs') THEN RAISE EXCEPTION 'This token cannot take work from the queue.' USING ERRCODE = '42501'; END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 10 OR p_lease_seconds > 3600 THEN RAISE EXCEPTION 'A lease lasts between 10 seconds and an hour.' USING ERRCODE = 'P0001'; END IF;
  IF length(coalesce(p_agent, '')) NOT BETWEEN 1 AND 60 THEN RAISE EXCEPTION 'Name the agent.' USING ERRCODE = 'P0001'; END IF;
  PERFORM agent_jobs_reap(p_project);
  UPDATE agent_jobs a SET status = 'leased', lease_token = gen_random_uuid(), lease_until = now() + make_interval(secs => p_lease_seconds),
      attempts = a.attempts + 1, token_id = app_token_id(), agent_name = p_agent, updated_at = now()
    WHERE a.id = (SELECT w.id FROM agent_jobs w WHERE w.project_id = p_project AND w.status = 'waiting' ORDER BY w.created_at, w.id FOR UPDATE SKIP LOCKED LIMIT 1)
    RETURNING a.* INTO j;
  IF j.id IS NULL THEN RETURN; END IF;
  UPDATE agent_tasks SET status = 'picked_up', agent_name = p_agent, picked_up_at = now(), updated_at = now(),
    history = history || agent_history('waiting_for_agent', 'picked_up', 'pick_up', jsonb_build_object('kind', 'agent', 'name', p_agent))
    WHERE id = j.task_id AND status = 'waiting_for_agent';
  IF NOT FOUND THEN RAISE EXCEPTION 'The queue is out of step with its item.' USING ERRCODE = 'P0001'; END IF;
  RETURN QUERY SELECT j.id, j.lease_token, j.lease_until, j.attempts, j.task_id;
END $$;

-- The lease is this token's and still live. Used by every later step, so a late writer is fenced out.
CREATE FUNCTION agent_job_held(p_job uuid, p_lease uuid) RETURNS agent_jobs
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j agent_jobs;
BEGIN
  SELECT * INTO j FROM agent_jobs WHERE id = p_job FOR UPDATE;
  IF j.id IS NULL OR j.status <> 'leased' OR j.lease_token IS DISTINCT FROM p_lease OR j.token_id IS DISTINCT FROM app_token_id() OR j.lease_until < now() THEN
    RAISE EXCEPTION 'This job is no longer yours: its lease ran out or it was finished. Claim the next one with job_claim.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT agent_caller_ok(j.project_id, 'jobs') THEN RAISE EXCEPTION 'This token cannot work on the queue.' USING ERRCODE = '42501'; END IF;
  RETURN j;
END $$;

CREATE FUNCTION agent_job_heartbeat(p_job uuid, p_lease uuid, p_seconds integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  PERFORM agent_job_held(p_job, p_lease);
  UPDATE agent_jobs SET lease_until = now() + make_interval(secs => least(greatest(p_seconds, 10), 3600)), updated_at = now() WHERE id = p_job;
  RETURN true;
END $$;

CREATE FUNCTION agent_job_finish(p_job uuid, p_lease uuid, p_status text, p_reason text, p_frame text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j agent_jobs; t agent_tasks; actor jsonb;
BEGIN
  j := agent_job_held(p_job, p_lease);
  SELECT * INTO t FROM agent_tasks WHERE id = j.task_id FOR UPDATE;
  actor := jsonb_build_object('kind', 'agent', 'name', j.agent_name);
  IF p_status = 'done' THEN
    -- the work is reviewable only as a run: nothing is approved by finishing
    IF t.status <> 'run_in_progress' OR t.run_id IS NULL THEN
      RAISE EXCEPTION 'Finish needs a run: call run_start with this job before job_finish.' USING ERRCODE = 'P0001';
    END IF;
    UPDATE agent_tasks SET status = 'done_ready_to_review', frame = coalesce(left(p_frame, 80), frame), updated_at = now(),
      history = history || agent_history(t.status, 'done_ready_to_review', 'finish', actor) WHERE id = t.id;
    UPDATE agent_runs SET status = 'done', ended_at = coalesce(ended_at, now()) WHERE id = t.run_id AND status = 'running';
  ELSIF p_status = 'failed' THEN
    IF length(trim(coalesce(p_reason, ''))) = 0 THEN RAISE EXCEPTION 'Could not complete needs a reason.' USING ERRCODE = 'P0001'; END IF;
    UPDATE agent_tasks SET status = 'could_not_complete', failure_reason = left(p_reason, 1000), updated_at = now(),
      history = history || agent_history(t.status, 'could_not_complete', 'fail', actor) WHERE id = t.id;
    UPDATE agent_runs SET status = 'failed', ended_at = coalesce(ended_at, now()) WHERE id = t.run_id AND status = 'running';
  ELSE
    RAISE EXCEPTION 'A job finishes done or failed.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE agent_jobs SET status = CASE WHEN p_status = 'done' THEN 'done' ELSE 'failed' END, lease_token = NULL, lease_until = NULL, updated_at = now() WHERE id = j.id;
END $$;

-- A person puts failed work back in the queue.
CREATE FUNCTION agent_task_requeue(p_task uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE t agent_tasks;
BEGIN
  SELECT * INTO t FROM agent_tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR app_token_id() IS NOT NULL OR NOT has_capability(t.project_id, 'task.create') THEN RAISE EXCEPTION 'You cannot requeue this.' USING ERRCODE = '42501'; END IF;
  IF t.status <> 'could_not_complete' THEN RAISE EXCEPTION 'Only work that could not be completed goes back in the queue.' USING ERRCODE = 'P0001'; END IF;
  UPDATE agent_tasks SET status = 'waiting_for_agent', agent_name = NULL, picked_up_at = NULL, run_id = NULL, failure_reason = NULL, updated_at = now(),
    history = history || agent_history('could_not_complete', 'waiting_for_agent', 'requeue', jsonb_build_object('kind', 'person', 'id', app_uid()))
    WHERE id = t.id;
  UPDATE agent_jobs SET status = 'waiting', lease_token = NULL, lease_until = NULL, attempts = 0, token_id = NULL, agent_name = NULL, updated_at = now() WHERE task_id = t.id;
END $$;

-- A person takes back an item no agent has picked up.
CREATE FUNCTION agent_task_withdraw(p_task uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE t agent_tasks;
BEGIN
  SELECT * INTO t FROM agent_tasks WHERE id = p_task FOR UPDATE;
  IF t.id IS NULL OR app_token_id() IS NOT NULL OR NOT has_capability(t.project_id, 'task.create') THEN RAISE EXCEPTION 'You cannot withdraw this.' USING ERRCODE = '42501'; END IF;
  IF t.status <> 'waiting_for_agent' THEN RAISE EXCEPTION 'An agent has already picked this up; it can no longer be withdrawn.' USING ERRCODE = 'P0001'; END IF;
  DELETE FROM agent_tasks WHERE id = t.id;
END $$;

-- ---------------------------------------------------------------- runs

CREATE FUNCTION agent_run_start(p_project uuid, p_agent text, p_intent text, p_start_seq bigint, p_job uuid, p_lease uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE j agent_jobs; t agent_tasks; new_id uuid; next_no integer; org uuid;
BEGIN
  IF app_uid() IS NULL OR app_token_id() IS NULL OR NOT has_capability(p_project, 'design.view') OR token_scopes_on(p_project) IS NULL THEN
    RAISE EXCEPTION 'Runs belong to agents working through a token on this project.' USING ERRCODE = '42501';
  END IF;
  IF EXISTS (SELECT 1 FROM agent_runs WHERE project_id = p_project AND token_id = app_token_id() AND status = 'running') THEN
    RAISE EXCEPTION 'A run is already open for this agent. End it with run_end before starting another.' USING ERRCODE = 'P0001';
  END IF;
  IF p_job IS NOT NULL THEN
    j := agent_job_held(p_job, p_lease);
    IF j.project_id <> p_project THEN RAISE EXCEPTION 'That job belongs to another project.' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO t FROM agent_tasks WHERE id = j.task_id FOR UPDATE;
    IF t.status <> 'picked_up' THEN RAISE EXCEPTION 'This item already has a run.' USING ERRCODE = 'P0001'; END IF;
  END IF;
  SELECT org_id INTO org FROM projects WHERE id = p_project;
  -- numbering is per project: serialize run starts there
  PERFORM pg_advisory_xact_lock(hashtextextended('agent_runs:' || p_project::text, 0));
  SELECT coalesce(max(no), 0) + 1 INTO next_no FROM agent_runs WHERE project_id = p_project;
  INSERT INTO agent_runs (project_id, org_id, no, agent_name, token_id, authorized_by, authorized_name, intent, task_id, job_id, start_seq)
  VALUES (p_project, org, next_no, left(p_agent, 60), app_token_id(), app_uid(), (SELECT name FROM users WHERE id = app_uid()), left(p_intent, 500), t.id, j.id, p_start_seq)
  RETURNING id INTO new_id;
  IF t.id IS NOT NULL THEN
    UPDATE agent_tasks SET status = 'run_in_progress', run_id = new_id, updated_at = now(),
      history = history || agent_history('picked_up', 'run_in_progress', 'start_run', jsonb_build_object('kind', 'agent', 'name', t.agent_name))
      WHERE id = t.id;
    UPDATE agent_jobs SET lease_until = now() + interval '5 minutes', updated_at = now() WHERE id = j.id;
  END IF;
  RETURN new_id;
END $$;

CREATE FUNCTION agent_run_end(p_run uuid, p_status text, p_end_seq bigint, p_summary text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_status NOT IN ('done', 'failed') THEN RAISE EXCEPTION 'A run ends done or failed.' USING ERRCODE = 'P0001'; END IF;
  UPDATE agent_runs SET status = p_status, end_seq = p_end_seq, ended_at = now(), summary = coalesce(left(p_summary, 2000), summary)
    WHERE id = p_run AND token_id = app_token_id() AND app_token_id() IS NOT NULL AND authorized_by = app_uid() AND status = 'running';
  IF NOT FOUND THEN RAISE EXCEPTION 'That run is not yours to end, or it has already ended.' USING ERRCODE = 'P0001'; END IF;
END $$;

-- A write in a run: counted, and a heartbeat for the job it serves.
CREATE FUNCTION agent_run_note_write(p_run uuid, p_writes integer) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r agent_runs;
BEGIN
  UPDATE agent_runs SET writes = writes + greatest(p_writes, 0), last_write_at = now()
    WHERE id = p_run AND token_id = app_token_id() AND app_token_id() IS NOT NULL AND status = 'running'
    RETURNING * INTO r;
  IF r.job_id IS NOT NULL THEN
    UPDATE agent_jobs SET lease_until = greatest(lease_until, now() + interval '5 minutes'), updated_at = now()
      WHERE id = r.job_id AND status = 'leased' AND token_id = app_token_id();
  END IF;
END $$;

-- Whether this token has this run open on this project: every agent write must name one.
CREATE FUNCTION agent_run_open(p_project uuid, p_run uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (SELECT 1 FROM agent_runs WHERE id = p_run AND project_id = p_project AND token_id = app_token_id() AND authorized_by = app_uid() AND status = 'running')
$$;

-- Undo whole run is a person's: never through a token, and only with design.edit.
CREATE FUNCTION agent_run_mark_undone(p_run uuid, p_report jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE r agent_runs;
BEGIN
  SELECT * INTO r FROM agent_runs WHERE id = p_run FOR UPDATE;
  IF r.id IS NULL OR app_token_id() IS NOT NULL OR NOT has_capability(r.project_id, 'design.edit') THEN RAISE EXCEPTION 'Only a person who can edit the design undoes a run.' USING ERRCODE = '42501'; END IF;
  IF r.status = 'running' THEN RAISE EXCEPTION 'The run is still open.' USING ERRCODE = 'P0001'; END IF;
  IF r.status = 'undone' THEN RAISE EXCEPTION 'The run was already undone.' USING ERRCODE = 'P0001'; END IF;
  UPDATE agent_runs SET status = 'undone', undone_by = app_uid(), undone_by_name = (SELECT name FROM users WHERE id = app_uid()), undo_report = p_report WHERE id = r.id;
END $$;

-- ---------------------------------------------------------------- what the write rules and the connect flow read

-- A one-person organization: its frames are edited directly on the working copy.
CREATE FUNCTION project_is_solo(p_project uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT has_capability(p_project, 'design.view') AND (SELECT count(*) FROM org_members m JOIN projects p ON p.org_id = m.org_id WHERE p.id = p_project) = 1
$$;

-- Everyone's agent connections on a project, for people on it (never through a token): whose token, when it was last
-- used, whether it has expired. Hashes and scopes of other people's tokens are not part of it.
CREATE FUNCTION project_agent_connections(p_project uuid)
RETURNS TABLE (token_id uuid, token_name text, owner_id uuid, owner_name text, last_used_at timestamptz, expires_at timestamptz, revoked_at timestamptz, mine boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
  SELECT t.id, t.name, t.user_id, u.name, t.last_used_at, t.expires_at, t.revoked_at, t.user_id = app_uid()
  FROM api_tokens t JOIN users u ON u.id = t.user_id
  WHERE app_token_id() IS NULL AND has_capability(p_project, 'design.view')
    AND p_project = ANY (t.project_ids)
    AND EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p_project AND pm.user_id = t.user_id)
    AND coalesce(t.revoked_at, t.expires_at) > now() - interval '30 days'
  ORDER BY (t.user_id = app_uid()) DESC, t.last_used_at DESC NULLS LAST
$$;

-- ---------------------------------------------------------------- the database's part of the write rules

-- An agent's design change names its open run, and never writes tokens or components (those are suggestions).
CREATE POLICY design_ops_agent_runs ON design_ops AS RESTRICTIVE FOR INSERT TO rangoli_app WITH CHECK (
  app_token_id() IS NULL OR (
    run_id IS NOT NULL AND agent_run_open(project_id, run_id)
    AND NOT EXISTS (SELECT 1 FROM unnest(touched) x WHERE x = '$tokens' OR x LIKE '$component:%')
  )
);

-- An agent's claim about people is held until a person accepts it.
CREATE POLICY items_agent_claims_add ON items AS RESTRICTIVE FOR INSERT TO rangoli_app WITH CHECK (
  app_token_id() IS NULL OR kind NOT IN ('persona', 'research', 'finding', 'feedback', 'test_session') OR status = 'held'
);
CREATE POLICY items_agent_claims_change ON items AS RESTRICTIVE FOR UPDATE TO rangoli_app USING (true) WITH CHECK (
  app_token_id() IS NULL OR kind NOT IN ('persona', 'research', 'finding', 'feedback', 'test_session') OR status = 'held'
);

-- ---------------------------------------------------------------- grants

REVOKE ALL ON FUNCTION agent_caller_ok(uuid, text), agent_history(text, text, text, jsonb), agent_task_job(), agent_jobs_reap(uuid),
  agent_job_claim(uuid, text, integer), agent_job_held(uuid, uuid), agent_job_heartbeat(uuid, uuid, integer), agent_job_finish(uuid, uuid, text, text, text),
  agent_task_requeue(uuid), agent_task_withdraw(uuid), agent_run_start(uuid, text, text, bigint, uuid, uuid), agent_run_end(uuid, text, bigint, text),
  agent_run_note_write(uuid, integer), agent_run_open(uuid, uuid), agent_run_mark_undone(uuid, jsonb), project_is_solo(uuid), project_agent_connections(uuid)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION agent_jobs_reap(uuid), agent_job_claim(uuid, text, integer), agent_job_heartbeat(uuid, uuid, integer), agent_job_finish(uuid, uuid, text, text, text),
  agent_task_requeue(uuid), agent_task_withdraw(uuid), agent_run_start(uuid, text, text, bigint, uuid, uuid), agent_run_end(uuid, text, bigint, text),
  agent_run_note_write(uuid, integer), agent_run_open(uuid, uuid), agent_run_mark_undone(uuid, jsonb), project_is_solo(uuid), project_agent_connections(uuid)
TO rangoli_app;
`,
};
