# Rangoli build plan

**Readers:** coding agents and whoever coordinates them. **Scope:** everything in `docs/PRD.md`, built as one program rather than stopping at each release. `docs/ARCHITECTURE.md` is the technical authority. `docs/design/direction.md` is the design authority.

## Rules for every wave

- A wave starts only when the previous wave's dependencies are complete.
- Agents working at the same time own separate files. New work goes in new modules where possible.
- After each wave: `npx tsc -b`, `npx vitest run`, `npm run test:postgres`, `npm run build`, then a browser smoke test of the affected flows.
- A wave isn't complete while any of those fail. Failures are reported, not skipped.
- Security regression tests are never weakened to make a change pass.
- Each wave ends with a saved checkpoint.
- No agent changes licences, pushes code, deploys or touches real customer data.

## Waves

| Wave | Goal | Work | Depends on |
|---|---|---|---|
| 0 | Stop the bleeding | Content safety, server access boundaries, bundled studio libraries, AVIF | None |
| 0P | Independent parts | Figma plugin package; UI kit from the design direction; kolam, capabilities, snapshot hashing, design profile modules | None; new files only |
| 1 | Foundations | Migration runner, CI, telemetry; render service isolation; op log, validation, path patches, per-page load; icon and font proxy | 0 |
| 2 | Identity and access | Email verification, MFA, sessions, scoped tokens; organization and project roles; one-org and 100-project limits; always-open stages; Workstream Main | 1 |
| 3 | Core canvas and proof | Incremental render and spatial index; canvas fundamentals, snapping, pages; device frames; snapshots, hashes, approvals, handoff from snapshot | 1, 2 |
| 4 | Agent platform | Org-level MCP, runs, whole-run undo, write policy, notes and tasks, job leases, connect flow, Project Knowledge, `DESIGN.md` | 2, 3 |
| 5 | New interface | Shell, Home, stage views, For agents, composer, History, kolam, Review and Release, stakeholder link, solo copy, accessibility pass | 3, 4, 0P |
| 6 | Import and export | Figma parser and model work, Health Report, re-import; semantic HTML, React, Vue and Angular recipes, verification harness | 3, 0P |
| 7 | Prove | Trust panel and per-frame accept; Library Changes; evidence, interviews, decisions, search; Design QA and pull request check; billing, SSO, activity log; device overrides; Studio parity | 4, 5 |
| 8 | Collaborate and test | WebSocket and co-editing; workstreams; tasks, Jira, threads, mail replies, review sessions; board; flows; test links, heatmaps, tree test | 5, 7 |
| 9 | Scale | Organization library, drift, docs site, analytics, connectors, custom roles, recipe library, re-import diff, per-project scale-out | 7, 8 |
| 10 | Harden | Full security checklist, load tests, accessibility sign-off, restore drill, documentation | All |

## Needs a person

Agents can build the code for these, but can't complete them:

| Item | Needed from |
|---|---|
| Testing import on 10 real Figma files | Design partners |
| Legal review of Figma's terms and the licence | Lawyer |
| Licence decision and customer terms | Founder |
| External penetration test, SOC 2 audit | Security firm, auditor |
| Figma plugin publishing | Figma account |
| Jira, Slack, Teams, Stripe, Google and Microsoft app credentials | Founder's accounts |
| Production AWS deployment and domains | Founder's AWS account |
| Usability testing with real designers | Designers |

Until these are done, the features build against test doubles, and each is listed as unverified.
