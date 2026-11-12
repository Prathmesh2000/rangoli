# Rangoli: architecture and implementation plan

**Status:** proposal for founder review, 9 November 2026. **Readers:** engineers and coding agents.

**Paths:** `srv/` = `packages/server/src`, `eng/` = `packages/engine/src`, `ed/` = `packages/editor/src`.

**Evidence:** section 0 is verified by reading code at file:line. Nothing was executed or benchmarked, so exploit paths are code-read, and every budget is a target to confirm. Everything outside section 0 is judgement unless cited.

## 0. Verified facts

|#|Fact|Source|
|---|---|---|
|V1|`token_set` walks a caller-supplied dotted path with no key check. `__proto__.x` writes to `Object.prototype`, shared by every tenant in the process. A designer's token reaches it|`srv/mcp.ts:395-400`, `srv/app/server.ts:35`|
|V2|Token strings go raw into `<style>`, so `</style>` breaks out into HTML|`eng/tokens.ts:164`, `ed/Canvas.tsx:45`, `srv/shots.ts:56`|
|V3|`sanitizeCss` matches literal `url(` but allows backslashes. CSS escapes (`u\72l(`) and `image-set("...")` pass|`eng/rdl.ts:384`|
|V4|Chromium runs user content with `--no-sandbox`, JS and network on, in the app's container. That process holds the DB owner password. Tasks have public IPs|`srv/shots.ts:34,56`, `Dockerfile`, `srv/cli.ts:94-96`, `deploy/aws/rangoli.yaml:292,361`|
|V5|Screenshot asset resolver is a module global, set per tool call and read after awaits: a cross-tenant race|`srv/shots.ts:20-23,64-67`, `srv/app/server.ts:197`|
|V6|An agent bearer token reaches every design REST route, not just `/mcp`. It can accept suggestions and switch agent mode. `viaToken` is checked only at `/mcp`|`srv/app/server.ts:830-853`, `srv/design-routes.ts:145,337,383`|
|V7|API tokens have no scope, project or expiry. Password reset deletes sessions, not tokens|`srv/app/schema.ts:49-56`, `srv/app/migration-002.ts:89-90`|
|V8|Admins and reviewers skip the self-approval check in the database and server. Sign-offs cascade on user delete|`migration-002.ts:40-45`, `server.ts:584`, `schema.ts:204`|
|V9|Login throttle is in memory and keyed email+IP, so spraying across emails is unthrottled. Signup has none. No email verification or MFA|`srv/app/auth.ts:30`, `server.ts:779`|
|V10|`rangoli_app` can execute a function returning password hashes, contradicting the schema's header comment|`schema.ts:8,258-260,380`|
|V11|Runtime third-party code: esm.sh, including `scene3d`, which the plan omits. Also Iconify and Google Fonts. Hosted CSP allows none of them|`ed/IconStudio.tsx:188-189,344-345`, `ed/VectorEditor.tsx:67-68`, `eng/scene3d.ts:11`, `eng/fonts.ts:122,126`, `server.ts:27`|
|V12|Local editor has no CSP. Loopback equals owner. LAN share tokens live in URLs until the server stops|`srv/http.ts:68-72,89`, `srv/cli.ts:67`|
|V13|Rendered hosted pages use an opaque-origin sandbox (good) but no network policy, so content can leave|`srv/design-routes.ts:17`, `ed/Run.tsx:54`|
|V14|Each edit: full save after 150 ms; every client refetches the document, relints and rewrites the canvas with `innerHTML`|`srv/session.ts:174`, `srv/app/store.ts:50`, `ed/store.ts:213-216,242-246`, `ed/Canvas.tsx:45,171`|
|V15|History is in memory, `seq` restarts on load, undo pops the last change by any author|`eng/document.ts:59-61,207-208`, `srv/mcp.ts:264`|
|V16|`update` patches top-level keys, so `style` is one unit. `setTokens` stores the whole tree twice per edit|`eng/document.ts:255-259,321-325`, `srv/mcp.ts:405`|
|V17|No overrides or rich text in the model. Asset ids are SHA-256 cut to 48 bits|`eng/model.ts:140-167`, `srv/session.ts:393`|
|V18|One task, stop-first deploys, process advisory lock, pool of 10. Migrations run at boot as owner|`rangoli.yaml:352,355-357`, `srv/app/db.ts:51,81,108-109,129`, `srv/cli.ts:102`|
|V19|Queue has no lease. Version list is a mutable blob. Handoff reads live data. `warmAssets` loads all bytes to RAM|`srv/session.ts:321-327,359`, `server.ts:692`, `srv/app/store.ts:91-103`|
|V20|Engine and server declare MIT, no LICENSE file exists, the editor bundles engine source, source maps are off, git has one author (17 commits)|package files, `packages/editor/vite.config.ts`|
|V21|Bodies concatenate Buffers into a string per chunk, so a split multi-byte character corrupts input|`server.ts:717`, `srv/design-routes.ts:81`|
|V22|`paintCss` and grid templates emit raw strings. Only RDL validates them; direct ops and future import bypass it|`eng/render.ts:49,280`, `eng/rdl.ts:337`|
|V23|MCP 2026-07-28 removes protocol sessions; secondary sources, confirm in the [changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog). Rangoli stores sessions in memory (`design-routes.ts:92`)|[MCP blog](https://blog.modelcontextprotocol.io/tags/protocol/)|

**Corrections to the plan**

1. "RLS is the boundary" holds for rows, not open documents. `/api/doc` serves process memory after one access check (`design-routes.ts:246`). V1 and V5 cross that boundary. Plan process isolation accordingly.
2. The earlier review says bearer scope is why agents can't approve. True for sign-off, but V6 means "agents draft, people decide" isn't enforced today.
3. The 5 ms edit budget can't include a durable commit. Section 4 separates apply from commit.
4. "Last-writer-wins per property" and "skip properties others changed" need path-level patches (V16).
5. Downloadable-JSON import for local mode ships the parser, conflicting with section 7.
6. R1 is about 94 engineer-weeks, not 62.5-66.5 (section 10).
7. WebSocket appears in R2 (plan section 6) and R3 (plan section 9, PRD section 15). Use R3.

## 1. Target architecture

```
Browser editor (React + DOM canvas)     Agents (Claude, Cursor)      Figma plugin
   | HTTPS, SSE (R3 WS)                     | MCP, Bearer                 | import token
ALB + WAF -> CloudFront (static, snapshots on a separate user-content domain)
   |
App service: identity | access | design core (one writer per project) | agent gateway | import
   |                    Worker threads: lint, hash, serialize
Postgres (RLS)   S3 (assets, snapshots, archives)
   ^ jobs with leases
Render service: Chromium, no DB or AWS credentials, egress denied; signed one-use inputs
Job runner: outbox, mail, compaction, retention
```

**Stays:** DOM and shadow DOM canvas, RDL as the single edit path, Postgres RLS, `DesignStore`/`BlobStore`/`Mailer` ports, TypeScript monorepo, PGlite local mode, ECS.

**Changes**

|Area|Change|
|---|---|
|`srv/app/server.ts` (945 lines)|Split into `http/`, `identity/`, `access/`, `projects/`, `reviews/`, `agents/`, `import/`. Modules talk through exported services; only `access` and `db` issue identity-bound queries|
|`session.ts`|Becomes `ProjectActor`, the single writer: validate, apply, append, ack, publish|
|`shots.ts`, `imaging.ts`|Move behind a `Renderer` port, implemented by the render service|
|`eng/`|Add `ops/validate`, `ops/normalize`, `hash/`, page-scoped loading|
|Agent access|Org-level MCP endpoint, stateless. Tokens restricted to `/mcp` and import routes|
|Editor|Rebuild shell to `docs/design/direction.md`; ops-driven store; retained frames|

|Layer|Choice|Why|Rejected|
|---|---|---|---|
|Runtime|Node 24 LTS now; review 26 after its first LTS patches ([schedule, secondary](https://endoflife.date/nodejs))|Node 20 is past end of life, yet `engines` allows it|Bun, Deno: no benefit worth the migration|
|HTTP|`node:http` with a small typed router|Existing and little route surface|Express, Fastify, Nest: migration cost, no capability gained|
|DB|PostgreSQL 18 on RDS, upgrading from 17 (`rangoli.yaml:141`; [versions](https://endoflife.date/postgresql))|RLS, `SKIP LOCKED`, `uuidv7`, FTS|Mongo, Dynamo: lose RLS; Supabase: Rangoli already owns auth|
|DB access|Raw parameterized SQL through `withActor`|RLS context is explicit|Prisma, Drizzle: risk around `SET LOCAL` and policies|
|Queue|Postgres with leases|Transactional with state; ample at this volume|SQS, Kafka: second system now; SQS reconsidered above 200 jobs/s|
|Cache, pubsub|None until multi-instance; Redis only for shared rate limits at scale-out|One owner per project needs no fan-out|Early Redis|
|Live|SSE carrying ops; `ws` in R3|R1 has one active editor|Socket.IO, Yjs, Loro|
|Editor|React 18, `useSyncExternalStore`|Existing; canvas is outside React|Redux; React 19 upgrade waits for R2|
|Canvas|DOM, shadow root, frame fragments|Canvas equals export; text and layout are free|WebGL editor|
|Render|Playwright-core + bundled Chromium in its own container|Existing renderer is the reference|Sharp alone: can't render designs|
|Fonts, icons|Self-hosted Instrument Sans and JetBrains Mono; proxy with allowlist|PRD no-third-party rule|Direct Google or Iconify|
|Hosting|AWS ECS, RDS, S3, CloudFront, WAF, KMS, SES|Existing template|Kubernetes: no team to run it|
|Observability|OpenTelemetry, pino, Sentry|Vendor-neutral|Building a logging stack|

## 2. Design patterns

|Pattern|Where|Note|
|---|---|---|
|Command with inverse|`eng/document.ts` `Op`|Exists. Add path patches, `patchTokens`, schema validation at `apply`|
|Operation log + checkpoint|`srv/design/log.ts`, `design_ops`|Design documents only|
|Single writer per aggregate (actor)|`ProjectActor`|Total order per project; no locks in memory|
|Read models (limited CQRS)|`screen_hashes`, `design_profiles`, heatmap rollups|Derived by jobs; ordinary reads stay ordinary|
|Ports and adapters|`DesignStore`, `BlobStore`, `Mailer`, `Database`, new `Renderer`, `RateLimiter`|Same core for hosted and local|
|Transactional outbox|`outbox` written with the state change|Mail, notifications, webhooks, Jira; at-least-once with idempotency keys|
|Queue with leases and fencing|`agent_jobs`, `render_jobs`|Section 4|
|Capability authorization|`has_capability`, `authorize()` from one table|Replaces about 84 role-name sites|
|Anti-corruption layer|`import/figma/`|Figma types never enter `eng/`|
|Content addressing|Assets, snapshots|Full SHA-256|

**Refused**

|Pattern|Why|
|---|---|
|Event sourcing for everything|Org and item data are simple CRUD; replay would add cost and GDPR deletion pain|
|CRDT|Server ordering is enough; offline editing isn't a goal|
|Microservices|One author today. The only split is Render, for security|
|GraphQL, DI framework, ORM|No problem they solve here|
|One IR, four emitters, in R1|PRD chose agents for framework code. Build it when native emitters trigger|

## 3. Data model and migrations

Each migration: expand first, backfill in batches, contract one release later. New functions need explicit `REVOKE`/`GRANT` (`migration-002.ts:94-95`). Every tenant table has `org_id`, composite FK to `projects`, RLS enabled and forced.

|Migration|Adds or changes|
|---|---|
|003 security|Approval policy fix; tokens gain `org_id`, `project_ids`, `scopes`, `expires_at`, `revoked_at`; reset revokes tokens; `rangoli_auth` role owns credential functions; `users.email_verified_at`, `mfa_secret_enc`, `mfa_recovery`; `auth_sessions.last_seen_at`, `mfa_at`, `absolute_expires_at`|
|004 roles|`org_members.role` to owner/admin/member (`orgs.owner_id`, partial unique index, grandfather existing multi-org owners); `project_members.role`, `is_approver`; `role_capabilities(role, capability)`; `has_capability(project, cap)`|
|005 work|`workstreams` (Main backfilled per project, cycle); nullable `workstream_id` on items, events; `screen_frames(screen_id, device, w, h, page_id, frame_node)`; project cap inside `create_project` under org row lock|
|006 ops|`design_pages(project_id, page_id, data json, seq)`; `designs.data` keeps manifest and library; `design_ops`; `design_checkpoints`|
|007 approval|`snapshots`, `snapshot_screens`, `snapshot_assets`, `approvals`, `approval_decisions`, `releases`|
|008 agents|`agent_tasks`, `agent_jobs`, `agent_runs`, `suggestions`|
|009 knowledge|`knowledge_entries`, `design_profiles`|
|010 platform|`outbox`, `render_jobs`, `feature_flags`, `assets`|

|Table|Key columns and rules|
|---|---|
|`design_ops`|PK `(project_id, seq bigint)`; `page_id`, `actor_kind` (human, agent, system), `actor_id`, `token_id`, `run_id`, `ops json`, `inverse json`, `touched text[]`, `created_at`. Insert only. `json` because nothing queries inside it; `touched` has a GIN index|
|`design_checkpoints`|`(project_id, page_id, seq)`, `s3_key` or inline `data`, `hash`. Written every 500 ops, 5 MB of ops, or snapshot|
|`snapshots`|`id uuid`, project, workstream, `name`, `seq`, `content_hash`, `library_hash`, `s3_key`, frozen items and annotations, `canon_version`, `created_by`, `kind` (review, baseline, release). Insert only, no UPDATE grant|
|`snapshot_screens`|`(snapshot_id, screen_id, device)`, `screen_hash`, `deps json`|
|`snapshot_assets`|`(snapshot_id, sha256)`; FK from `assets` with `ON DELETE RESTRICT` blocks deleting used assets|
|`assets`|`(project_id, sha256 char(64))`, `mime`, `size`, `w`, `h`, `storage`, `scan_status`. Backfill computes full hash from bytes; old 12-character ids stay as aliases|
|`approval_decisions`|`approval_id`, `approver_id` nullable (`SET NULL`), `approver_name` copied, `decision`, `note`, `mfa_at`, `created_at`|
|`agent_tasks`|`kind` (note, task), `target_node`, `author`, `body`, `status`, `claimed_run`|
|`agent_jobs`|`task_id`, `status`, `lease_until`, `lease_token uuid`, `attempts`. Partial index `(project_id, created_at) WHERE status='waiting'`|
|`agent_runs`|`id`, project, `agent_name`, `token_id`, `authorized_by`, `intent`, `start_seq`, `end_seq`, `status`|
|`knowledge_entries`|`layer`, `scope_kind`, `scope_id`, `body`, `source`, `snapshot_id`, `status`, `activated_by`, `supersedes`, `last_confirmed`, `search tsvector`; activation requires `token_id` empty|

**Migration rules.** Old sign-offs stay read-only as "legacy, not version-bound". Move the `reviews` blob out in 008. Drop `projects.stage`, `cycle` one release later.

**RLS core**

```sql
CREATE POLICY approval_decide ON approval_decisions FOR INSERT TO rangoli_app WITH CHECK (
  approver_id = app_uid()
  AND app_token_id() IS NULL                        -- agents never approve
  AND has_capability(project_id, 'approve')
  AND approval_requester(approval_id) <> app_uid()  -- every role, admins included
);
```

`withUser` becomes `withActor(db, {userId, tokenId, kind})`, setting `app.user_id` and `app.token_id` with `set_config(..., true)`. `has_capability` intersects role, token scope and write rule.

## 4. Algorithms and data structures

N = nodes on a page, D = depth, T = tokens, F = frame size. Budgets are targets on a 4-core laptop or 2 vCPU task, to be set by the R1 benchmark.

|Problem|Decision|Complexity|Budget|
|---|---|---|---|
|Op log (V14, V15)|Apply in memory, append with group commit (10-25 ms window per project), ack after commit, compensate with inverse on failure|O(ops)|Engine apply p95 under 5 ms; commit ack p95 under 40 ms|
|Compaction|Checkpoint per page; load = checkpoint + tail. Archive ops older than 90 days to S3 unless an open run needs them|Load O(N + tail)|Open 5k-layer page under 300 ms server-side; tail never over 500|
|Patch normal form (V16)|At append, convert `style`/`layout`/`size` patches to JSON-path sets, and `setTokens` to `patchTokens` by diff|O(changed keys)|Median op under 1 KB|
|Incremental render|Dirty set: `touched` to root frame via parents; token change swaps variables only; component or asset change uses the dependency index. Re-render dirty frame fragments; node-patch only in the frame being typed in|O(touched·D + F dirty) vs today's O(N)|500-node frame patch p95 under 8 ms; no caret loss|
|Styles|`CSSStyleSheet.replaceSync` + `adoptedStyleSheets` per frame|Stylesheet per dirty frame|Removes `<style>` breakout from the editor|
|Spatial index|R-tree of frame bounds (`rbush`), plus nodes of the active frame for marquee and snapping. Bounds come from browser layout, batched on resize|Query O(log n + k)|Query under 1 ms at 50k entries; rebuild per frame under 4 ms|
|Culling|Frames beyond 1.5 viewports unmount to placeholders; `contain: layout paint style`; rasters under 25% zoom|Visible only|Pan and zoom p95 under 16 ms to 5k; under 32 ms to 50k|
|Child order|Keep `children: string[]`. R1 uses server-ordered indexes. R3 ops carry `after: siblingId`, resolved at the sequencer|O(k) per move, k = siblings|No fractional keys: the single writer gives total order|
|Content hash|SHA-256 over canonical JSON (sorted keys, normalized numbers, `canon_version`). Node hash = H(fields, ordered child hashes)|O(D) per edit|Hash per edit under 1 ms|
|Screen hash|H(subtree root, sorted closure of resolved token values, component definitions, full asset hashes, icons, motion and interactions). Token edits covered by resolved values|Closure O(deps)|100-screen snapshot under 500 ms on a worker|
|Token invalidation|Flat before/after diff; reverse alias graph; inverted index `dep -> frames`|O(T + affected)|Token edit marks changes under 10 ms|
|Diff|Compare screen hashes, descend only where unequal. Replace the full walk in `eng/review.ts:112`|O(changed·fanout·D)|5k-layer compare under 100 ms|
|Rebase (R3)|Server order, per-path last-writer-wins. Delete vs update: delete wins, update reported. Move into deleted parent or cycle: rejected, client rolls back|O(pending)|Convergence by property test|
|Whole-run undo|Walk run ops in reverse; skip paths written later by non-run actors using `path -> lastSeq` built from the tail|O(run + tail)|Report: "2 changes stayed"|
|Queue claim|`UPDATE ... WHERE id = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)`, lease 5 min, heartbeat on run writes, reaper each minute, `lease_token` fences late writers|O(log n)|Under 10 ms; 2 agents never share a job|
|`agent_wait`|Bounded 25 s wait on in-process wake, no DB connection held|Idle|Does not consume pool|
|Search (R2)|`tsvector` + GIN, `pg_trgm` for names, under RLS. No vectors: no AI inside|O(log n + k)|p95 under 150 ms|
|Heatmap (R3)|Clicks as frame-relative coordinates; job rolls up to sparse 64x64 grid per snapshot, screen, device; browser blurs|Write O(1); read O(cells)|Under 100 ms|
|Kolam|Pure function of first 16 hash bytes, no `Math.random`. Mirror-curve on odd N grid with 4-fold symmetry; union-find merges strands into one loop. Versioned `kolam@1`; golden tests pin output|O(N²)|SVG under 2 ms. Decorative: the hash is the proof|
|Large documents|Lazy pages; server LRU by bytes, capped at 60% heap; global `id -> page` map replaces `findNode`'s page scan; presigned asset URLs replace `warmAssets`|Active page only|50k-node page under 150 MB on server|

**Don't optimize yet:** binary op encoding, WASM, node-level patching outside the active frame, table partitioning (trigger: `design_ops` above 50 GB), WebGL (beyond 50k layers, measured), lint incrementalism (scope by root first; `lint` already accepts roots).

## 5. Performance and scaling

|Surface|Budget|
|---|---|
|App shell|Initial JS under 350 KB gzip. Icon pack and studios are lazy (`dist` has 832 KB and 639 KB chunks)|
|Snapshot create|p95 under 2 s, async with job status|
|Stakeholder first paint|Under 1.5 s from CDN on a phone|

**Caching.** Hashed editor assets immutable on CloudFront. Snapshots are pre-rendered static HTML on the user-content domain, keyed by hash. Assets use short-lived presigned URLs after an RLS row check. Never cache authorization.

**Pooling.** Never hold a transaction across Chromium, S3 or a wait. PgBouncer transaction mode suits `SET LOCAL`; test RDS Proxy for pinning first.

**Scale steps**

|Step|Trigger (sustained 15 min)|Action|
|---|---|---|
|1|Now|Move Chromium out; worker threads for lint, hash, serialize|
|2|Event-loop p99 above 50 ms, or heap above 70% on 4 vCPU/16 GB|Larger task first|
|3|Step 2 exhausted, or more than 300 concurrently open projects|Replace advisory lock (`db.ts:81`) with `project_leases(project_id, owner, epoch, expires_at)`. Append checks `epoch`, fencing stale writers. Any node forwards to the owner by internal proxy|
|4|Pool wait p95 above 20 ms|PgBouncer, then read replica for non-design reads only|
|5|Render queue wait p95 above 10 s|Scale render service|
|6|RDS CPU above 60% or ops above 50 GB|Partition `design_ops` by hash, larger instance, then shard by org|

The advisory lock forces stop-first deploys (`rangoli.yaml:355-357`), so each deploy is an outage of seconds to a minute until step 3.

**Rough cost at partner scale (unmetered):** $350-600 per month. Later drivers: render CPU, CDN egress, S3, RDS size, logs.

## 6. Security

No system can be made unhackable. The aim is that one failure doesn't become a tenant-wide breach, and that it's detected and recoverable.

|Threat|Controls|When|
|---|---|---|
|Cross-tenant through shared process (V1, V5)|Reject `__proto__`, `prototype`, `constructor`; `Object.create(null)` for parsed trees; validate paths; pass resolver as a parameter; freeze `Object.prototype` in production after boot|Now|
|Tenant isolation|RLS forced; catalog test that every table has `org_id`, policies and no broad grants; attack matrix of role, table, verb, org; `rangoli_login` never owner; migrations as a separate job, removing `DB_OWNER_PASSWORD` from the app (V4)|R1|
|Self-approval (V8)|Section 3 policy; server checks mirror; decisions keep names; step-up re-auth within 5 minutes of Approve|Now/R1|
|Agent reaching human actions (V6)|Tokens allowed only on `/mcp` and import paths. Suggestion accept, mode, members, approvals are cookie-only. Tool allowlist replaces `HOST_DISK_TOOLS` and `DESIGN_WRITE_TOOLS` denylists|Now|
|Auth|Verified email before invites, tokens or approval; TOTP MFA (WebAuthn R2), required for team approvers; breached-password check; throttle by email, IP and globally; `__Host-` cookie, 14-day absolute and 24-hour idle limits, rotation on privilege change|R1|
|Tokens|Hashed, project-scoped, 90-day default expiry, revocable; scopes read, propose, draft, items, export, jobs|R1|
|XSS from designs, Figma, SVG (V2, V3, V22)|One `validateOp` at `apply` and `hydrate`: enums, typed colours and lengths; token values parsed by type; `sanitizeCss` becomes a property and value allowlist rejecting backslashes and URL-bearing functions; SVG uploads re-serialized or rasterized; Figma JSON schema-validated with size caps|Now/R1|
|Layer scripts|Never in editor, snapshots, stakeholder links, or test links. Run stays `sandbox="allow-scripts"` on the user-content domain with CSP `connect-src 'none'`|R1|
|CSP|App: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: <asset-cdn>; font-src 'self'; connect-src 'self'; frame-src <user-content>; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`, plus Trusted Types in R2. Snapshot pages: `default-src 'none'; img-src <cdn> data:; style-src 'unsafe-inline'; font-src <cdn>; sandbox`. Bundling (below) resolves the block on studios without weakening the policy|R1|
|SSRF: icon, font proxy; `url` paints; `fontface url=`|Proxy accepts collection and family names, never a URL; pinned hosts, private ranges rejected, no redirects, size and time caps. External paints and fonts are copied to assets at save; the renderer never fetches them|R1|
|Upload parsing, bombs|Sniff magic bytes and refuse mismatches; 40 MP limit before decode; decode only in render service; AVIF branch in `probe`|R1|
|Headless browser|Separate ECS service; drop `--no-sandbox`, using EC2 with gVisor if Fargate can't. No DB, AWS role limited to one prefix, egress denied; request interception allows only `data:` and signed input; JS off unless 3D; 30 s timeout, restart after 200 jobs|R1, before public launch|
|MCP abuse|Per-token and per-org quotas; run and script size caps; per-call access recheck (exists, `server.ts:188`); new tools denied by default|R1|
|Prompt injection|Comments, node text, transcripts, tickets and mail return in JSON fields marked `untrusted`. Only `agent_tasks` from people with `task.create` are requests; today any reviewer's `@agent` comment enters `inbox` (`session.ts:258`), a confused deputy. Capabilities bound agents, not trust in models. Only a person activates knowledge|R1|
|Share links|256-bit, hashed, snapshot-only, 30-day default expiry, revocable, `noindex`, no `Referer`; approving needs verified identity; per-link rate limits|R1|
|CSRF, DNS rebinding, local|Keep same-origin rules; CSP on local editor; local MCP token; one-time exchange replaces `?t=`|R1|
|DoS|WAF rate rules; per-user limits on Chromium, scrypt, uploads, `GET /api/compose`; route body limits; byte-safe parser (V21)|R1|
|Supply chain|Remove esm.sh; `npm ci --ignore-scripts`; dependency scanning; base images pinned by digest; SBOM; signed images; licence audit of bundled libraries|R1|
|Secrets, encryption|Secrets Manager, rotated; KMS keys for S3 and RDS; verified TLS to RDS (exists); envelope encryption for MFA secrets, third-party tokens, transcripts; no public task IPs (V4)|R1|
|Interview privacy|Capability `transcript.read`, never agents; consent recorded; retention schedule; hard delete across S3, archives (30-day purge); test sessions never store keystrokes|R2|
|Audit|Append-only `audit_log` with per-org hash chain; export to WORM S3 daily; record approvals, role changes, token use, exports, support access|R1, UI R2|
|Backup, recovery|Section 8. Backups encrypted, copied to a separate account; restore tested|R1|
|Scanning, testing|Semgrep, gitleaks, Trivy in CI; ZAP on staging; external pen test before public launch and yearly; `SECURITY.md`, disclosure mailbox|R1|
|Incident response|Runbook, on-call, kill switches (agent writes, share links, signups), 72-hour GDPR clock|R1|
|Compliance|SOC 2 Type I after R1, Type II in R2; DPA, sub-processor list, data map, DSAR tooling; ISO 27001 after SOC 2|R1 start|

**Bundle, don't relax.** Add `paper`, `imagetracerjs`, `svg2ttf`, `ttf2woff` and `three` as lazy-loaded dependencies. Exported HTML vendors `three`.

**Must exist before public launch, ranked**

1. V1, V2, V3, V5, V6, V21 fixed, with regression tests
2. Chromium isolated, egress denied, owner password out of the app
3. Self-approval closed at database level, agents refused approvals by RLS
4. Scoped tokens, reset revokes tokens, verified email, shared throttling
5. RLS attack matrix green in CI, catalog test
6. Op validation, CSP per surface, snapshot pages without scripts
7. Backup restore tested, audit export, private subnets, WAF
8. External pen test fixed to no critical or high, incident runbook, disclosure channel

Items 1-3 also block partner use with real files.

## 7. Reverse engineering and intellectual property

**Plainly:** JavaScript delivered to browsers can be read. Anything in a local package can be read. Obfuscation slows a reader; it doesn't stop one. The current packaging goes the other way: `packages/engine` and `packages/server` declare MIT (V20), which grants the right to copy, modify, sell and sublicense. The planned `npx rangoli` would ship the engine, RDL parser, MCP server, lint and patterns under that grant. Any version already published stays MIT forever for those who received it; I couldn't check npm from here, so confirm that. With one author, relicensing is simple today and hard after outside contributions.

**What protects the business, in order:** hosted approval records and accumulated Knowledge; server-only logic and secrets; import fidelity tuned on real files; pace of release; licence and terms, which give legal remedies code cannot.

|Logic|Location|
|---|---|
|Figma parser, Health Report scoring, design profile|Server only|
|Proof hashes, approval, snapshot signing|Server only|
|Extended lint packs, project lint rules|Server only (already served by `/api/lint`)|
|Export emitters and verification harness|Server only|
|All secrets and API keys|Server only; none in bundles|
|Renderer, op apply, RDL preview|Must stay in browser: canvas speed and the compare view depend on it (`ed/store.ts:383`)|
|Design rules, tool descriptions|Readable by any connected agent by design|

**Build policy.** Keep minification and `sourcemap: false`. Upload hidden maps to the error tracker, never deploy them. Split entry points so server-only modules are absent from the bundle, with a CI marker-string check. Remove `.d.ts` and unminified `dist` from anything distributed.

**Obfuscation.** Don't obfuscate the editor. Control-flow flattening and string encoding cost size and runtime on canvas hot paths, and skilled readers still get through. At most, protect a local licence check.

**Integrity and watermarking.** Sign snapshot hashes with a KMS Ed25519 key so customers can verify records. Add a build id and canary strings in library data as copy evidence. Exports carry nothing hidden.

**Recommendation**

- Change engine, server and root to `UNLICENSED` today. Add LICENSE and terms with no-reverse-engineering and no-competing-service clauses, on legal advice.
- Keep RDL syntax, DTCG tokens, HTML and CSS as open formats: PRD portability, and no code given away.
- Ship local mode as a free, closed-licence package with design, RDL, MCP and basic lint. No importer, Health Report, approvals or hosted emitters. Accept that it can be read. Replace downloadable-JSON import with "push to hosted".
- Self-hosting by contract only, as an image with a licence key and no source.
- Require a CLA before any outside contribution.

**The decision you must make:** closed, or open-core. Closed best fits "hard to copy", at some cost to the "local and self-hosted" pitch, fourth among reasons to buy. Open-core (engine under a source-available licence such as FSL) wins developer trust but accepts forkable core logic. I recommend closed now: opening later is easy, and the reverse recovers nothing.

## 8. Reliability and operations

|Area|Decision|
|---|---|
|Telemetry|OTel traces per request and tool call; redacted pino JSON; metrics for event-loop lag, heap, pool wait, commit latency, render queue, job age, RLS denials. Today output is `console.error` only|
|SLOs|Editor API availability 99.9%; edit commit p95 under 40 ms; approval success 99.95%; no accepted write lost; job claim p95 under 1 s. Error budgets gate feature releases|
|Deployment|CI: test, scan, sign, staging, smoke, production. Separate migrate task with owner role. ECS circuit breaker and rollback|
|Migrations|Expand, deploy, batch backfill, contract next release. `lock_timeout` 3 s. Runner must allow non-transactional `CREATE INDEX CONCURRENTLY`; today it wraps everything (`db.ts:129`)|
|Flags|`feature_flags` per org, read at session start. Sync rewrite, canvas and new shell ship behind flags|
|Backups|RDS retention 14 days (exists), PITR, S3 versioning (exists). Add cross-account, cross-region copy and Object Lock for snapshots and audit|
|DR|RPO 5 min, RTO 1 hour in region; RPO 1 hour, RTO 8 hours cross-region in R2. Restore drill quarterly. Multi-AZ on for production (`DatabaseMultiAz` parameter)|

## 9. Testing

|Kind|Coverage|Gate|
|---|---|---|
|Property (fast-check)|Apply then inverse equals identity; replay equals live state; checkpoint + tail equals full replay; hash ignores key order and changes with any token in the closure; run undo keeps others' later paths; R3 convergence across random interleavings|PR, nightly at 10x|
|RLS attack|Generated matrix: every table, verb, role, org, with and without token. Catalog test. Direct `rangoli_app` SQL. Extends `srv/app/rls.test.ts`; runs on real Postgres, since PGlite is a single superuser session (`db.ts:99`)|PR|
|Approval invariants|Token change alters every using screen hash; used asset deletion refused; name survives deletion; admin self-approval refused; token session refused|PR|
|Security regression|Corpus: `__proto__`, `</style>`, CSS escapes, SVG script, SSRF hosts and redirects, image bombs, oversized Figma JSON, injected text returned as untrusted|PR|
|Visual regression|Playwright golden corpus per device, light and dark; import fixtures at 3%; export at 0.1% with equal accessibility trees|Merge queue|
|Load (k6 + agent simulator)|300 open projects, 30 agents per minute, 5k and 50k pages, burst imports. Publish against section 4|Weekly, pre-release|
|Accessibility|axe in CI; manual screen-reader, 200% reflow and keyboard before R1 sign-off|R1 exit|

## 10. Implementation sequence

Plan: 62.5-66.5 weeks, interface rebuild unestimated. **This estimate: about 94 engineer-weeks, range 85-105,** assuming seniors and no credit for AI speed-up. Three engineers at 80%: about 9 months. One at 80%: over 2 years.

|WP|Work|Weeks (plan)|Needs|Exit criteria|
|---|---|---|---|---|
|0|Stop-the-bleed: V1-V3, V5, V6, V21, self-approval, reset revokes tokens|1.5 (0)|| Regression tests pass|
|1|Import spike, legal review, partners|3 (3)|| Gate 8 of 10 files, else rescope|
|2|Migration runner, CI, staging, telemetry baseline|1 (0)|| Migrate task runs apart from app|
|3|Bundle libraries, proxy, AVIF; then Studios R1 scope|6.5 (6-6.5)|2|Studios work under CSP; no runtime third-party hosts|
|4|Render service isolation|2 (0)|2|Container has no DB access or egress|
|5|Op log, validation, per-page load, path patches|4 (3)|0, 2|Replay property tests; kill during edit loses no acked write|
|6|Incremental render, retained frames, per-client selection|4 (3.5)|5|Benchmark at 5k meets budgets|
|7|Auth, MFA, sessions, scoped tokens|3.5 (about 3)|2|Token scope tests|
|8|Roles and capabilities, about 84 sites|4 (about 2.5)|7|Attack matrix green|
|9|Always-open views, limits, integrity|3 (3)|8|Stage locks gone|
|10|Workstream Main, screen frames|1.5 (3)|8|R1 needs Main only|
|11|Snapshots, hashes, approvals, handoff from snapshot|5 (4)|5, 8|Section 9 approval invariants|
|12|Canvas: placement, pan, zoom, marquee, text, snapping, pages|7 (6.5-7.5)|6|Task tests with designers|
|13|Device frames, custom size|2 (1.5)|12|Linked duplicates|
|14|Org MCP, stateless, runs, undo, write policy, tasks, jobs, connect|6 (5.5-7.5)|5, 7|Two agents never collide; "2 changes stayed"|
|15|Knowledge R1, `DESIGN.md`|3 (3)|11|Scoped brief at `run_start`|
|16|Figma plugin, parser, model work, report, re-import|9 (6)|1, 5, 11|90% editable; report shareable|
|17|Release, stakeholder link, Fix|3.5 (2.5)|11|Snapshot-only, static, no scripts|
|18|HTML export, React recipe, harness|5 (3)|11|0.1% harness on corpus|
|19|Interface rebuild to `direction.md`|11.5, range 10-13 (unestimated)|6, 12, 14|WCAG 2.2 AA, mockup parity|
|20|Mail, lint additions, sample|3.5 (3.5)|11||
|21|Security and ops baseline: WAF, scans, private subnets, restore drill, runbooks, pen test|4 (0)|2|Section 6 list complete|

**WP 19 breakdown:** design tokens, self-hosted fonts and icons 1; floating shell, rail, clusters 2; Project home and stage views 1.5; For agents, composer, pins, statuses, connect 2; History, kolam 1; Review and Release focus mode, signing 1.5; import arrival, stakeholder view 1; accessibility pass 1.5. Its risk: 32 component files share a 49 KB `styles.css`.

**Order:** 0, then 1 and 2 together. Build 5 and 7 in parallel, with 4 and 3. If a spike fails, drop WP 16 and reduce to Door B. WP 19 starts after WP 6 so it doesn't restyle a canvas about to change.

**If one engineer:** do WP 0, 2, 4, 5, 7, 11, a subset of 8, 14, 17, a thin 19 and the Door B path, about 40 weeks, then test whether partners pay before import.

|Release|Sequence|Plan weeks; view|
|---|---|---|
|R2|Trust panel, overlay; Library Changes; knowledge capture; search; Design QA, PR check; billing, SSO, audit UI; device overrides (needs inheritance model); Studios; OAuth for MCP|62-72; high end. Device overrides and Studios likely run over|
|R3|WebSocket, optimistic rebase; co-editing; workstreams; tasks and Jira; board; test links, heatmaps|46.5-49.5; expect 55-60, sync risk|
|R4|Project leases if not yet triggered; org library; drift; docs site; connectors; custom roles|43.5-44.5; plausible|

## 11. Risks and decisions

|Risk|Response|
|---|---|
|A hosted launch before WP 0 and 4|Block with the section 6 list|
|Team too small|Decide staffing first; use the one-engineer path|
|Figma files exceed model|WP 1 gate; page selection|
|Sync rewrite breaks editor|Flags; property tests; retain RDL path|
|Fargate lacks a Chromium sandbox option|Test in WP 4; EC2 with gVisor as fallback|

**Decisions needed from the founder**

|Decision|Recommendation|
|---|---|
|Closed or open-core licensing, and removing MIT now|Closed; relicense today|
|Local-mode scope, and whether import runs only through hosted|Local without importer, approvals or Health Report|
|Engineers available|At least two seniors plus part-time design; sets R1 scope|
|Accept about 94 weeks, or cut to Door B first|Validate Door B with partners if solo|
|Public-launch gate: is the section 6 list binding?|Yes, with external pen test|
|Stop-first deploys until scale step 3|Accept for partners|
|Data region and EU hosting at launch|US first unless partners require EU|
|Budget for pen test, SOC 2 and counsel|Approve before R1 ends|
