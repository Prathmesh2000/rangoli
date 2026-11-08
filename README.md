# Rangoli

Agent-first, implementation-neutral design tool. AI coding agents (Claude Code, Cursor, any MCP client) design through a compact text language (**RDL**); humans watch, select and review in a live browser preview. Rangoli has **no AI inside and needs no API keys** — the connected agent is the intelligence; Rangoli is the precise workspace: model, tokens, render, lint, export, history.

Full spec: [docs/SPEC.md](docs/SPEC.md)

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Engine (model, atomic ops + undo, RDL, OKLCH tokens + contrast, HTML/CSS renderer, linter, file format) + MCP server + live preview + CLI | ✅ done |
| 1 | Visual editor: canvas (shadow DOM, exact CSS), layers, inspector (Design/RDL/CSS), tokens & palette, lint with one-click fixes, activity feed, live sync with agents, shared undo, copy/paste as RDL | ✅ done |
| 2 | Motion as data (RDL `motion` blocks): states → CSS transitions, enter/exit → keyframes, springs → CSS `linear()`, automatic reduced-motion variants, motion lint (M01–M11), presets, `motion_curve` value tables for agents, editor Motion tab with replay | ✅ done |
| 3 | Collaboration & review: agent "Apply directly / Ask first" mode, suggestions (change sets) with side-by-side / stacked compare + accept/reject, comment threads with @agent inbox, review pins with one-click fixes, named versions + diff, presence, LAN sharing with editor/reviewer/viewer invite links | ✅ done |
| 4 | Timeline, smart/layout animate, prototype + exports | |
| 5 | Icon Studio | |
| 6 | Image Studio (compose/edit) | |
| 7 | Figma bridge, framework adapters (React-MUI, Tailwind…) | |

## Quick start

```bash
npm install
npm run build
node packages/server/dist/cli.js init ./designs/app.rangoli --name "My App" --brand "#2a6fb0"
node packages/server/dist/cli.js serve ./designs/app.rangoli
# editor:  http://127.0.0.1:4400/editor/
# preview: http://127.0.0.1:4400/
```

### Connect Claude Code

```bash
claude mcp add rangoli -- node <abs-path>/packages/server/dist/cli.js mcp <abs-path>/designs/app.rangoli
```
The MCP server also starts the live preview (default port 4400). Open it in a browser: changes appear as the agent works; click elements to select them (the agent reads them with `selection_get`).

Cursor: add the same command under MCP servers in Cursor settings.

## RDL in 10 seconds

```
Card col gap3 p4 w320 fill:surface stroke:border r3
  Header row between center
    Text title-sm "Login smoke test"
    @Chip variant=success "Passed"
  Text body-sm muted "Last run 2 hours ago"
  @Button variant=primary size=sm "Run again"

set #n4 variant=error "Failed"
move #n6 before #n2

motion #n1
  enter opacity:0, scale:popIn, y:md base out
  exit opacity:0, scale:popIn fast in
```
~3.5× fewer tokens than HTML+CSS for the same UI. Values are design tokens (spacing steps, color names, text styles), so output stays on-system and is themeable (light/dark).

## MCP tools

`doc_info · doc_outline · node_get · search_nodes · rdl_apply · rdl_check · undo · redo · history · lint · tokens_get · tokens_set_brand · token_set · palette_generate · contrast_check · render_preview · export · selection_get · motion_get · motion_curve · motion_presets · motion_preset · suggest · suggestions_list · comments_list · comment · inbox · review_add · version_save · versions_list · diff · rdl_help`

Every `rdl_apply` returns lint issues for the affected screen, with ready-to-apply RDL fixes.

## Collaboration

```bash
node packages/server/dist/cli.js serve ./designs/app.rangoli --share
# prints invite links:  editor / reviewer / viewer  (http://<your-lan-ip>:4400/editor/?t=…)
```

- Your own machine is always the owner. Everyone else needs an invite link (token → HttpOnly cookie).
- Viewer: read · Reviewer: comment + suggest · Editor: edit + accept/reject · Owner: + agent mode, invites.
- Agent mode (Review tab): **Apply directly** or **Ask first** — in Ask first, the agent's `rdl_apply` becomes a suggestion you accept or reject after comparing before/after.
- Mention `@agent` in a comment; the agent sees it via the `inbox` tool and replies in the thread.
- Reviewers (e.g. the darshana-thakur subagent) post findings with `review_add`; each becomes a pin on the canvas with an optional one-click fix.
- The server is the single source of truth (edits are serialized as RDL), so there is no CRDT and no merge conflicts — a suggestion that no longer applies is flagged instead.

## Editor

Every human edit is sent as RDL to the same server the agent uses — one history, one undo stack, live on both sides. The canvas renders with the same engine and CSS as export.

Shortcuts: Delete · Ctrl+Z / Ctrl+Shift+Z · Ctrl+D duplicate · Ctrl+C copies selection as RDL (paste into your agent chat) · Ctrl+V pastes RDL · Enter / Shift+Enter select child / parent · Alt+↑/↓ reorder · Esc deselect · Ctrl+wheel zoom · Shift+1 fit

## Performance (4,001-node document)

| | budget | measured |
|---|---|---|
| single edit | < 5 ms | 0.13 ms median |
| compact read of a screen | < 20 ms | 8.6 ms |
| render to HTML/CSS | — | 42 ms |
| lint | — | 54 ms |

## Layout

```
packages/engine   headless TypeScript engine (no deps)
packages/server   CLI · MCP server · live preview · editor API
packages/editor   visual editor (React, 62 KB gzipped)
scripts/          editor-shots.mjs — visual smoke test in system Edge
examples/         demo document + test-runs.rdl
docs/SPEC.md      specification
```
