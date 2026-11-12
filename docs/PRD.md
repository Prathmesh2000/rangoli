# Rangoli: Product Requirements Document

**Status:** Draft for founder review · **Date:** 9 November 2026 · **Owner:** Prathmesh Agrawal

**Readers:** founder, designers, engineers and coding agents building Rangoli. `docs/SPEC.md` describes the engine and the current system. This document describes what the product must become.

**Evidence.** No user research exists yet. Market facts come from public sources and vendor pages, some of them secondary. Thresholds, prices and estimates are proposals. Engineer-week estimates were not validated by a build. The first release begins by testing the riskiest assumptions with 10 real design partners.

## 1. Summary

Rangoli is a design workspace where AI agents and designers work on the same design, and where every approved version is recorded, checked and traceable to the reasons behind it.

Product teams now build UI with Claude Code and Cursor faster than anyone can review it. Rangoli gives that work a home: it checks agent-made UI against the design system, records who approved exactly which version, and carries the research and decisions behind each screen.

**One-stop, defined.** All design work and its context stay in one place, from first research to post-launch maintenance. Tools for communication and engineering connect where they touch a design and aren't rebuilt.

## 2. Problem

- Agent-made UI arrives quickly, drifts from the design system and has no reliable review record.
- A design team's work is scattered across Figma, FigJam or Miro, Dovetail, Maze, Zeplin or zeroheight, Jira and Slack. The reasons behind a design get lost between them.
- Approval usually means a comment or a message. Nothing ties it to the exact version that shipped.
- Each new agent session starts without knowing the project's decisions and rules.

## 3. Users

| User | Needs |
|---|---|
| Product designer | Move quickly, stay in control of agent work, keep the reasons for decisions |
| Design lead | Consistency, reviews and approvals across projects |
| Researcher | Interviews and evidence that reach the screens they affect |
| Product manager | Record decisions and requirements, follow status |
| Developer | Exact approved specs, assets and code mapping |
| Reviewer or stakeholder | Review a frozen version without needing the tool |
| Solo designer | The same power with no team process |
| AI agent | Compact context, clear permissions, deterministic checks |

**First customer segment:** product teams of 10 to 200 with one to three designers on Figma Professional, whose engineers already build UI with Claude Code or Cursor.

## 4. Positioning and goals

**Pitch:** "Your team already builds UI with Claude Code or Cursor. Rangoli checks that work against your design system and records who approved exactly which version, with no AI credits to buy; keep Figma for everything else."

**Why teams add it, strongest first:**
1. Approval tied to an exact version, with agent work contained and attributed
2. Any agent, with no credits or call limits
3. The same deterministic checks on every agent change
4. Local and self-hosted options
5. All stages in one place
6. An interface that designers enjoy working in

**Position against Figma.** Alongside now. Become primary for new work when 5 of 10 partners start most new screens in Rangoli for two consecutive months. Replace for that segment only when 3 paying teams cut Figma seats at a real renewal and stay active for 90 days. Matching every Figma feature isn't a goal. Plugins, Community and large live workshops are not realistic targets.

**Stop or narrow** if Figma ships version-bound approval on its Professional plan, or fewer than 3 of 10 partners would pay after Release 1.

| Metric | Target |
|---|---|
| North star | Agent-made changes reaching an approved version and not reverted within 30 days |
| Release 1 | 5 partner teams take a real file to approved handoff and start a second change within 30 days; at least 3 of 10 would pay |
| Release 2 | Share of work started in Rangoli; external sessions per workstream |
| Release 3 and later | Teams still shipping changes 90 days after first handoff |

## 5. Product principles

1. **Claude and Cursor connect to Rangoli's MCP server.** Rangoli has no AI model or AI API key of its own. Each user connects their own Claude or Cursor to Rangoli's MCP server, and that agent reads, designs and proposes changes in the project. Agents can't talk through the Rangoli interface. People leave notes and tasks in Rangoli, the agent picks them up through MCP, and any conversation happens in Claude or Cursor. Rangoli stores, renders, checks, exports and records.
2. **Every AI feature has a manual path,** though not always an equally fast one.
3. **Stages are views, not locks.** Only approvals bind.
4. **Agents draft, people decide.** Agents never approve.
5. **Connect, don't rebuild.** A feature earns its place if knowing the design makes it better than the tool it would replace.
6. **The design is the star.** The interface is itself part of the product's value. See section 16.

## 6. Core concepts

| Concept | Meaning |
|---|---|
| Organization | Tenant. An account owns one organization and can be a guest in others |
| Project | One product. Up to 100 per organization. Shares components and tokens |
| Workstream | One piece of work in a project: whole product, module or single flow. Project starts with **Main** |
| Work type | Full, Feature, Fix or Regulated. Sets default checks and approvals |
| Stage view | Discovery, Define, IA & Flow, Wireframes, Visual, Prototype, Testing, Handoff |
| Screen | A product screen, with one or more device frames |
| Snapshot | Immutable copy of a named state, including assets, items, and hashes |
| Approval | A named person's decision bound to a snapshot |
| Release | Record of what shipped: snapshot, checklist, notes |
| Run | A named set of agent changes that can be undone as a whole |
| Project Knowledge | Rules, decisions, patterns and lessons that grow with the project |

## 7. Main journeys

1. **Sign up:** create account, create organization, reach Projects.
2. **Import from Figma:** link file through the plugin, choose pages, receive a Health Report, confirm a baseline, read the agent's summary, begin work in Main.
3. **New design:** name it and reach the canvas, ready to draw or leave a task for the connected agent. Feature is the default, and Full is one click.
4. **Fix:** start from a released frame, make the change with a note and before and after, get one approval, release.
5. **Agent-assisted work:** connect Claude or Cursor to Rangoli's MCP server, leave a note or task, the agent picks it up in a named run, then keep or undo the result.
6. **Research to screen:** add interviews and PM decisions, turn excerpts into insights, link them to personas, stories and screens.
7. **Team approval:** request review, a snapshot is created, editing continues, an approver decides on that exact version, later edits show "Changed since approved".
8. **Stakeholder review:** open a link to a frozen version, comment, verify identity to approve.
9. **Solo release:** press Release, recorded as "released by" and never as "approved".
10. **Usability test:** create a link from a snapshot, participants complete tasks, findings are triaged.
11. **Developer handoff:** open the approved bundle, then generate code mapped to the team's repo and compare it with the design.
12. **Maintenance:** record results and feedback, approve library changes, start a Fix or a new cycle.

## 8. Requirements

**Releases:** R1 Approve · R2 Prove · R3 Collaborate and test · R4 Scale. "Now" means built today, based on the code and README.

### 8.1 Account and organization

| ID | Requirement | Release |
|---|---|---|
| AC1 | Sign up, log in, password reset, invites | Now |
| AC2 | An account owns at most one organization | R1 |
| AC3 | An organization has at most 100 projects, enforced in the database | R1 |
| AC4 | Email verification and multi-factor login | R1 |
| AC5 | Sample project and guided first run | R1 |
| AC6 | SSO and activity log | R2 |
| AC7 | Billing, seats, invoices | R2 |
| AC8 | Trash and restore; full organization data export | R2 |

### 8.2 Figma import

| ID | Requirement | Release |
|---|---|---|
| FI1 | Import through a plugin, with a one-use token or JSON file as alternatives | R1 |
| FI2 | Choose pages and frames; produce editable frames and retain Figma IDs | R1 |
| FI3 | Shareable Health Report that states partial coverage and never says "accessible" | R1 |
| FI4 | Confirming creates a baseline snapshot and first design profile | R1 |
| FI5 | Single-frame re-import | R1 |
| FI6 | Full re-import showing what changed | R4 |

**Gate before further R1 work:** 8 of 10 real partner files import with at least 90% of frames editable, auto layout preserved, and pixel difference at or under 3% against plugin export. Missing-font frames are reported separately. If this fails, R1 is rescoped around new designs.

**Legal gate:** no import outside named partners until counsel reviews Figma's Developer Terms, Terms of Service, Acceptable Use and API and plugin rules.

### 8.3 Discovery, Define, IA and knowledge capture

| ID | Requirement | Release |
|---|---|---|
| KN1 | Brief, research notes, problem, personas, stories, screens, flows | Now |
| KN2 | Stage views are always open; gaps warn | R1 |
| KN3 | Evidence cards: cited excerpts, competitor captures, imported survey results | R2 |
| KN4 | Interview sessions with alias, consent, guide, recording link, transcript, deletion and retention | R2 |
| KN5 | Decision log: what, who, why, date, source, affected screens, what it replaces | R2 |
| KN6 | "Why is it like this?" panel on every screen | R2 |
| KN7 | Search across research and decisions, with cited agent answers | R2 |
| KN8 | Board with sticky notes, sections, connectors, votes, timer, agent clustering, and persona, empathy and journey templates | R3 |
| KN9 | Branching flow diagrams | R3 |
| KN10 | Tree test from the sitemap | R3 |
| KN11 | Feedback and analytics connectors | R4 |

Agent quotes must match the source word for word. Claims about people stay held until a person accepts them, and checks never count them before that.

### 8.4 Design

| ID | Requirement | Release |
|---|---|---|
| DE1 | Canvas, layers, inspector, tokens, themes, design languages, components, patterns | Now |
| DE2 | Free frame placement, pan, cursor zoom, marquee, double-click text | R1 |
| DE3 | Snapping, smart guides, measuring | R1 |
| DE4 | Multiple pages | R1 |
| DE5 | One screen with linked frames for Desktop, Tablet, iPad, Mobile and custom size | R1 |
| DE6 | Shared content across devices with overrides | R2 |
| DE7 | Convert wireframe to visual as an agent run, keeping the original | R2 |
| DE8 | Content stress test: long text, empty, error, no permission | R2 |
| DE9 | Remaining canvas: full handles, Alt-drag, select all, command palette | R2 |
| DE10 | Live co-editing and follow me | R3 |
| DE11 | Localization and right-to-left preview | R3 |

### 8.5 Prototype and testing

| ID | Requirement | Release |
|---|---|---|
| PT1 | Links, overlays, transitions, motion, timelines, standalone prototype | Now |
| PT2 | Preview per device and QR preview on a phone | R2 |
| PT3 | Manual session logging and findings | Now |
| PT4 | No-account test links with consent, tasks, completion and click paths | R3 |
| PT5 | Usability score, misclick rate, shareable report, heatmaps | R3 |

### 8.6 Approval, handoff and release

| ID | Requirement | Release |
|---|---|---|
| AP1 | Snapshots that capture design, assets, items, annotations, library state and per-screen hashes | R1 |
| AP2 | Approvals naming approvers and exceptions, bound to a snapshot | R1 |
| AP3 | Per-screen "Changed since approved" | R1 |
| AP4 | Stakeholder link to a frozen version | R1 |
| AP5 | Handoff, developer link and exports read a named snapshot, or are marked Unapproved | R1 |
| AP6 | Release record | R1 |
| AP7 | Fix flow | R1 |
| AP8 | Per-frame accept and agent trust panel | R2 |
| AP9 | Design QA comparing the built page with the approved version | R2 |
| AP10 | Pull request check against the approved version | R2 |
| AP11 | Focus-order and reading-order annotations | R2 |
| AP12 | Approval queue across projects | R4 |

**Acceptance for approval:** a token change alters the hash of every screen using that token. Deleting an asset used by a snapshot is refused. An approver's name survives account deletion. No one can approve their own review, admins included, and this is enforced by the database. The current code lets admins do this (`migration-002.ts:42`, `server.ts:584`), which must be fixed regardless of release plans.

### 8.7 Work and communication

| ID | Requirement | Release |
|---|---|---|
| WK1 | Mail notifications | R1 |
| WK2 | Notification centre | R2 |
| WK3 | Tasks on screens, comments and findings, assignable to a person or an agent | R3 |
| WK4 | Two-way Jira sync for linked tickets; built so Linear can follow | R3 |
| WK5 | Threads on projects, screens and tasks, with Slack and Teams notifications | R3 |
| WK6 | Reply by email; forward an email to a project | R3 |
| WK7 | Review session: screen agenda, Meet or Zoom link, recorded decisions, presentation walkthrough | R3 |

**Not built:** full mail inbox, direct messages and general channels, embedded video. Reconsider embedded video if three paying teams ask.

### 8.8 Library

| ID | Requirement | Release |
|---|---|---|
| LB1 | Project tokens and components, changed by suggestion | R1 |
| LB2 | Approved library changes with impact view, status tags, Live Health | R2 |
| LB3 | Token sync to repo | R2 |
| LB4 | Organization library, drift reports, docs site, usage analytics | R4 |

### 8.9 Export

| ID | Requirement | Release |
|---|---|---|
| EX1 | Semantic HTML and CSS, hosted export | R1 |
| EX2 | React through an agent, mapped to the customer's components with `code_map` | R1 |
| EX3 | Vue and Angular through an agent, same checks | R2 |
| EX4 | Frame SVG and PDF | R2 |
| EX5 | Figma export, subject to a two-day test of Figma's `html_to_figma` | After import gate |

Agent-generated code is verified by rendering at each device width: pixel difference at or under 0.1% against the HTML baseline, equal accessibility trees, and compiler checks. Native framework exporters are built only if three paying teams ask or the agent route fails.

## 9. Roles and permissions

Organization role and project role are separate. Roles are presets over named capabilities, enforced by row-level security.

| Level | Role | Release |
|---|---|---|
| Organization | Owner, Admin, Member | R1 |
| Organization | Billing admin | R2 |
| Organization | Library maintainer, Auditor, custom roles | R4 |
| Project | Lead, Designer, Reviewer, Viewer | R1 |
| Project | Researcher, Product manager, Developer | R2 |
| Project | Writer | R3 |
| Either | Guest, Approver designation | R1 |

| Capability | Lead | Designer | Researcher | PM | Developer | Reviewer | Viewer |
|---|---|---|---|---|---|---|---|
| View design and snapshots | Y | Y | Y | Y | Y | Y | Y |
| Comment, suggest | Y | Y | Y | Y | Y | Y | N |
| Edit design, accept suggestions | Y | Y | N | N | N | N | N |
| Add sources and evidence | Y | Y | Y | Y | N | Y | N |
| Record decisions | Y | Y | Propose | Y | Propose | Propose | N |
| See raw transcripts and participant details | Y | N | Y | N | N | N | N |
| Create and assign tasks | Y | Y | Y | Y | Y | N | N |
| Export, handoff, code mapping | Y | Y | N | View | Y | N | N |
| Release | Y | Y | N | N | N | N | N |
| Approve, if named approver | Y | Y | Y | Y | Y | Y | N |
| Manage project members, strict override | Y | N | N | N | N | N | N |

Solo organizations see none of this. Approve is replaced by Release.

## 10. Workflow rules

| Effect | Rule |
|---|---|
| Always blocked | Self-approval; agents approving; editing a snapshot; a 101st project; owning a second organization |
| Strict mode (opt-in) | Blocks approval or release when checks fail. Override needs a reason and a second person |
| Warning only | Skipped stages, unmet checks, fewer than the recommended test sessions |
| At approval | Exceptions are listed and accepted with a note |

R1 has one active editor per project. Reviewers use snapshots. Live co-editing arrives in R3.

## 11. Agent requirements

An agent's access is the lowest of the authorizing person's role, the token's scope and these write rules:

| Work | Agent may |
|---|---|
| Authorizing person's own unreviewed frames | Edit directly in a named run |
| Solo imported or released frames | Edit directly on the working copy |
| Team imports | Per page: Protected (suggest only) or Draft (owner's agent edits) |
| Approved or in-review team work, others' frames, tokens, components | Suggest only |
| Claims about people | Held until accepted |

Agents never approve, manage members, handle billing, or read raw transcripts and participant details.

Before accepting agent work, a person sees the agent, token, authorizing person, intent, a plain description of changes, visual comparison, and RDL last. A whole run can be undone. Changes that others made later are skipped and reported.

**Notes and tasks for agents (R1).** There is no chat with an agent in Rangoli. A person with permission leaves a note on a frame or layer, or a task for the project. Each one shows its author, target and status: Waiting for agent, Picked up, Run in progress, Done or Could not complete. A connected agent reads them through MCP, under the permissions of the person who connected it, and each piece of work becomes a named run that returns for review. The waiting state must be honest, since nothing happens until a connected Claude or Cursor picks it up.

Notes and tasks from permitted people are requests. Text from transcripts, mail, tickets and other comments is untrusted data, and never instructions.

**New MCP tools**

| Release | Tools |
|---|---|
| R1 | `project_list`, `project_open`, `run_start`, `run_end`, `run_status`, `changes_since`, `agent_wait`, `job_claim`, `job_finish`, `page_create`, `screen_frames_set`, `snapshot_get`, `health_report`, `code_map_get`, `code_map_set`, `design_rules`, `knowledge_get`, `design_profile_get`, `my_permissions`, `icon_insert`, `image_insert` |
| R2 | `workstream_get`, `item_list`, `item_create`, `item_update`, `evidence_add`, `knowledge_propose`, `icon_variants`, `icon_usage`, `icon_replace`, `image_adjust`, `palette_from_image` |
| R3 | `board_read`, `board_apply`, `test_summary`, `image_batch`, task and linked-ticket tools |

## 12. Project Knowledge

Knowledge grows from the project's work and is what people and agents read before changing it.

| Layer | Contents | Source |
|---|---|---|
| Design profile | Tokens and components in use, layouts, screens, naming, exceptions | Computed from each snapshot, with no AI |
| Project rules | Do and don't, scoped to project, workstream, screen or component | People; agents propose |
| Decisions and evidence | Section 8.3 | People; agents propose |
| Approved patterns | Solutions promoted from approved screens | Promoted at approval |
| Lessons | Test failures, rejected suggestions and reasons, launch results | Proposed from those events |
| Language | Glossary, tone, approved wording | People; agents propose |

**Rules.** Only a person activates an entry. Each records its scope, source, snapshot, owner, status and last confirmed date. Entries are superseded and not silently overwritten, and go stale when their screens or sources change. Screen rules override workstream, project, organization and global rules. Accessibility, legal and honesty rules can't be overridden. Participant details are excluded.

**Delivery.** Agents receive a short brief scoped to the screens in the task. Designers get a Knowledge page and "Why is it like this?". Repos receive an exported `DESIGN.md`. Checkable rules become project lint rules. Global rules live in `docs/knowledge/agent-design-rules.md`.

| Release | Scope |
|---|---|
| R1 | Design profile, project rules, scoped agent brief, `DESIGN.md` export |
| R2 | Proposals from approvals, rejections and decisions; staleness; patterns; Knowledge page; project lint rules |
| R3 | Proposals from threads and test findings |
| R4 | Promotion to organization knowledge, cross-project search |

## 13. Icon and Image Studios

**Must be fixed first.** The hosted app's security policy should block the studios' externally loaded libraries, the online icon library and Google Fonts. AVIF upload fails. These findings come from code reading and need confirming in a running app.

| Release | Icon Studio | Image Studio |
|---|---|---|
| R1 | Bundled libraries, zoom and pan, reorganized panel, insert in design, whole-set download | Bundled processing, AVIF fix, draggable crop, drag and drop, paste, re-editable edits, insert or replace in design, delete with usage warning |
| R2 | Keyline overlays, set consistency view, linked outline, solid and duotone variants, bulk edits, usage and replace everywhere, SVG optimization, React, Vue and Angular set export, licence record | Layers, masks, text, full adjustments, filters, focal point, compare, AVIF and responsive export, social sizes, 20 or more templates, colours to tokens, background removal |
| R3 | | Selection, erase, clone, heal, batch from CSV or project data |
| R4 | Organization library | Organization library, team's own image provider |

Generate, expand and AI object removal aren't built in. An agent or the team's own provider supplies them.

## 14. Non-functional requirements

- **Security:** database row-level security stays the tenant boundary. Scoped, expiring agent tokens. Hashed share links. Public surfaces show snapshots only and disable layer scripts.
- **Privacy:** interview data needs consent, retention and deletion. Test sessions never record keystrokes.
- **Compliance:** SOC 2, ISO 27001 and GDPR readiness begins during R1 and is required before a Business plan.
- **Accessibility:** the product itself meets WCAG 2.2 AA. Every drag action has a non-drag path.
- **Performance budgets:** single edit under 5 ms, compact screen read under 20 ms. Retained frames to 5,000 layers, culling to 50,000.
- **Reliability:** no runtime dependency on third-party script hosts.
- **Portability:** teams can leave with RDL text, DTCG tokens and HTML and CSS.

## 15. Technical direction

Full plan: `docs/ARCHITECTURE.md`. Its ranked security list must be complete before public launch, and its first three items before partners use real files.

- Keep the DOM canvas. No CRDT or WebGL editor. WebGL tiles are considered only beyond 50,000 layers.
- R1: operation log, per-page loading, incremental rendering, per-client selection.
- R3: WebSocket rooms, cursors, optimistic operations rebased on server order, last-writer-wins per property.
- Board objects are stored separately from design documents.
- Figma import is plugin-first, because REST limits are low on some seats and no documented Figma MCP tool returns raw nodes.
- New data: workstreams, screen frames, design operations, snapshot hashes, approval records, project roles, knowledge entries, design profiles, agent jobs.

## 16. Experience direction

**Point of view:** work beside your agent in the open, and approve by signing your name to one exact version.

Full direction and tokens: `docs/design/direction.md`. Mockups: `docs/design/mockups/`. This is design judgement and hasn't been tested with users. Test the seal and History with design partners before investing in them beyond R1.

**Opinions the product holds**
- **Say only what Rangoli can know.** Hashes, recorded writes and checks are stated as fact. An agent's own words are labelled "unchecked". No progress bars for work Rangoli can't see.
- **Colour is a rule.** Rani pink is for action, selection and focus. Marigold means a person signed. Teal dashed means an agent's unreviewed work. Passing checks stay quiet. The canvas is neutral, so the interface never tints the user's colours.
- **Status is a sentence.** No KPI tiles or percentages.
- **People are round, agents are square and dashed,** everywhere they appear.
- **Float the tools, not the work.** The user's frames sit on a full-bleed canvas with soft floating panels above it.
- **Stages are views.** No steppers or "next stage" buttons.
- **Agents leave a record, not a chat.** Conversation stays in Claude or Cursor. Rangoli shows runs, what changed and who authorized it.

**Shell.** A floating icon-and-label rail shows all stages and expands to include Home, Library, Knowledge, Releases and People. Floating clusters at the top hold location, tools and device, with presence, agent status and Send for review on the right. On the right side, Inspect floats above **For agents**, which shows connected agents and the queue of notes and tasks. History is a floating timeline. Review and Release open in a focus mode with no rail.

**Connecting an agent.** Each person connects their own Claude or Cursor to Rangoli's MCP server with a personal, project-scoped token: copy the command, then tell the agent to check its Rangoli queue. Rangoli shows Not connected, Connected and whose token, last seen, or Token expired.

**Leaving work for an agent.** Press `/` or use the pin tool. A composer opens beside the selection, and the user chooses Note or Task. The status moves through Waiting for agent, Picked up, Run in progress, and Done, ready to review. Rangoli says plainly that it can't make an agent start, and shows no timers or estimates while waiting.

**Signature moments**

| Moment | Behaviour | Release |
|---|---|---|
| The seal | A kolam computed from a version's content hash. Dashed while waiting, inked when a person signs. Appears on import, Approve, Release, Handoff and the stakeholder link. The hash remains the proof | R1 |
| History | A floating timeline of versions and runs, solid before the last signature and dashed after | R1 |
| Notes and tasks for agents | Pinned to a frame or layer, with an honest status and a clear queue | R1 |
| Whole-run undo | Undoes an agent's run and reports what stayed: "2 changes stayed" | R1 |
| Signed approval | The button names the version and the person: "Approve v14 as Lena Fischer" | R1 |
| Agent labelling | "Agent drafted, not reviewed" on the frame, with Mark reviewed and Discard. Only a person clears it | R1 |
| Status sentence | Generated from facts | R1 |
| Peek outside Review, selection travels, node-level highlight, run spotlight | | R2 at the earliest |

**First 30 seconds.** The user's own frames appear as they parse. A short report names real problems in their file. Confirm draws the kolam. New design opens ready to draw or leave a task for the agent. With no agent connected, tasks wait, Rangoli says so plainly, and it offers three ways to start by hand.
**Team and solo copy.** Solo users see "Release", "Released by" and "Changed since released", never "approved". Stakeholders get a separate view that works at phone width, with the kolam and a plain sentence first and hashes behind Proof.

**Interface requirements**
- Instrument Sans and JetBrains Mono, self-hosted. Minimum text size 12px. Control radius 8, panels 12.
- WCAG 2.2 AA in light and dark. Selection uses a white keyline, so it stays visible on blue.
- Single-key shortcuts work only while their region has focus and can be remapped. Every drag has a non-drag path.
- Motion respects reduced-motion settings.

**Estimate.** Rebuilding the current interface to this direction is about 10–13 engineer-weeks and is included in section 17.

**Not yet tested.** Screen readers, 200% reflow, full keyboard paths and real users.

## 17. Release plan

| Release | Goal | Rough engineer-weeks |
|---|---|---|
| R1 Approve | Figma import through approved handoff, including the interface rebuild and security baseline | About 94 (85–105) |
| R2 Prove | Proof in code, knowledge capture, tools at parity | About 72 |
| R3 Collaborate and test | Co-editing, board, work tools, usability tests | 55–60 |
| R4 Scale | Organization libraries, connectors, reach | 43.5–44.5 |
| **Total** | | **About 255–280** |

About 25–27 months for three engineers at 80% focus, and over 6 years for one. R1 alone is about 9 months for three engineers. Estimates are from `docs/ARCHITECTURE.md` and assume senior engineers with no credit for AI speed-up.

**Before R1 work:** sign 10 design partners, 5 of them committing a real file; test prices; complete the import gate and legal review.

**R1 cut order:** sample project; multi-factor login, keeping email verification; new lint checks; `DESIGN.md` export; automatic agent pickup of notes and tasks, keeping manual pickup from Claude or Cursor; linked device frames, keeping custom size; stakeholder comments, keeping view-only; re-import. Never cut import, snapshots, approval, handoff or the fixes that unblock the hosted studios.

**Pricing to test:** about $99 per workspace monthly with 5 editors, then about $15 each. Paid roles: Lead, Designer, Researcher. Other roles are free, and agents are never seats.

## 18. Risks

| Risk | Response |
|---|---|
| Figma ships approvals or cheaper tiers | Compete on neutrality and depth of checks; stop conditions in section 4 |
| Figma changes API limits or terms | Plugin first, JSON fallback, legal review |
| Figma files exceed the model or performance budget | Test real files before committing; page selection |
| Team too small for the scope | Hire; apply cut order |
| Sync rewrite destabilizes the editor | Feature flag and convergence tests |
| Users lack a connected agent | Track first-session connection; reviewers need no agent |
| Agents exposed to hostile text | Treat all outside text as data; a person activates knowledge |
| Interview data exposure | Role restrictions, consent, deletion |

## 19. Out of scope

Plugin marketplace and Community · branching · Figma Make, Sites, Slides, Buzz and Draw equivalents · full FigJam parity · AI generation inside the product · participant recruiting · recording and transcription · card-sort tool · hosting live websites · full mail inbox · general chat · new 3D investment.

## 20. Decisions needed from the founder

| Decision | Working assumption |
|---|---|
| Own one organization but allowed to be a guest in others? | Yes |
| Engineers available | Unknown; this sets R1 scope |
| Whiteboard in R3 or moved earlier? | R3, so approval and research capture ship first |
| Framework code requires a connected agent at first? | Yes |
| Live co-editing not in R1? | Agreed for now |
| Background removal: buy a licence, or find a permissive model? | Open; manual masking ships regardless |
| Fix hosted studio blockers now, before other work? | Recommended |
| Fix the critical security issues now? | Strongly recommended |
| Closed product or open-core? | Closed; remove the MIT licence from the engine and server now |
| Local mode scope | Free and closed-licence, with no importer, approvals or Health Report |
| R1 scope if working solo | Validate new designs with partners first, about 40 weeks, before building Figma import |
| Security list and external pen test required before public launch? | Yes |
| Brief downtime on each deploy for early partners? | Accept |
| Data region at launch | US first, unless partners require EU |
| Budget for pen test, SOC 2 and legal counsel | Approve before R1 ends |
