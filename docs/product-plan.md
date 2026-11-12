# Rangoli: final product plan

File:line citations were checked by the PM or architect. Thresholds, prices and estimates are proposals. No user research exists. [S] sourced in business.md or architect.md; [J] judgement; [U] unverified.

## 1. Product and positioning

Rangoli is for product teams of 10 to 200 with one to three designers on Figma Professional, whose engineers already build UI with Claude Code or Cursor. It wins by recording who approved exactly which version of agent-made UI, with deterministic checks, any agent and no AI credits.

**Position: alongside Figma now; replace only on triggers.**

**Pitch:** "Your team already builds UI with Claude Code or Cursor. Rangoli checks that work against your design system and records who approved exactly which version, with no AI credits to buy; keep Figma for everything else."

- **Primary for new work, all of:** spike passes; 5 of 10 partners start most new screens in Rangoli for two consecutive months; unaided designers complete core canvas tasks.
- **Replace for that segment, all of:** 3 paying teams cut Figma Full seats at a real renewal and stay active 90 days; org library shipped; multi-person session passes testing.
- **Stop or narrow to neutral and self-hosted:** Figma ships version-bound approval on Professional, or fewer than 3 of 10 partners would pay after R1.

**Figma parity, honestly:** all its features is not realistic at any defensible date [J]; what one product team needs to design, review and hand off is realistic around R3.

| Verdict | Capabilities |
|---|---|
| Must match | Canvas basics R1 and R2; auto layout, components, prototyping (exist); comments; project libraries; handoff; repo mapping (`code_map`); SSO and activity log R2; frame SVG export (R2, unestimated) |
| Beat | Version-bound approval; any agent, no credits; check on every agent write; tokens with no plan gate |
| Skip | Branching (snapshots substitute, untested); Make, code layers; Slides, Sites, Buzz; Draw; Weave, image generation; FigJam parity (thin board) |
| Not realistic | Plugin and Community catalogue; large live workshops; file history (import takes current state); hiring and muscle memory (82.6% weekly use, UX Tools 2026, self-selected [S]) |

**Why add Rangoli, strongest first**

| # | Reason | Basis |
|---|---|---|
| 1 | Approval tied to an exact version, agents contained, attributed history (once built) | Branching needs Figma Organization [S]; no equivalent found, absence [U] |
| 2 | Any agent, no credits or call limits | Figma's agent uses credits; write is free in beta, usage-based later [S] |
| 3 | Same check, same verdict, on every agent write | [J]; Check designs overlaps on contrast and hard-coded values [S] |
| 4 | Local and self-hosted | Penpot equals this [S] |
| 5 | All stages in one place | [J] merely different; testing arrives R2 |

Not reasons: Figma import (common [S]), free reviewers (parity [S]), RDL savings (no benchmark).

**Pricing to test:** about $99 per workspace monthly, 5 editors. No Business plan before SSO and activity log. Agents never seats.

## 2. Workflow

**Account.** Login or create account, create organization. One owned org; guest in others, with role granted per project by an admin and paid by the inviting org.

**Projects.** Up to 100; Needs you list; New project with two doors.

**Door A, Import.** Link file. Plugin first (variables, no REST quota); one-use REST token second; downloadable JSON for local and self-hosted. Importer needs a Full or Dev seat [S]. Choose pages and frames. The deterministic parser builds editable frames and stores `figmaId`. **Health Report** closes import, shareable: missing states, near-duplicates, contrast, stated partial coverage, never "accessible". It is onboarding, not the reason to buy. Confirm takes an immutable baseline snapshot and makes the importer owner. Team orgs choose per page: Protected (default) or Draft. A connected agent drafts a labelled summary. Lands in workstream Main. R1 includes single-frame re-import.

**Door B, New design.** Name, then canvas, ready to draw or leave a note or task for the connected agent. Type defaults to Feature; Full is one click.

**Project home.** Main (others R2), status, reviews, Connect agent, Library, Releases.

**Types.** Full, Feature, Fix, Regulated set default checks and approvals only. Scope (product, module, flow) is the workstream's name. Fix starts from a released frame with change note and before/after: one approval in teams; in solo orgs Release replaces it.

**Views, flat, fixed display, free working order:** Discovery, Define, IA & Flow, Wireframes, Visual, Prototype, Testing, Handoff. Rail status: Empty, Has work, Approved, Changed since approved.

- **Discovery, Define, IA.** R1: existing forms with no stage lock. R2: agent help, evidence cards, thin board (stickies, sections, connectors, votes, agent clustering), branching flows, list view kept as accessible path. Transcript hosting, card sort, tree test, panels are linked and cited through evidence cards.
- **Reuse.** Research and personas project-level. R2: copy sections, custom sections. R3: org templates.
- **Wireframe, Visual, Prototype.** One canvas, per-screen fidelity over the existing switch (App.tsx:177). R2: Convert as a run, original kept; device preview.
- **Devices.** Desktop, Tablet, iPad, Mobile, Custom W×H. R1: linked frames, duplicate to device. R2: shared content with overrides.
- **Testing.** R1: moderated logging. R2: no-account link on a snapshot, tasks, completion, click paths, consent. R3: heatmaps.
- **Handoff.** Bundle, spec, developer share link, `code_map`.
- **Launch: Release record.** Snapshot, checklist, notes.
- **Live.** Project tokens and components (R1 by suggestion; Library Changes and Live Health R2), feedback, Fix; approval queue, drift, org library R3.
- **Exports.** HTML/CSS built in, semantic. React recipe plus `code_map` R1 (works without it). Vue, Angular verified recipes R2, same checks. Native emitters when three paying teams ask or recipes fail. Figma: two-day recipe test after the gate via `html_to_figma`; conditional.

**Stakeholder link.** Frozen version, rendered, no RDL; comments (cuttable to view-only). Approval needs verified identity.

## 3. Rules

| Effect | Rule |
|---|---|
| Hard block | Self-approval, admins included; agents approving; editing a snapshot; 101st project; second owned org |
| Strict mode (org, opt-in) | Blocks approval or Release with failed checks. Override needs reason; overrider cannot be requester, so two eligible people are required |
| Warns | Skipped stages, unmet checks, under three test sessions. Never blocks entry or editing |
| At approval | Exceptions listed; approver accepts with a note |

**R1 rule:** one active editor per project; reviewers use snapshots. My reading: the active editor's agent writes alongside them.

**Approval binds** snapshot, per-screen and library hashes, named approvers, any/all rule, exceptions, timestamps. Approver name survives user deletion. Defaults: Visual, Handoff.

**Snapshots.** Review creates one; the working copy stays editable and shows Changed since approved. Each snapshot records library state. No branches.

"Handoff bundle, developer share link, exports and agent export read a named snapshot, defaulting to the latest approved. Output from the working copy is marked Unapproved. In team orgs a Release record must reference an approved snapshot or list an exception accepted by a named person; strict mode blocks it. Solo release is unchanged." "In solo orgs the default is the latest released snapshot."

**Workstreams (R2).** One owner per screen, others request handover. Token and component edits show impact, separately approved.

**Solo.** No Approve; Release reads "released by". Local approvals non-binding.

## 4. Agent model

| View | Agent does | From | No agent |
|---|---|---|---|
| Import | Summarises (never parses) | R1 | Plugin, REST token |
| Discovery, Define, IA | Clusters, drafts with citations | R2 | Forms |
| Wireframes to Prototype | Drafts, brands, links | R1 | Templates (stages.tsx:344-347), canvas |
| Testing | Tasks, summaries | R2 | Manual logging |
| Handoff, Release | Notes, recipes into the repo | R1 | Forms, HTML/CSS |
| Live | Sorts feedback, proposes fixes | R2 | Fix |

**Write rule, by object:**
- **Direct, named run, badged "Agent drafted, not reviewed":** own unreviewed frames.
- **Solo orgs:** imported baseline direct; released frames stay direct on the working copy.
- **Team orgs, imports:** recorded per page. Protected (suggestions only) or Draft (owner's agent direct), changeable by the owner.
- **Suggestion:** team approved or in-review work, others' frames, tokens, components.
- **Claims about people:** held, visible, never counted by checks until accepted.
- Agents never approve, database-enforced.

**Before accepting:** agent, token, authorising human; intent; plain diff, visual compare, RDL last. R2 trust panel adds quote verification and per-frame accept on an overlay. Today suggestions cannot chain (mcp.ts:105-118) and accept is whole (ReviewPanel.tsx:89-90).

**Undo:** whole run (R1), skipping properties others changed later, and reporting skips.

**Notes and tasks:** Claude and Cursor connect to Rangoli's MCP server and can't talk through the app. People leave notes and tasks; agents pick them up with `agent_wait` or from the user's Claude or Cursor, then work as named runs. Statuses: Waiting for agent, Picked up, Run in progress, Done, ready to review.

**MCP.** R1: org-level `project_list`, `project_open` (not `extraTools`; MCP closes over one doc, mcp.ts:77); `run_start`, `run_end`, `run_status`, `changes_since`, `agent_wait`, `job_claim`, `job_finish`, `page_create`, `screen_frames_set`, `snapshot_get`, `health_report`, `code_map_get`, `code_map_set`; hosted export. R2: `workstream_get`, `item_list`, `item_create`, `item_update`, `evidence_add`, `board_read`, `board_apply`, `test_summary`.

**Manual path:** possible, not equally fast. Agent-required: framework code, bulk synthesis.

## 5. Releases and effort

**Assumptions.** Architect's estimates assume 3 senior engineers at 80% focus. R1's 40 are the CEO's unvalidated reductions. Git shows one author.

**R0, Validate (spike 3 engineer-weeks, counted in R1).** Sign 10 partners shipping with agents, 5 committing a real file; price tests; first-session agent-connection tracking; counsel review; import spike.
Measure: gate result, 10 partners signed.

**Spike gate:** "Before R1 work beyond the spike: 8 of 10 real partner files import with at least 90% of frames editable, auto layout preserved, pixel diff at or under 3% against plugin export, missing-font frames reported separately. Fail: re-scope R1 around Door B."

**Legal:** "No import outside named design partners until counsel reviews Figma's Developer Terms, ToS, Acceptable Use, API and plugin rules."

**R1, Import to handoff: about 40 engineer-weeks (nine months solo).**

| Item | Weeks |
|---|---|
| Spike | 3 |
| Import, plugin, report | 5 |
| Single-frame re-import | 1 |
| Op log, per-page load | 3 |
| Incremental render, benchmark | 3 |
| Per-client selection | 0.5 |
| Always-open views, limits, integrity, frozen-check removals | 3 |
| Canvas: free placement, pan, cursor zoom, marquee, double-click text, shortcut switch | 3.5 |
| Pages | 2 |
| Snapshots, approvals | 4 |
| Run IDs, whole-run undo | 2 |
| Connect, scoped tokens, notes and tasks for agents, `agent_wait` | 2.5 |
| Linked device frames, custom size | 1.5 |
| Release, stakeholder link, Fix | 2.5 |
| Semantic HTML, hosted export, `code_map`, React recipe, harness | 3 |

**Cut order:** (1) automatic pickup with `agent_wait`, keeping manual pickup from Claude or Cursor; (2) linked device frames, keeping custom size; (3) stakeholder comments, keeping view-only; (4) re-import. Never: import, snapshots, approval, handoff.

Out: WebSocket, live co-editing, board, workstreams beyond Main, evidence, overlay, built-in React, Vue, Angular, tests.
Measure: 5 partner teams take a real file to approved handoff and start a second change within 30 days; at least 3 of 10 would pay.

**R2, about 50 engineer-weeks (PM arithmetic, unvalidated).** WebSocket before the board; board; flows; Convert; workstreams; evidence, item tools; overlay, trust panel; Library Changes; test links; device overrides; Live Health, halo, Ctrl+K; remaining canvas (8 handles, Alt-drag, Ctrl+A, outside-in select); accessibility rules; SSO, activity log; Vue and Angular recipes.
Measure: share of workstreams started in Rangoli; external sessions per workstream.

**R3, about 25 engineer-weeks.** Org library, queue, drift, re-import diff, templates, heatmaps, scale-out, Figma export if the recipe failed.
Measure: teams shipping changes 90 days after first handoff.

**North star:** agent-made changes reaching an approved version, not reverted in 30 days.

**Out throughout:** recruiting, video, native card sort and tree test, transcript hosting, live URL, new 3D investment. Icon and image work is now in section 13.

## 6. Technical plan

**Data, migration 003 (expand), 004 (contract):** `workstreams` backfilled one per (project, cycle), latest Main; nullable `workstream_id`; singleton index on `(project_id, workstream_id, kind) NULLS NOT DISTINCT`; `screen_frames` backfilled from `data.frame`; `orgs.owner_id` with partial unique index, grandfathering existing multi-org owners. Drop `projects.stage`, `cycle` a release later. Project cap inside `create_project` (schema.ts:312) under an org row lock. `design_ops` op log (seq, page, author, run_id, ops, inverse); `designs.data` becomes compaction.

**Removals:** `ITEM_STAGE` limits (lifecycle.ts:50-53, server.ts:488), frozen checks (server.ts:489, `stage_frozen` migration-002.ts:21, `closed()` stages.tsx:14-18), `lockFor` (server.ts:165-169).

**Snapshots:** keep insert-only `design_versions` (schema.ts:392); add server id, creator, `screen_hashes`, `library_hash`, frozen items and annotations. A screen hash covers the subtree plus every token, component and asset used, or token edits never show as changes. Block deleting referenced assets (deletion is granted, schema.ts:393). The handoff bundle reads the live document today (server.ts:692).

**RLS self-approval hole.** Admins bypass the requester check at migration-002.ts:40-45; server.ts:584 has the same gap. The approvals policy must require requester differ from `app_uid()` for every role, and refuse token sessions through new `app.token_id`. Strict-override inserts apply the same test. Approvals reference a snapshot, store approver name, SET NULL on user, replacing the cascade (schema.ts:204). New functions need explicit REVOKE and GRANT. Old sign-offs cannot be backfilled.

**Tokens:** add org, projects, scopes, expiry (schema.ts:49-56).

**Sync and render. Keep DOM, no CRDT.** Today every doc event refetches the document (store.ts:213-216,242) and rewrites the canvas (Canvas.tsx:45); selection is global (design-routes.ts:273-277). R1: op log, per-page loading, per-frame fragments patched by touched ids, per-client selection. R2: WebSocket rooms, ephemeral cursors, optimistic ops rebased on server order, last-writer-wins per property. Delete SPEC:135. Unbenchmarked budget: retained frames to 5k layers; culling to 50k; WebGL tiles only beyond that.

**Board:** shared viewport; separate `board_objects` and DSL, so board edits never touch design hashes or undo.

**Figma:** plugin (`documentAccess: dynamic-page`, `allowedDomains`), one-use import tokens, chunked upload (2 MB body cap, server.ts:713). REST Variables are Enterprise-only; plugin access on lower plans unconfirmed [S]. No MCP tool returns raw nodes, so agents only summarise. Needs model work: mixed-style text, overrides, per-variant trees. Lossy or flattened: constraints, vector networks, masks.

**Runs:** R1 tags ops with run IDs and undoes by inverses. R2 forks per run and replays recorded ops per frame. `agent_jobs` with leases replaces the queue.

**Code:** harness renders recipe output at each device width: pixel diff at or under 0.1% against HTML baseline, equal accessibility trees, compiler checks.

**Testing, scale:** snapshots pre-rendered to static hosting; clicks stored without keystrokes. Workers first, then per-project leases, on event-loop lag above 50 ms.

**Health checks are new work:** lint has no target-size, near-duplicate or missing-state rule (grep).

## 7. Decisions (settled by CEO ruling)

1. Warn; strict blocks approval and Release only.
2. Fixed display, free order.
3. Own one, guest any role per project.
4. One-time import, single-frame re-import R1, diff R3, never two-way.
5. Testing as above; no recruiting or video.
6. HTML/CSS built in, recipes with `code_map`.
7. Keep local; `npx rangoli`, push to hosted.

All nine contested items are resolved as written in sections 2 to 5.

## 8. Founder decides (not settled)

| Ask | Council recommends | Loses | Gains |
|---|---|---|---|
| One user, one org | Own one, guest in many | Strict rule | Agencies, contractors, client review |
| One-stop for everything | Alongside first | Replace-Figma story now | Credible target; parity infeasible |
| Whiteboard | Thin, R2 | Day-one single place, FigJam parity | Board on a working canvas |
| Discovery, Define, IA with tools' features, agent help | Forms R1, agent help R2, heavy instruments linked | All-in-one, early AI there | Finishable R1 |
| New design follows whole workflow | Feature default | Enforced process | Minutes to canvas |
| React, Vue, Angular exports | Agent recipes first; Vue, Angular R2 | Button, agentless use | Effort on approval |
| Figma export | Conditional on two-day test | Guaranteed round trip | No unproven dependency |
| Launch stage | Release record | Standalone stage, live URL | Less ceremony |
| Usability testing | R2 | Test links in v1 | Approval first |
| Maintenance library | Project R1, org R3 | Org-wide at launch | Earlier governed changes |
| Agent automation | Client-side; server checks R3 | Scheduled AI inside | Keeps no-AI rule |
| All device design | Linked frames R1 | Shared content early | Smaller R1 |
| Collaboration (PM addition) | One active editor R1, co-editing R2 | Live co-editing in v1 | Sync rework sequenced safely |
| Staffing | Fund a second engineer | Budget | Avoids nine months solo |

Kept: login first, 100 projects, Figma as first door, custom resolution.

## 9. Complete plan, version 2 (supersedes the release list in section 5)

Added after the council at the founder's request: every Add item from the hub, research and competitor reviews. The grouping, the order and the added estimates have not been reviewed by the council or architect. Section 5's R1 detail, cut order, spike gate and legal rule still apply.

One-stop means design work and its context stay in one place. Communication tools connect where they touch a design.

### Seven shared systems

| System | Carries |
|---|---|
| Approval and proof | Snapshots, approvals, handoff, release, exports, Design QA, pull request check |
| Knowledge | Source, excerpt, insight or decision, persona, story, screen. Sources: interviews, PM talks, documents, forwarded mail, Jira comments, review sessions, surveys, competitor captures, feedback connectors |
| Work | Tasks, Jira, design threads, notifications, sticky-to-task, finding-to-task, agent as assignee |
| Canvas and board | Shared viewport, snapping, guides, co-editing, follow me, presentation, devices |
| Library | Tokens, components, status tags, agent rules, change approval, docs site, adoption analytics, drift |
| Testing | Test links, click paths, misclicks, usability score, heatmaps, tree test, reports |
| Agent platform | MCP, runs, undo, job queue, cited search, recipes |

### Releases

| Release | Scope | Rough weeks |
|---|---|---|
| R1 Approve | Section 5 R1 (40); workstream migration (3); object-level write policy and one-active-editor (1-3); mail notifications (1); snapping, smart guides, measuring (1-2); per-project agent rules (0.5-1) | 47-50 |
| R2 Prove | Overlay, per-frame accept, trust panel (3); Library Changes, status tags (3.5); Live Health (2); accessibility rules (2); remaining canvas (1.5); Design QA with design-on-live overlay and Storybook link, pull request check (3-4); Convert (3); device overrides (5); QR phone preview (0.5); PDF and frame SVG export (0.5, SVG unestimated); Vue and Angular recipes (4.5); SSO, activity log (2.5). Knowledge: evidence cards, competitor capture, survey import (2); interview sessions, transcripts, consent, deletion (2-3); decision log, "Why is it like this?" panel (1-2); search and cited-search agent tool (1.5-2.5); interview guides, participant list (1) | 39-43 |
| R3 Collaborate and test | WebSocket, co-editing (4); workstreams (4); follow me (1); tasks (2); Jira (3-4); agent access to work (1); design threads, Slack and Teams notifications (2-3); reply by email, forward to project (1-2); review session, presentation walkthrough, walkthrough link (2.5); board with persona, empathy and journey templates (8); timer, vote limits, anonymous voting (0.5); sticky-to-task (0.5); branching flows (2); test links (3.5); usability score, misclick rate, shareable report (1); heatmaps (1); tree test from the sitemap (2) | 39-42 |
| R4 Scale | Section 5 R3 less heatmaps (24): org library, approval queue, drift, re-import diff, templates, scale-out, Figma export if the recipe failed; design system analytics (2); feedback and analytics connectors (3); design system docs site (3); recipe library (2-3) | 34-35 |

This table excludes sections 10 to 13. Section 14 has the current totals.

Runs alongside: SOC 2, ISO 27001 and GDPR readiness starts during R1 and is required before a Business plan.

### Replaced rather than copied

| Other tools offer | Rangoli's shape | Why |
|---|---|---|
| Plugins, Community | Recipe library of reusable agent workflows | Catalogue cannot be matched; recipes use the connected agent |
| Mail inbox | Reply by email, forward to project | Avoids restricted-scope review and private mail storage |
| Chat channels, direct messages | Threads on design objects, Slack and Teams notifications | Conversation stays with the design |
| Screen share | Follow me | Live canvas is sharper and editable |
| Embedded video | Review session, Meet or Zoom link, decisions recorded; revisit if three paying teams ask | Decisions are the value |
| Recorded walkthrough | Attached walkthrough link | Storage avoided |
| Recording, transcription | Upload the meeting tool's transcript | No AI inside the product |
| AI-moderated interviews | Agent prepares the guide and analyses; a person moderates | No AI inside the product |
| Digital Twins | Cited search over real research | Invented users undermine evidence |
| Card sort | Linked, results imported as a source | Tree test uses the sitemap Rangoli already holds |

### Guardrails

Agents see only mail a person forwarded. Mail, ticket and thread text is untrusted input to agents. Agent Jira updates name the agent and the authorising person; bulk changes need confirmation. Interview data needs consent, retention and deletion. Reviewers can add sources and propose decisions.

## 10. Roles and permissions (added after the council; not reviewed)

Today one role per organization (admin, designer, reviewer) applies to every assigned project: `project_members` has no role column (schema.ts:106-116), and role checks are spread across about 84 code sites. Guest access already requires a per-project role.

**Shape.** Organization role and project role are separate. Roles are presets over named capabilities, checked in one place (`has_capability`) and enforced by row-level security. Approver is a designation on a person, not a role.

| Level | Role | Purpose | Release |
|---|---|---|---|
| Org | Owner | Billing, transfer, delete organization; one per organization | R1 |
| Org | Admin | People, access, settings, every project | R1 |
| Org | Member | Sees assigned projects only | R1 |
| Org | Billing admin | Plan, seats, invoices; no design access | R2 |
| Org | Library maintainer | Organization tokens and components | R4 |
| Org | Auditor | Read-only history and approvals, for regulated teams | R4 |
| Project | Lead | Runs the project: members, release, strict override | R1 |
| Project | Designer | Designs and manages work | R1 |
| Project | Reviewer | Comments, suggests, adds sources, proposes decisions | R1 |
| Project | Viewer | Read only | R1 |
| Project | Researcher | Owns interviews, participant data, evidence | R2 |
| Project | Product manager | Owns briefs, decisions, tasks; no canvas edit | R2 |
| Project | Developer | Handoff, inspect, code mapping, tickets | R2 |
| Project | Writer | Edits text layers and glossary only | R3 |
| Any | Guest | External person holding a project role in one project | R1 |
| Any | Approver | Named person whose approval binds | R1 |
| Org | Custom roles | Enterprise capability sets | R4 |

| Capability | Lead | Designer | Researcher | PM | Developer | Reviewer | Viewer |
|---|---|---|---|---|---|---|---|
| View design and snapshots | Y | Y | Y | Y | Y | Y | Y |
| Comment, suggest | Y | Y | Y | Y | Y | Y | N |
| Edit design | Y | Y | N | N | N | N | N |
| Accept or reject suggestions | Y | Y | N | N | N | N | N |
| Add sources and evidence | Y | Y | Y | Y | N | Y | N |
| Record decisions | Y | Y | Propose | Y | Propose | Propose | N |
| See raw transcripts and participant details | Y | N | Y | N | N | N | N |
| Create and assign tasks | Y | Y | Y | Y | Y | N | N |
| Accept project knowledge rules | Y | Y | Research | Product | Code | N | N |
| Export, handoff, code mapping | Y | Y | N | View | Y | N | N |
| Release | Y | Y | N | N | N | N | N |
| Approve, if named approver | Y | Y | Y | Y | Y | Y | N |
| Manage project members, strict override | Y | N | N | N | N | N | N |

**Rules.** Self-approval stays blocked for every role. An organization always keeps one owner. Guests see only their assigned projects. Solo organizations see none of this.

**Agents are not a role.** An agent's effective access is the lowest of the authorising person's role, the token scope and the write rules. Agents never approve, manage members, handle billing, or read raw transcripts and participant details.

**Seats to test.** Paid: Lead, Designer, Researcher. Free: other roles.

**Data.** Add `project_members.role`, `is_approver`; split `org_members.role`; backfill admin to Owner or Admin, designer to Member with project Designer, reviewer to Member with project Reviewer. Replace role-name checks in policies and the about 84 code sites. Extend the RLS attack tests.

## 11. Project knowledge (added after the council; not reviewed)

Knowledge grows from the project's own work and is what every person and agent reads before changing it. No code for this exists today.

| Layer | Contents | Created by |
|---|---|---|
| Design profile | Tokens in real use, component usage, layout patterns, screen list, naming, off-system exceptions | Computed from each snapshot, no AI |
| Project rules | Do and don't, with scope: project, workstream, screen or component | People; agents propose |
| Decisions and evidence | From section 9 | People; agents propose |
| Approved patterns | Solutions promoted from approved screens, with when and when not to use them | Promoted at approval |
| Lessons | What failed in tests, rejected suggestions and their reasons, launch results | Proposed from those events |
| Language | Glossary, tone, approved labels and error wording | People; agents propose |

**Growth events.** Figma import builds the first profile. Approval updates the profile and offers patterns. A rejected suggestion with a reason proposes a rule. A triaged finding proposes a lesson. A logged decision or repeated review comment proposes a rule. A release records results.

**Entries.** Each has scope, source, snapshot, owner, status (proposed, active, stale, retired), last confirmed date and what it replaces. Only a person activates an entry. Entries are superseded, not silently overwritten. An entry goes stale when its screens or source change.

**Precedence.** Screen, workstream, project, organization, then `docs/knowledge/agent-design-rules.md`. Accessibility, legal and honesty rules cannot be overridden.

**Used by.** Agents get a short brief at `run_start`, scoped to the screens in the task. Designers get the Knowledge page and "Why is it like this?". Reviewers see which rules and decisions apply. Repos get an exported `DESIGN.md`, so Claude Code and Cursor follow it outside Rangoli. Rules that can be checked become project lint rules.

**Guardrails.** Participant details are excluded. Text from outside sources cannot activate a rule. Knowledge stays within the project until promoted to the organization.

**Data.** `knowledge_entries`, `design_profiles` per snapshot, and `knowledge.json` in the local file format.

| Release | Scope | Weeks |
|---|---|---|
| R1 | Design profile, project rules, scoped agent brief, `design_rules` tool over the global rules, `DESIGN.md` export (includes the agent rules item in section 9) | 3 net |
| R2 | Proposals from approvals, rejections and decisions; staleness; approved patterns; Knowledge page; project lint rules | 5-6 |
| R3 | Proposals from threads and test findings | 0.5 |
| R4 | Promote to organization knowledge; cross-project search | 3 |

**MCP tools.** R1: `design_rules`, `knowledge_get`, `design_profile_get`, `my_permissions`. R2: `knowledge_propose`.

## 12. Other needed features (added after the council; not reviewed)

A text search found no email verification, multi-factor login, billing, restore or notification centre in the server app.

| Feature | Why | Release | Weeks |
|---|---|---|---|
| Email verification, multi-factor login | Approval depends on verified identity | R1 | 1.5 |
| Checks for target size, missing states, visible form labels; test-session warning raised to 5 | Most useful unenforced rules | R1 | 1.5 |
| Sample project and guided first run | Time to first value | R1 | 1 |
| Billing, seats, invoices | Paid plans cannot run without it; partners can be invoiced by hand in R1 | R2 | 2-3 |
| Trash and restore for projects and screens | Recovery from mistakes | R2 | 1 |
| Organization data export | Delivers the exit guarantee | R2 | 1-1.5 |
| In-app notification centre | One place for reviews, mentions and tasks | R2 | 0.5 |
| Content stress test: long text, empty, error, no permission | Catches failures that mock data hides, a known weakness of generated UI | R2 | 1-1.5 |
| Token sync to the repo | Keeps design and code tokens matched | R2 | 1 |
| Focus-order and reading-order annotations | Developers need them for accessible builds | R2 | 1 |
| Localization preview, including right-to-left | Reveals text expansion and layout problems | R3 | 1.5 |

## 13. Icon and Image Studios (added after the council; not reviewed)

Reverses the earlier "no new icon or image investment" line at the founder's request. Findings come from reading the code; the app was not run.

**Blockers in the hosted app.** The hosted policy (server.ts:27, sent at server.ts:907) has no external script, connection, image, style or font sources.
- Path operations, shape builder, trace and icon font load from esm.sh (VectorEditor.tsx:67-68, IconStudio.tsx:189, 344-345) and should be blocked. The message shown blames the internet connection (VectorEditor.tsx:575).
- The online icon library calls and shows images from api.iconify.design (IconStudio.tsx:188) and should be blocked.
- Google Fonts should be blocked for the same reason (fonts.ts:122, 126).
- Local mode needs internet for the same modules.

**Other defects.** AVIF is offered and accepted, but dimension reading has no AVIF branch, so upload fails (ImageStudio.tsx:66, imaging.ts:9-40).

**Image Studio gaps.** Crop is three centred ratios plus number fields, and the box cannot be dragged (ImageStudio.tsx:153, 202). Width-only resize. Three adjustments. Every edit creates a new asset, with no re-edit. No drag and drop or paste, though the hint says "Drop in". No insert into the design, only Copy RDL. Delete has no confirmation or usage check. Compositions can only be edited in Design. Three templates.

**Icon Studio gaps.** The tool set is strong: 11 vector tools, booleans, keyline, lint, drafts, export. Problems: fixed board with no zoom, one long right panel, no insert into design, and no whole-set SVG or component download in the UI.

### Plan

| Release | Scope | Weeks |
|---|---|---|
| R1 Make them work | Bundle path, trace and font libraries in the app; server proxy with allowlist for icon collections and Google Fonts; fix AVIF. Image: draggable crop with free and preset ratios, drag and drop, paste, insert or replace in design, re-editable recipes, delete with usage warning. Icon: board zoom and pan, reorganised panel, insert in design, whole-set download | 6-6.5 |
| R2 Match the tools | Icon: keyline overlays, whole-set consistency view, linked outline, solid and duotone variants, bulk edits, usage and replace everywhere, SVG optimisation, React, Vue and Angular set export, licence record. Image: layered image editor, masks, clip to shape, text, full adjustments, filter presets, focal point, before-and-after compare, AVIF and responsive export, social size pack, 20 or more templates, colours to tokens, background removal | 9-12 |
| R3 Retouch and batch | Selection, erase, clone and heal; batch images from CSV or project data | 4.5 |
| R4 Share | Organization icon and image libraries; connect the team's own image provider | 2.5 |

**Better than other tools.** Icons and images use project tokens and update when tokens change. Compositions stay editable after export. Agents draft variants and every draft is checked by icon lint. Usage is tracked, so replacing an icon or image updates every screen. Batch creation comes from project data.

**No-AI rule.** Generate, expand and AI object removal are not built in. An agent or the team's own provider supplies them.

**Background removal needs a decision.** The common browser library is AGPL, so a closed commercial product would likely need its commercial licence; have counsel confirm. Options: buy that licence, or find a permissively licensed model and verify its weights. Manual masking ships regardless.

**MCP tools.** R1: `icon_insert`, `image_insert`. R2: `icon_variants`, `icon_usage`, `icon_replace`, `image_adjust`, `palette_from_image`. R3: `image_batch`.

## 14. Current totals

| Release | Section 9 | Sections 10-12 | Section 13 | Total weeks |
|---|---|---|---|---|
| R1 Approve | 47-50 | 9.5-10 | 6-6.5 | 62.5-66.5 |
| R2 Prove | 39-43 | 14-17.5 | 9-12 | 62-72 |
| R3 Collaborate and test | 39-42 | 3 | 4.5 | 46.5-49.5 |
| R4 Scale | 34-35 | 6.5 | 2.5 | 43.5-44.5 |
| **Total** | 159-170 | 33-37 | 22-25.5 | **about 215-235** |

About 21 to 23 months for three engineers at 80% focus; over 5 years for one. R1 alone is about 18 to 19 months solo at 80%.

R1 additions that can slip first: sample project, multi-factor login (email verification stays), new lint checks, `DESIGN.md` export. Then apply section 5's cut order. The section 13 R1 fixes that unblock the hosted app should not slip.
