# Rangoli

Agent-first, implementation-neutral design tool. AI coding agents (Claude Code, Cursor, any MCP client) design through a compact text language (**RDL**); humans watch, select and review in a live browser preview. Rangoli has **no AI inside and needs no API keys** — the connected agent is the intelligence; Rangoli is the precise workspace: model, tokens, render, lint, export, history.

Full spec: [docs/SPEC.md](docs/SPEC.md)

## Component library

~30 components (Button, IconButton, Link, Input, Textarea, Select, SearchInput, Checkbox, Radio, Switch, Slider, Segmented, Rating, Badge, Chip, Tag, Status, Avatar, Kbd, Divider, Tooltip, Skeleton, Spinner, ProgressBar, RunBar, Tabs, Breadcrumbs, Pagination, Stepper, Alert, Toast) and ~32 one-line patterns (+page-header +stats +toolbar +table +sidebar-nav +topbar +form +settings-row +modal +drawer +dropdown-menu +command-palette +date-picker +combobox +empty-state +run-summary +test-case …). Inventory cross-checked against component.gallery (60 types across ~95 design systems) and MUI categories. Every component and pattern is rendered, linted and visually reviewed in light and dark.

```
App row w1440 h900 fill:canvas clip
  +sidebar-nav selected=2
  Main col wfill
    +topbar
    Content col gap6 p6 wfill
      +page-header title="Test runs" crumbs="Checkout/Runs"
      +stats
      +toolbar
      +table cols="Run|Status|Owner|Duration|Started" rows=6 select=true
```

## Make it yours

Nothing in the library is fixed, and everything below works the same for a human in the editor and an agent over MCP.

| Need | How |
|---|---|
| A different look everywhere | `language material` (also rangoli, fluent, cupertino, carbon, editorial, playful, brutalist, dense): type, density, radii, elevation and motion in one undoable step |
| Any single token | `token color.primary.600 #1d4ed8 dark=#60a5fa` · `token textStyle.body.fontSize 15` |
| Any style on a layer | gradients, `token~alpha`, layered shadows, per-corner radius, per-side borders, typography, blur, blend, rotate, `abs at:x,y`, and `css:"…"` for the rest; `unset:…` clears |
| Restyle a component or add a variant | `component @Button` then `variant=pill rfull px6`. Survives library upgrades; `component @Button reset` undoes it |
| Your own building blocks | `component @PlanCard from #n12`. Text, icon and image layers become props; `detach`, edit and `from` again to update every instance |
| Your own colours | `token color.custom.sunset #ff5a1f`, or Save in the colour picker; paste whole palettes |
| Any font | all 1,959 Google Fonts load on use; `fontface "Brand" url=https://…` or upload your own |
| Any theme | `theme ocean preset=ocean`, or `theme brand bg=#101820 primary=#ffb000`; edit any token per theme |
| Image backgrounds | `fill:image(asset-or-url,cover,top,neutral.900~40)` |
| Behaviour | `script:"…"` per layer, with ready snippets; runs on exports and in the sandboxed Run view |
| 3D and web3 | `@Scene3D` (three.js), wallet and transaction components, swap, mint, staking and governance patterns |
| Icons | 2,109 built-in icons, online collections, SVG import or image trace. The vector editor has pen, pencil, shape builder, boolean operations, branching paths, live symmetry, gradients and width profiles; export SVG, React, a sprite or an icon font (TTF, WOFF, CSS) |
| 3D models | `model url=https://….glb`, or upload a .glb in 3D Studio (15 MB limit) |
| Something that does not exist | draw it: pen paths with `d:"M2 20 Q32 2 60 20"`, or the editor's frame, rectangle, ellipse, line, pen and text tools |

## Status

| Phase | Scope | State |
|---|---|---|
| 0 | Engine (model, atomic ops + undo, RDL, OKLCH tokens + contrast, HTML/CSS renderer, linter, file format) + MCP server + live preview + CLI | ✅ done |
| 1 | Visual editor: canvas (shadow DOM, exact CSS), layers, inspector (Design/RDL/CSS), tokens & palette, lint with one-click fixes, activity feed, live sync with agents, shared undo, copy/paste as RDL | ✅ done |
| 2 | Motion as data (RDL `motion` blocks): states → CSS transitions, enter/exit → keyframes, springs → CSS `linear()`, automatic reduced-motion variants, motion lint (M01–M11), presets, `motion_curve` value tables for agents, editor Motion tab with replay | ✅ done |
| 3 | Collaboration & review: agent "Apply directly / Ask first" mode, suggestions (change sets) with side-by-side / stacked compare + accept/reject, comment threads with @agent inbox, review pins with one-click fixes, named versions + diff, presence, LAN sharing with editor/reviewer/viewer invite links | ✅ done |
| 4 | Prototype (`proto` blocks: navigate/overlay/close/back/swap/play; dissolve/slide/push/smart animate; delay & key triggers), timelines (`timeline` blocks → CSS + player), standalone HTML prototype + live `/play`, agents SEE via `render_png` + `motion_filmstrip`, one server per document (agents attach over `/mcp`) | ✅ done |
| 5 | Icon Studio: shape language on a 24 grid (line/polyline/polygon/rect/circle/dot/arc/path), 0.5 snapping, icon lint (grid, live area, stroke, tiny detail, complexity, optical size), 21-icon starter set, `Icon icon:clock` in designs (currentColor, leads button labels), drafts → Keep, `icon_render` sheet, SVG/React/sprite export | ✅ done |
| 6 | Image Studio: content-addressed assets (`Image asset:… fit:cover alt:"…"`), non-destructive edits (crop/resize/rotate/flip/adjust → WebP/JPEG/PNG) in the system browser's canvas, blur placeholders, compositions (frames with role:image + social-card / empty-state / banner templates) exported at 1–3×, image lint (alt, weight, upscaling, distortion, missing), safe asset serving | ✅ done |
| 6.5 | Customisation: full style properties, 9 design languages, component restyling and building blocks, charts and rich components, 30 more patterns, drawing tools, full inspector, token editing | ✅ done |
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
The MCP server also starts the editor (default port 4400). If the editor is already running for that document (`rangoli serve`), the agent attaches to it instead — one process, one history, no overwrites. HTTP MCP clients can connect to `http://127.0.0.1:4400/mcp` directly (this machine only). Open it in a browser: changes appear as the agent works; click elements to select them (the agent reads them with `selection_get`).

Cursor: add the same command under MCP servers in Cursor settings.

## Team app

Organizations, projects, roles and the full UI/UX lifecycle, on Postgres with row-level security.

```bash
npm run build
node packages/server/dist/cli.js app --data ./rangoli-data --port 4400
# open http://127.0.0.1:4400/ and create the first account
```

The embedded database needs no setup. For AWS (RDS PostgreSQL, S3, ECS Fargate, SES), see [deploy/aws/README.md](deploy/aws/README.md). Details: [docs/SPEC.md](docs/SPEC.md) §18.

`npm run test:postgres` runs the database and app tests against a real PostgreSQL 17 server set up like RDS.

Agents connect per project with a token from the account menu:

```bash
claude mcp add --transport http rangoli https://host/d/<project-id>/mcp --header "Authorization: Bearer rng_..."
```

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

timeline rows
  #n17 0 opacity:0, y:sm base out
  #n1f 60 opacity:0, y:sm base out
proto start #n1
proto #ni
  click navigate #np smart base out
```

Play it: `http://127.0.0.1:4400/play` (or **▶ Play** in the editor). Export: MCP `prototype_export` → one self-contained HTML file.
~3.5× fewer tokens than HTML+CSS for the same UI. Values are design tokens (spacing steps, color names, text styles), so output stays on-system and is themeable (light/dark).

## MCP tools

`doc_info · doc_outline · node_get · search_nodes · rdl_apply · rdl_check · undo · redo · history · lint · tokens_get · tokens_set_brand · token_set · palette_generate · contrast_check · render_preview · export · selection_get · motion_get · motion_curve · motion_presets · motion_preset · suggest · suggestions_list · comments_list · comment · inbox · review_add · version_save · versions_list · diff · proto_get · prototype_export · render_png · motion_filmstrip · icon_list · icon_get · icon_render · icon_export · components_list · component_help · patterns_list · pattern_help · asset_upload · asset_list · image_edit · image_templates · image_template · image_export · image_placeholder · rdl_help`

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

Tools: V select · F frame · R rectangle · O ellipse · L line · P pen (click for corners, drag for curves, Enter to finish, click the first point to close) · T text. Hold Shift for squares, circles and straight lines. Drag a selected free-floating layer to move it, arrow keys nudge it, the corner handle resizes.

The inspector takes any value in every field, with tokens suggested; emptying a field clears that property.

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
