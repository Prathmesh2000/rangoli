# Rangoli — Specification v0.1

Agent-first, implementation-neutral design tool. Humans use the editor; AI coding agents (Claude Code, Cursor, any MCP client) use the same document through MCP. **Rangoli contains no AI and needs no API keys** — the connected agent is the intelligence; Rangoli is the precise workspace (model, render, rules, export, collaboration, history).

## 1. Principles
1. **Agent-first, human-friendly.** Every capability is an MCP tool first, a UI panel second. Same core engine for both.
2. **Token-efficient.** Agents read/write a compact text format (RDL) with detail levels and ID-based edits. Assets referenced by ID, never inline base64.
3. **Implementation-neutral.** Core model knows nothing about React/MUI/Tailwind. Libraries are adapters.
4. **Figma-shaped, CSS-renderable.** Model concepts map ~1:1 to Figma (auto layout, sizing, components/variants/overrides, variables/modes) and each has a CSS equivalent.
5. **Deterministic rules.** Linter, contrast, palette math, motion checks are pure functions — same input, same output, zero cost.
6. **Local-first.** `npx rangoli serve`; files on disk, git-friendly; optional self-hosted sync for teams. No cloud dependency.
7. **Measured performance.** TypeScript everywhere; Rust/WASM only behind interfaces where profiling proves need.

## 2. Architecture
```
 Agents (Claude Code / Cursor) ──MCP (stdio|http)──┐
 Humans ── Editor (browser / later Tauri) ──WS──┐  │
                                                ▼  ▼
                         @rangoli/server  (MCP · HTTP · sync · files · jobs)
                                       │
                         @rangoli/engine  (headless, pure TS)
       model · ops/history · rdl · tokens/palette · layout→css · render · lint · motion · export · adapters
```
Packages (npm workspaces):
- `packages/engine` — all logic, no I/O beyond explicit fs helpers. Fully unit-tested.
- `packages/server` — CLI (`rangoli`), MCP server, HTTP preview, WebSocket sync.
- `packages/editor` — UI (Vite + React). Phase 1.
- `packages/figma-plugin` — Figma import/export bridge. Phase 7.
- `adapters/*` — theme/component/motion exporters (react-mui, react-tailwind, …).

## 3. File format (`*.rangoli/` directory)
```
manifest.json        { format:"rangoli@1", name, pages:[{id,name}], activeAdapter? }
tokens.json          W3C DTCG tokens incl. modes ($extensions.rangoli.modes)
pages/<pageId>.json  { id, name, children:[NodeId], nodes:{ [id]: Node } }
components.json      { [componentId]: ComponentDef }
motion.json          motion definitions + timelines
prototype.json       interactions, flows, variables
reviews.json         comment threads, review pins, change sets
assets/<hash>.<ext>  svg/png/webp/fonts (content-addressed)
mappings/<adapter>.map  component → code mappings (per project)
```
Node IDs: short base36 (`n1`, `n2a`), stable forever, unique per document.

## 4. Core model
```ts
type NodeType = 'frame'|'text'|'vector'|'image'|'instance'|'group'
interface Node {
  id: string; type: NodeType; name: string; role?: string   // semantic role e.g. "primary-action"
  parent?: string; children?: string[]
  layout?: Layout; size?: Sizing; position?: Position         // position only when parent layout=none
  style?: Style; text?: TextContent; vector?: VectorData; image?: ImageRef
  component?: string; variant?: Record<string,string>; props?: Record<string,unknown>; overrides?: Record<string,Partial<Node>>
  hidden?: boolean; locked?: boolean
  figmaId?: string
}
interface Layout { mode:'none'|'row'|'col'|'grid'; gap?:Len; padding?:Len|[Len,Len]|[Len,Len,Len,Len];
  justify?:'start'|'center'|'end'|'between'|'around'; align?:'start'|'center'|'end'|'stretch'|'baseline';
  wrap?:boolean; columns?:number|string; rows?:string }
interface Sizing { w?:Dim; h?:Dim; minW?:Len; maxW?:Len; minH?:Len; maxH?:Len }
type Dim = { kind:'fixed', v:Len } | { kind:'hug' } | { kind:'fill' }
type Len = number | TokenRef     // number = px
interface Style { fill?:Paint[]; stroke?:Stroke; radius?:Len|[Len,Len,Len,Len]; shadow?:TokenRef|Shadow[];
  opacity?:number; blur?:number; blend?:string; clip?:boolean;
  textStyle?:TokenRef; color?:Paint; font?:Partial<Font> }
type TokenRef = { token: string }    // e.g. color.text.secondary
```
Figma mapping: FRAME/COMPONENT/INSTANCE/TEXT/VECTOR ↔ frame/frame+componentDef/instance/text/vector; layoutMode HORIZONTAL/VERTICAL/GRID ↔ row/col/grid; layoutSizing HUG/FILL/FIXED ↔ hug/fill/fixed; boundVariables ↔ TokenRef; strokeAlign INSIDE/CENTER/OUTSIDE ↔ stroke.align.

## 5. RDL — Rangoli Description Language (agent format)
Indentation = hierarchy. One node per line: `Name[#id] [type-or-component] [flags...] ["text"]`.
```
Card#n1 col gap3 p4 w320 fill:surface stroke:border r2
  Header#n2 row between center
    Text#n3 title-sm "Login smoke test"
    Chip#n4 @Chip variant=success "Passed"
  Text#n5 body-sm color:text.secondary "Last run 2 hours ago · 24 steps"
  Button#n6 @Button variant=primary size=sm "Run again"
```
- Type inference: `Text`-prefixed name or quoted text only → text; `@Comp` → instance; `Vector`/`Icon` → vector; else frame.
- Layout flags: `row col grid none wrap gapN pN pxN pyN ptN prN pbN plN start center end between around stretch baseline`.
- Size: `w320 h48 wfill hfill whug hhug minw200 maxw640`.
- Style: `fill:<token|#hex> stroke:<token>[/<width>] rN rfull shadow:<token> opacity:0.6 color:<token>` ; typography shortcut = any text-style token name (`title-sm`, `body`).
- Numbers after `gap/p/r` are **spacing/radius scale steps** (gap3 → spacing.3), `w/h` are px.
- Props/variants: `key=value`.
- Detail levels on read: `outline` (name#id role/type), `compact` (above), `full` (everything incl. resolved values).
- Edit commands (rdl ops):
  ```
  set #n4 variant=failed "Failed"
  insert #n1 end
    Text muted "Flaky in 2 of last 10 runs"
  move #n6 after #n2
  delete #n5
  ```
- Writes return changed IDs + lint deltas only.

Icon DSL (`icon` block): `icon name grid24 stroke1.5 round` then `line x1 y1 x2 y2`, `rect x y w h [r=]`, `circle cx cy r`, `arc`, `polyline …`, `path <simple M/L/Q/C/Z>`, macros `check plus chevron dot`. Auto-snap to 0.5 grid.

## 6. Tokens & palette
- Storage: W3C DTCG JSON. Groups: color, space, radius, shadow, font, textStyle, motion.duration, motion.easing, motion.spring, motion.distance, motion.scale.
- Modes: light / dark / highContrast; motion modes default / reduced.
- Palette engine: OKLCH ramps (50–950) from a seed; tinted neutrals; semantic aliasing; WCAG 2.2 + APCA contrast matrix; color-vision-deficiency simulation (protan/deutan/tritan); categorical/sequential/diverging chart palettes.
- Exports (built-in): DTCG JSON, CSS variables. Adapters: MUI createTheme, Tailwind config, SCSS, Figma variables, Flutter/SwiftUI/Compose later.

## 7. Rendering
- Reference renderer: model → semantic HTML + CSS (flex/grid). Used by editor preview and exports.
- Raster: resvg (SVG→PNG) for fast agent previews; headless Chromium (Playwright, optional) for full fidelity.
- Editor: DOM render of visible frames + canvas overlay for selection/guides.

## 8. Lint (deterministic)
Design rules (D*): off-scale spacing, raw hex/px instead of tokens, contrast fail, nested cards, too many font sizes, gradient-text/slop tells, icon-only button without label, missing states on interactive components, inconsistent radius.
Motion rules (M01–M14): see `motion.md` in ui-craft — slow, jank props, bounce, no reduced, scale-from-zero, origin, exit≥enter, stagger, loops, keyboard, decorative, flash, non-interruptible, layout shift.
Output: `{code, severity P0–P3, node, message, fix?: RdlOp}`.

## 9. Motion
Kinds: state transitions, enter/exit, keyframe timelines, smart animate, layout, vector morph/draw, value, scroll-driven, loops.
Motion DSL:
```
motion Button
  hover bg fast out
  press scale:press fast out
motion Dialog#n7
  enter opacity 0→1, scale popIn→1, y md→0 base out
  exit  opacity 1→0, scale 1→popIn fast in
timeline run-success 900ms
  #icon 0 scale 0.8→1 300 spring:snappy
```
Agent vision: `motion_filmstrip` (N frames in one PNG), `motion_curve` (value tables), `motion_timing`, `motion_compare`.
Exports: CSS (+ reduced-motion media query), WAAPI, Framer Motion (adapter), animated SVG, Lottie (later), MP4/WebM/GIF (headless).

## 10. Prototype
Triggers click/hover/press/key/delay/drag/scroll → actions navigate/overlay/swapVariant/scrollTo/setVar/conditional/back, transitions via motion engine, variables. Export standalone HTML prototype, share bundle, video, flow-map PDF.

## 11. Collaboration & review
- Yjs document per page (evaluate Loro for movable-tree semantics), WebSocket sync in `serve`, optional self-hosted relay.
- Presence for humans and agents. Roles: owner, editor, reviewer, viewer, agent (suggest-only by default).
- Change sets (suggestions) with before/after overlay, accept/reject per op. Comment threads with @mentions (incl. `@agent`). Review pins (P0–P3) with apply-fix. Visual diff (side/overlay/swipe). Frame status Draft → In review → Approved → Ready for dev. Full attributed history.

## 12. Studios
- **Icon Studio** — sets, 24px keyline grid, live sizes/contexts, icon lint, agent variants lane, export SVG/React/sprite/font.
- **Image Studio** — Compose (layout+vector → PNG/SVG/WebP, stays editable), Edit (crop/resize/adjust/mask/bg-removal local model/compress/blur-placeholder), Assets library. No generative provider; agents may `asset_upload` images produced elsewhere.

## 13. MCP tools (v1 surface)
Read: `doc_info, doc_outline, node_get, search_nodes, tokens_get, components_list, selection_get`
Write: `rdl_apply, apply_ops, create_from_html, tokens_set, component_create, suggest (change set)`
See: `render_html, render_png, render_states`
Quality: `lint, contrast_check, palette_generate, palette_check`
Motion/proto: `motion_set, motion_preset, timeline_set, motion_filmstrip, motion_curve, motion_lint, interaction_add, prototype_export`
Assets: `icon_create, icon_render, icon_lint, icon_publish, image_compose, image_edit, asset_upload`
Export/import: `export_code, export_svg, export_png, export_tokens, figma_import, figma_export`
Review: `review_add, review_list, comments_reply, changeset_list`
All tools accept `detail` where relevant and return compact text by default.

## 14. Adapters
Interface: `{ id, exportTheme(tokens), exportComponent(node, mapping), exportMotion(motion), importTheme?(source) }`. With no mapping, export falls back to neutral HTML/CSS. First adapters: html-css (built-in), react-mui, react-tailwind, figma.

## 15. Platform
Browser app served by `rangoli serve` (localhost) + installable PWA. Headless `rangoli mcp` / `rangoli render` for agents/CI. Tauri desktop wrapper later (Windows first). Reference renderer = headless Chromium + resvg for exports/diffs.

## 16. Performance budgets
Editor initial < 300 KB gz · 60 fps drag with 5k layers · `apply_ops` < 5 ms · compact read of a screen < 20 ms · agent PNG preview < 150 ms · LAN sync < 100 ms.

## 17. Phases
| # | Scope | Status |
|---|---|---|
| 0 | Engine: model, ops/history, RDL, tokens+palette+contrast, layout→CSS render, lint, HTML/CSS + token export; server: CLI + MCP + HTTP preview | in progress |
| 1 | Editor: canvas, layers, inspector (Design/CSS/Code), tokens & palette view, components, undo, live sync with agents, suggestion mode | |
| 2 | Motion tokens, state transitions, enter/exit, motion lint, CSS export | |
| 3 | Collaboration & review: rooms, roles, change sets, comments, pins, diff, history | |
| 4 | Timeline, smart/layout animate, vector morph, filmstrip, prototype + HTML/video export | |
| 5 | Icon Studio | |
| 6 | Image Studio (Compose/Edit/Assets) | |
| 7 | Figma bridge (REST import, plugin export), adapters react-mui/tailwind, PR visual diff | |

## 18. Team app

`rangoli app` hosts organizations and projects. The single-folder `rangoli serve` and `rangoli mcp` modes are unchanged.

**Tenancy.** Org → project → one design. Every tenant row has `org_id`; composite foreign keys keep a row inside its org. Designs, comments and versions live in Postgres. Image bytes live in S3 when `S3_BUCKET` is set, otherwise in Postgres; the `design_assets` row is the access decision either way, and files are served through the app rather than from public or presigned URLs.

**Access.** Row-level security is the boundary. The app logs in as `rangoli_login` and runs requests as `rangoli_app` (no ownership, no BYPASSRLS) with `app.user_id` set per transaction. Credentials are reachable only through SECURITY DEFINER functions. `packages/server/src/app/rls.test.ts` attacks this directly; `npm run test:postgres` runs it on a real server.

| Role | Scope | Can |
|---|---|---|
| admin | every project in the org | everything, including people, assignments and skipping a gate (recorded) |
| designer | assigned projects | edit the plan and design, request reviews, review teammates' work, move stages |
| reviewer | assigned projects | comment, suggest, approve stages, log findings and feedback; cannot edit |

**Lifecycle.** Discovery → Define → IA & flows → Wireframes → Visual design → Prototype → Usability testing → Handoff → Post-launch → next cycle. Gates in `packages/engine/src/lifecycle.ts` are computed from real data. Work cannot be added ahead of the current stage.

**Review.** Define, IA & flows, Wireframes, Visual design, Usability testing and Handoff need one: `working → in_review → changes_requested → in_review → approved → next stage`. Requesting review needs every check to pass, and freezes that stage's work and the canvas until someone requests changes or the review is withdrawn. A designer cannot decide a review they requested. A decision counts only for its round: entering the stage, requesting review or withdrawing starts a new one. A named version is saved on leaving each design stage.

**Deployment.** One app process per database, enforced by a Postgres advisory lock. See `deploy/aws/`.

**Limits.** Embedded PGlite runs as a single superuser session, so the login-role separation applies only on a Postgres server. Stage gates and freezes are enforced by the server; who may read or write which row is enforced by the database.
