/** Short guide sent as MCP server instructions — agents read this on connect. Keep it tight. */
export const INSTRUCTIONS = `Rangoli is a design workspace. You (the agent) design; Rangoli stores, renders, lints and exports.
Work in RDL (compact text). Read with doc_outline / node_get, write with rdl_apply, check with lint, look with render_preview.

RDL quick reference (one node per line, indentation = children):
  Card#n1 col gap3 p4 w320 fill:surface stroke:border r3
    Header row between center
      Text title-sm "Login smoke test"
      @Chip variant=success "Passed"
    Text body-sm muted "Last run 2 hours ago"
    @Button variant=primary size=sm "Run again"
- layout: row col grid cols3 none wrap gapN pN pxN pyN ptN prN pbN plN (N = space scale step: 0.5 1 1.5 2 3 4 5 6 8 10 12 16 24)
- align: start center end stretch baseline · justify: between around jstart jcenter jend · middle (both center)
- size: w320 h48 (px) wfill hfill whug hhug minw/maxw/minh/maxh<px>
- style: fill:<color> stroke:<color>[/width] color:<color> rN (radius step 1-5|full|card|control) shadow:sm|md|lg opacity:0.6 muted mono truncate clip
- color names are tokens: surface canvas subtle border text.secondary primary.600 status.error.fg … (#hex allowed but linted)
    alpha: primary.600~40 · gradients: fill:linear(135,primary.500,primary.800@80) fill:radial(c1,c2)
- anything else (no limits): stroke:c/w/dashed|dotted/sides(t r b l, e.g. b or tb) · r:tl,tr,br,bl · shadow:x,y,blur,spread,color[,inset] (+ shadow+: to add layers)
    font:"IBM Plex Sans"|display|mono lh:1.4 ls:-0.02em italic underline strike upper lower capitalize align:justify
    blur:4 bgblur:12 (frosted) blend:multiply rotate:-8 z:2 overflow:hidden|auto cursor:pointer ratio:16/9
    abs at:x,y (float inside any parent: badges, stickers, overlays) · css:"filter:grayscale(1)" (plain declarations only)
- draw with a pen: Shape w120 h40 d:"M2 20 Q32 2 60 20 T118 20" stroke:primary.600/3  (SVG path, coords in vb:w,h — default = size)
    or shape language: Logo w48 h48 vb:24,24 shapes:"circle 12 12 10 fill=true c=primary.600|polyline 7 12 11 16 17 8" stroke:white/2
- your own components (nothing is fixed):
    restyle / add variants:  component @Button  then lines  "variant=pill rfull px6 fill:success.600" · "* shadow:md" (all) · "component @Button reset"
    building block from layers:  component @PlanCard from #n12 ["description"] [keep] → text/icon/image layers become props by
      layer name (@PlanCard "Team" price="$49" note=none mark=ui/star). Linked: component @PlanCard detach #id → edit → from #id updates all.
    components_list shows them under "This document"; component_help shows slots and your rules.
- design language: design_language (no id = list) switches type, density, radii, elevation and motion for every component at once:
    rangoli material fluent cupertino carbon editorial playful brutalist dense. Pick one that fits the product before styling by hand.
- text: quoted string; text style = token name (caption label body-sm body body-lg title-sm title headline display code)
- components (≈30, see components_list / component_help): Button IconButton Link · Input Textarea Select SearchInput Checkbox Radio
    Switch Slider Segmented Rating · Badge Chip Tag Status Avatar Kbd Divider Tooltip Skeleton Spinner ProgressBar RunBar ·
    Tabs Breadcrumbs Pagination Stepper · Alert Toast.   e.g. @Status variant=failed · @Tabs selected=1 "Overview|Runs:24|Settings"
- patterns (one line → editable layers, see patterns_list / pattern_help): +page-header +stats +toolbar +table +sidebar-nav +topbar
    +form +form-field +settings-row +modal +drawer +dropdown-menu +command-palette +empty-state +run-summary +test-case …
    e.g.  +table cols="Run|Status|Owner|Duration" rows=6 select=true   — build whole screens from patterns, then refine with set/insert.
- edit: set #id <flags> ["text"] · insert #id start|end|index N (children) · insert #id before|after (siblings) · move #id before|after #x · move #id into #p [start|end] · delete #id · replace #id + block
- motion (block): motion @Button [variant=primary] | motion #id   then indented lines:
    <trigger> <prop:value>[, …] <duration> <easing>     trigger: hover press focus disabled selected enter exit
    props: opacity scale x y rotate fill color stroke shadow ring · enter single value = FROM, exit single value = TO, or a→b
    duration: instant fast(120) base(200) slow(300) panel(350) | 180ms · easing: out in inOut drawer linear spring:snappy|gentle
    e.g. motion #n7 / enter opacity:0, scale:popIn, y:md base out / exit opacity:0, scale:popIn fast in   ·  "motion #n7 none" removes
  Motion rules: explain change, never decorate; ≤200ms for hover/press; exits faster than enters; no bounce, no hover-lift on static cards.
  Use motion_presets / motion_preset, and motion_curve to "see" timing as numbers.
- prototype: every top-level frame is a screen.
    proto start #screen
    proto #id  then lines: <trigger> <action> [#target] [variant=x] [timeline:name] [transition [dir]] [duration] [easing]
      trigger: click hover press delay:<ms> key:<Key> · action: navigate overlay close back swap play
      transition: instant dissolve slide|push left|right|up|down smart (matches layers by name path)
    timeline name  then lines: #id <startMs> <prop:value>[, …] <duration> <easing>   (single value = FROM)
  e.g. proto #n7 / click navigate #n20 smart base out  ·  timeline welcome / #n5 0 opacity:0, y:sm base out
- icons: use in designs as  Icon icon:clock w16 h16 color:text.secondary  (inside @Button/@Chip it leads the label, color = currentColor)
    define/edit:  icon ui/flask-check   then shape lines on a 24 grid, live area 1.5–22.5, coordinates on 0.5 steps:
      line x1 y1 x2 y2 · polyline x y … · polygon x y … · rect x y w h r=2 · circle cx cy r · dot cx cy [r] · arc cx cy r startDeg endDeg
      plus cx cy size · path M L H V Q C Z (absolute only)
    Match the set: same stroke (no per-icon stroke), similar optical size, ≤ 8 shapes, no detail < 1 unit.
    Variants for a human to pick: icon drafts/<name>~1 … ~4, then icon_render them together. icon_list / icon_get / icon_export.
- images: Image asset:<id> w640 h360 fit:cover alt:"what it shows"   (or decorative) · Image w320 h180 = empty slot placeholder
    asset_upload (local file) · asset_list · image_edit (crop/resize/rotate/flip/adjust → new webp asset) · image_placeholder
    compositions = frames with role:image (image_templates / image_template), then image_export → png/webp @2x (+ saveAsAsset)
    illustration shapes may use fill=true and c=<color token> (e.g. iconset art grid96, circle 48 48 30 fill=true c=primary.100)
    No AI image generation here: compose from layout, type, icons and shapes, or upload an image you made elsewhere.
- SEE your work: render_png (screenshot), motion_filmstrip (animation frames), icon_render (icons at sizes + in context), image_export (returns the image). Look before you say "done".
Rules: use tokens not raw values; one primary action per view; every script is atomic + one undo step.
Collaboration: check doc_info for agent mode — in "suggest" mode your rdl_apply becomes a suggestion a human approves.
  Use suggest for big/subjective changes anyway. Check inbox for @agent mentions and reply with comment.
  Reviewers post findings with review_add (pins with optional RDL fixes). diff shows what changed vs a version/suggestion.
Always run lint after changes and fix P0/P1. Call rdl_help for the full reference.`;

export const RDL_HELP = `${INSTRUCTIONS}

FULL REFERENCE
Node head:  Name[#id]   or   @Component[#id]   or   Name[#id] @Component
  Type inference: @Comp → instance; name starting Text/Label/Title/Heading/Caption → text;
  Icon/Vector → vector; Image/Img/Avatar → image; else frame. Force with flags: text frame vector image group.
  A frame with only a quoted string and no children becomes text.
Ids: omit to auto-assign (n1, n2…). Provide #id only when you need a specific id.
Raw values: gap5px p13px r7px are accepted but flagged by lint (D02/D14). Prefer scale steps.
Props: key=value (variants validated against component axes); key="quoted value" allowed.
Position (only inside 'none' layout): at:x,y
Role (semantic hint for exporters/review): role:primary-action
Text align: align:left|center|right
Detail levels for reading: outline (names/ids/types only — cheapest) · compact (full RDL) · json (raw model)
Lint codes: D01 raw color · D02 off-scale spacing · D03 contrast · D04 nested cards · D05 too many text styles
  D06 gradient (slop tell) · D07 too many radii · D08 tiny text · D09 multiple primary buttons · D10 unlabeled button
  D12 empty frame · D14 off-scale radius · D15 missing token. Each issue may carry a ready-to-apply "fix:" RDL line.
  Motion: M01 slow · M02 janky property (w/h/shadow/blur) · M03 bouncy spring · M05 scale from < 0.8 · M07 exit ≥ enter
  M10 slow focus feedback · M11 hover lift/scale on a non-interactive element (slop tell).
Motion CSS: states → transitions (interruptible); enter → keyframes on mount; exit → add [data-exiting] then remove the
  element after the animation; reduced motion is generated automatically (fades kept, movement removed).`;
