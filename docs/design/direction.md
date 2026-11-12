# Rangoli: modern direction

**Point of view, unchanged:** work beside your agent in the open, and approve by signing your name to one exact version. Design judgement only; no user research exists. Supersedes PRD section 16 on shell, type, avatars and `/`.

## What changed and why

The old build read as a ledger: flat grey, rows, text. Now the user's frames sit on a full-bleed canvas and everything else floats above it, in a confident brand colour, with real icons, avatars and larger type. Kept: kolam seal, "Approve v14 as Lena Fischer", honest statements, stages that never lock, solo and stakeholder copy.

**Founder correction.** Agents cannot talk through Rangoli. There is no prompt or reply. People leave notes and tasks; the agent collects them through Rangoli's MCP server from the user's own Claude or Cursor, works as a named run, and the result returns for review. Agent wording is now "Claude Code's summary, unchecked", so "note" means only a person's note.

## Principles

1. **Say only what Rangoli can know.** It knows connections, pickups, writes, hashes. It cannot start an agent or predict one.
2. **Colour is a rule.** Rani: action, selection, focus. Marigold: a person signed. Teal dashed: agent, unreviewed. Passing is quiet.
3. **People are round, agents are square and dashed.** Everywhere.
4. **Float the tools, not the work.** The canvas stays neutral.
5. **Stages are views.** Only approvals bind.

## Tokens

**Type:** Instrument Sans 400/500/600; JetBrains Mono for hashes and tokens, replacing Schibsted and DM Mono. Self-hosted. 12/16, 13/18, 14/20, 16/24, 20/28, 24/32, 28/36, 36/44. Headings 24 and up track -0.015em. Floor 12.

**Space:** 4, 8, 12, 16, 20, 24, 32, 40, 48, 64. **Radius:** 6 inner, 8 controls, 12 panels, 14 sheets, full for avatars. Frames keep the user's corners.

Light, then dark:
```
canvas      #EAEAEA #232323
ground      #F5F4F6 #131114
surface     #FFFFFF #211E23
surface-2   #F4F2F5 #2B282E
surface-3   #EAE7EC #37333A
line        #E7E4E9 #37333A
control     #847E87 #8F8993
text        #1B181D #F3F1F4
text-2      #4E4952 #C8C3CB
text-3      #68626C #A6A0A9
brand       #BD1560 #FF7FB2
brand-press #9C0F4F #FF9CC4
on-brand    #FFFFFF #2E0717
brand-wash  #FBE9F1 #401630
brand-ink   #8E0E4B #FFBAD5
agent       #00686F #5CCBD1
on-agent    #FFFFFF #07292B
agent-wash  #DDF0F0 #12302F
seal        #F2A900 #F5B82E
on-seal     #1D1500 #1D1500
seal-line   #825500 #F5B82E
seal-wash   #FDF1D3 #33280D
fail        #B3261E #FF9A8F
fail-wash   #FBE7E4 #3A1A17
warn        #994700 #F2A36A
warn-wash   #FBEBDD #35230F
```
Canvas selection is fixed at #BD1560 with a white keyline in both themes, because the frames are the user's. Avatar tints are plum, slate and clay, never marigold or teal.

**Elevation:** e1 panels: hairline ring, 1px contact, 8/24 soft shadow. e2 popovers: 20/48. Dark uses a white-alpha ring and lighter surfaces.

**Motion:** keyboard 0; hover 120; popovers 200; panels 240; seal wash 480; kolam draw 640, once. Ease out (.2,0,0,1); sheets (.32,.72,0,1). Only transform and opacity, plus the kolam stroke. Reduced motion shows finished marks.

## Shell

- **Rail:** floating, 84px icon over label, ten stages always visible. Expands to 232 with Home, Library, Knowledge, Releases, People, as on Project home.
- **Top:** floating clusters for location, tools, viewport; on the right presence, agent status, Send for review.
- **Right:** Inspect floats above **For agents**.
- **History:** floating timeline. Solid before the last signature, dashed after. No kolam.
- **Review and Release:** focus mode, no rail: changes left, signing sheet right, seal at the sheet's foot.

## Notes and tasks

Press `/`, or use the pin tool. A composer opens beside the selection and pins to that frame or layer. Choose **Note** (context) or **Task** (work). Ctrl+Enter leaves it. A pin stays on the canvas with the author's avatar.

| Status | Rangoli knows |
|---|---|
| Waiting for agent | Nobody has picked it up |
| Picked up | A named agent took it, at this time |
| Run in progress | Run 31, last write 3s ago |
| Done, ready to review | The agent closed the run; nothing is approved |

The composer says plainly: "Rangoli can't make it start." Waiting shows no timer or estimate. Silence after pickup reads "last write 12m ago", never "working". Mark reviewed, Refuse further writes and Undo whole run stay with people.

**For agents** appears on the canvas and Home: connected agents first, then the queue. Comments remain for teammates.

## Connecting Claude or Cursor

Each person connects their own agent to Rangoli's MCP server with a personal, project-scoped token. New design shows a task waiting, "Not connected", and a dashed line from Rangoli to an unknown agent, moving while the endpoint listens. Two steps: copy the command or URL, then tell the agent "Check my Rangoli queue". Conversation stays in the agent.

States shown: Not connected; Connected, with whose token; Not connected, last seen; Token expired. With no agent, work waits and the user can draw a frame, use a template or import from Figma.

## Seal

Computed from the content hash: dots before confirm, ink on baseline, dashed awaiting signature, marigold once signed, on a marigold wash that appears only then. Same hash, same drawing; the hash is the proof.

## Release 1

Shell, tokens and icons; kolam seal; History timeline; composer with Note and Task, pins, four statuses; For agents queue; connect flow; whole-run undo; agent labelling; signed Approve and Release; import arrival; stakeholder link, view-only.

**R2 at the earliest:** expanded History; Request changes creating tasks; assigning to one named agent; peek outside Review; run spotlight; Evidence in Review.

**R3 or later:** workstream matrix; scrubbing.

## Checked and not

**Checked:** 82 token contrast pairs meet AA targets in both themes; 12px floor, 24px targets and overflow by script across all 28 renders; `/`, Ctrl+Enter, signing and connect tabs by script. Control-state tokens, hover and keyboard focus were reviewed in code, not by rendering every state.

**Not tested:** screen readers, 200% reflow, full keyboard paths, real users. Test the kolam, History and whether "Waiting for agent" reads as honest rather than broken.
