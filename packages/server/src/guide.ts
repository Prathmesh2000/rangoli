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
- style: fill:<color> stroke:<color>[/width] color:<color> rN (radius step 1-5|full) shadow:sm|md|lg opacity:0.6 muted mono truncate clip
- color names are tokens: surface canvas subtle border text.secondary primary.600 status.error.fg … (#hex allowed but linted)
- text: quoted string; text style = token name (caption label body-sm body body-lg title-sm title headline display code)
- components: @Button(variant primary|secondary|ghost|danger, size sm|md|lg) @Chip(variant success|warning|error|info|neutral) @Input(size, state default|error|disabled; text=placeholder)
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
- SEE your work: render_png (screenshot) and motion_filmstrip (animation frames). Look before you say "done".
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
