/**
 * The UI/UX lifecycle every hosted project moves through.
 *
 * Pure and shared: the server uses it as the authority for gates, the editor uses it to explain them.
 * Each stage's work feeds the next (research → personas → stories → screens → frames → flows →
 * prototype links → test tasks → findings → handoff → launch feedback → next cycle's research).
 */
import type { RangoliDocument } from './document.js';
import { lint } from './lint.js';
import type { Dim } from './model.js';

export type StageId = 'discovery' | 'define' | 'ia' | 'wireframes' | 'visual' | 'prototype' | 'testing' | 'handoff' | 'launch';
export type OrgRole = 'admin' | 'designer' | 'reviewer';

export interface StageDef {
  id: StageId;
  name: string;
  /** the question this stage answers */
  question: string;
  /** what done looks like, in plain words */
  output: string;
  /** a Full project asks a reviewer to approve this stage (work types choose their own, see WORK_TYPES) */
  signoff: boolean;
  /** design work is the main output here, so leaving it saves a named version. Never a lock: the canvas is always open */
  designOpen: boolean;
}

export const STAGES: readonly StageDef[] = [
  { id: 'discovery', name: 'Discovery', question: 'Who are the users, and what are they trying to do?', output: 'A brief and research evidence', signoff: false, designOpen: false },
  { id: 'define', name: 'Define', question: 'What exactly are we solving, and for whom?', output: 'Problem statement, personas, user stories', signoff: true, designOpen: false },
  { id: 'ia', name: 'IA & flows', question: 'What screens exist, and how do people move between them?', output: 'Screen inventory and user flows', signoff: true, designOpen: false },
  { id: 'wireframes', name: 'Wireframes', question: 'Is the structure right, before any styling?', output: 'A grayscale layout for every screen', signoff: true, designOpen: true },
  { id: 'visual', name: 'Visual design', question: 'Does it look and read right, consistently?', output: 'High-fidelity screens that pass lint', signoff: true, designOpen: true },
  { id: 'prototype', name: 'Prototype', question: 'Can someone click through every flow?', output: 'Every flow linked and playable', signoff: false, designOpen: true },
  { id: 'testing', name: 'Usability testing', question: 'Where do real people get stuck?', output: 'Sessions run, findings triaged', signoff: true, designOpen: false },
  { id: 'handoff', name: 'Handoff', question: 'Can developers build it without guessing?', output: 'Specs, assets and every component state', signoff: true, designOpen: false },
  { id: 'launch', name: 'Post-launch', question: 'Did it work, and what should change next?', output: 'Measured results and feedback for the next cycle', signoff: false, designOpen: false },
];

export const stageDef = (id: string): StageDef | undefined => STAGES.find((s) => s.id === id);
export const stageIndex = (id: string): number => STAGES.findIndex((s) => s.id === id);
export const nextStage = (id: string): StageId | null => STAGES[stageIndex(id) + 1]?.id ?? null;
/**
 * Every stage view is always open, and so is the canvas. Kept so older callers compile until they drop it.
 * @deprecated always true; use stageDef(id)?.designOpen to ask whether a stage is mainly design work.
 */
export const designOpenAt = (_id: string): boolean => true;

export type ItemKind = 'brief' | 'research' | 'problem' | 'persona' | 'story' | 'screen' | 'flow' | 'test_task' | 'test_session' | 'finding' | 'metric' | 'feedback';

/** Items of these kinds belong to one cycle; everything else carries forward as living documentation. */
export const CYCLE_SCOPED: readonly ItemKind[] = ['research', 'test_session', 'metric', 'feedback'];
/** The stage view each kind of work is shown in. Only where it lives: any item can be added at any time. */
export const ITEM_STAGE: Record<ItemKind, StageId> = {
  brief: 'discovery', research: 'discovery', problem: 'define', persona: 'define', story: 'define', screen: 'ia', flow: 'ia',
  test_task: 'testing', test_session: 'testing', finding: 'testing', metric: 'launch', feedback: 'launch',
};
/** Reviewers record observations; everything else is designer work. Mirrored by the RLS policy on items. */
export const REVIEWER_KINDS: readonly ItemKind[] = ['finding', 'feedback'];

export const COMPONENT_STATES = ['default', 'hover', 'focus', 'disabled', 'loading', 'empty', 'error'] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];
export const REQUIRED_STATES: readonly ComponentState[] = ['hover', 'loading', 'empty', 'error'];

/** Fewer than this rarely shows a pattern; three sessions is the floor, not the ideal. */
export const MIN_TEST_SESSIONS = 3;
/** Frames from "Create wireframes" start with a title and a purpose line, which do not count as layout. */
export const WIREFRAME_SEED_NODES = 2;

export interface LifecycleItem {
  id: string;
  kind: ItemKind;
  cycle: number;
  title: string;
  body: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: Record<string, any>;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at?: string;
}

export interface StageEvent {
  id: string;
  cycle: number;
  kind: 'created' | 'advance' | 'send_back' | 'override' | 'new_cycle' | 'review_requested' | 'review_withdrawn';
  from_stage: StageId | null;
  to_stage: StageId;
  actor: string | null;
  note: string;
  created_at: string;
}

export interface Signoff {
  id: string;
  cycle: number;
  stage: StageId;
  decision: 'approved' | 'changes_requested';
  note: string;
  reviewer: string;
  created_at: string;
}

export interface DesignFacts {
  /** top-level frames on the canvas */
  frames: { id: string; name: string; nodes: number; w: number; h: number }[];
  /** lint issues that block shipping */
  blocking: { code: string; severity: string; node: string; message: string }[];
  /** [from frame, to frame] for each navigate interaction */
  links: [string, string][];
  start: string | null;
}

export interface Check {
  id: string;
  label: string;
  ok: boolean;
  /** what is missing, when not ok */
  detail?: string;
}

/** One device frame of a screen: a screen can have several (Desktop, Tablet, iPad, Mobile, custom sizes). */
export interface ScreenFrameLink {
  id?: string;
  /** the screen item */
  screen: string;
  /** the top-level frame node on the canvas */
  frame: string;
  device: ScreenDevice;
  w: number;
  h: number;
  primary: boolean;
  /** the frame this one was duplicated from, when made with "duplicate to device" */
  linkedFrom?: string | null;
}

export type ScreenDevice = 'desktop' | 'tablet' | 'ipad' | 'mobile' | 'custom';

/**
 * Every frame linked to a screen, primary first. A screen's `data.frame` is its primary frame; links not yet
 * recorded as rows (for example a frame an agent just drew) still count, so nothing is lost while both exist.
 */
export function framesOfScreen(screen: LifecycleItem, links: readonly ScreenFrameLink[] = []): string[] {
  const own = links.filter((l) => l.screen === screen.id).sort((a, b) => Number(b.primary) - Number(a.primary)).map((l) => l.frame);
  const primary = typeof screen.data.frame === 'string' && screen.data.frame ? (screen.data.frame as string) : null;
  return [...new Set(primary ? [primary, ...own] : own)];
}

export interface GateInput {
  cycle: number;
  items: LifecycleItem[];
  design: DesignFacts;
  /** device frames per screen; without it each screen's single `data.frame` is used */
  frames?: readonly ScreenFrameLink[];
}

export function designFacts(doc: RangoliDocument): DesignFacts {
  const page = doc.page();
  const rootOf = (id: string): string | null => {
    let n = page.nodes[id];
    while (n?.parent) n = page.nodes[n.parent];
    return n?.id ?? null;
  };
  const count = (id: string): number => (page.nodes[id]?.children ?? []).reduce((sum, c) => sum + 1 + count(c), 0);
  const px = (d: Dim | undefined, fallback: number) => (d?.kind === 'fixed' && typeof d.v === 'number' ? d.v : fallback);
  const links: [string, string][] = [];
  for (const [node, list] of Object.entries(doc.data.prototype?.interactions ?? {})) {
    const from = rootOf(node);
    if (!from) continue;
    for (const i of list) {
      if (i.action !== 'navigate' || !i.target) continue;
      const to = rootOf(i.target);
      if (to) links.push([from, to]);
    }
  }
  return {
    frames: page.children.map((id) => ({ id, name: page.nodes[id]?.name ?? id, nodes: count(id), w: px(page.nodes[id]?.size?.w, 1440), h: px(page.nodes[id]?.size?.h, 900) })),
    blocking: lint(doc)
      .filter((i) => i.severity === 'P0' || i.severity === 'P1')
      .map(({ code, severity, node, message }) => ({ code, severity, node, message })),
    links,
    start: doc.data.prototype?.start ?? null,
  };
}

const names = (list: LifecycleItem[], max = 3): string => {
  const shown = list.slice(0, max).map((i) => `"${i.title}"`).join(', ');
  return list.length > max ? `${shown} and ${list.length - max} more` : shown;
};
const check = (id: string, label: string, missing: LifecycleItem[] | boolean, detail?: string): Check => {
  const ok = Array.isArray(missing) ? missing.length === 0 : missing;
  return { id, label, ok, ...(ok ? {} : { detail: detail ?? (Array.isArray(missing) ? names(missing) : undefined) }) };
};

/** The evidence a stage needs before it can be left. Always computed from real data, never ticked by hand. */
export function evaluateStage(stage: StageId, input: GateInput): Check[] {
  const { cycle, items, design } = input;
  const of = (k: ItemKind) => items.filter((i) => i.kind === k && (!CYCLE_SCOPED.includes(k) || i.cycle === cycle));
  const screens = of('screen');
  const flows = of('flow');
  const stories = of('story');
  const personas = of('persona');
  /** the screen's frames that are on the canvas */
  const framesOf = (s: LifecycleItem) => framesOfScreen(s, input.frames).map((id) => design.frames.find((f) => f.id === id)).filter((f): f is DesignFacts['frames'][number] => !!f);
  const linkedOf = (s: LifecycleItem) => framesOfScreen(s, input.frames);

  switch (stage) {
    case 'discovery': {
      const brief = of('brief')[0];
      const research = of('research');
      return [
        check('brief', 'Brief covers users, problem, goals and constraints', !!brief && !!brief.body.trim() && ['users', 'goals', 'constraints'].every((f) => String(brief.data[f] ?? '').trim()), brief ? 'Some brief fields are still empty' : 'No brief yet'),
        check('research', `At least one research note from this cycle (cycle ${cycle})`, research.length > 0, 'Add a note from an interview, competitor, analytics or stakeholder talk'),
        check('insight', 'Every note says what you learned', research.filter((r) => !String(r.data.insight ?? '').trim())),
      ];
    }
    case 'define': {
      const problem = of('problem')[0];
      return [
        check('problem', 'Problem statement written', !!problem?.body.trim(), 'State who needs what, and why it matters'),
        check('persona', 'At least one persona', personas.length > 0, 'No personas yet'),
        check('persona-evidence', 'Personas cite research', personas.filter((p) => !(p.data.evidence?.length > 0))),
        check('story', 'At least one user story', stories.length > 0, 'No user stories yet'),
        check('story-persona', 'Every story belongs to a persona', stories.filter((s) => !personas.some((p) => p.id === s.data.persona))),
      ];
    }
    case 'ia': {
      const covered = new Set(screens.flatMap((s) => (s.data.stories as string[] | undefined) ?? []));
      const inFlow = new Set(flows.flatMap((f) => (f.data.steps as string[] | undefined) ?? []));
      return [
        check('screen', 'Screens listed', screens.length > 0, 'No screens yet'),
        check('flow', 'At least one flow with two or more steps', flows.some((f) => (f.data.steps?.length ?? 0) >= 2), 'No complete flow yet'),
        check('story-screen', 'Every user story is served by a screen', stories.filter((s) => !covered.has(s.id))),
        check('screen-flow', 'Every screen appears in a flow', screens.filter((s) => !inFlow.has(s.id))),
      ];
    }
    case 'wireframes':
      return [
        check('frame', 'Every screen has a frame on the canvas', screens.filter((s) => framesOf(s).length === 0)),
        check('layout', 'Every frame has layout beyond its title', screens.filter((s) => framesOf(s).some((f) => f.nodes <= WIREFRAME_SEED_NODES))),
        check('devices', 'Every device frame of a screen is still on the canvas', screens.filter((s) => framesOf(s).length > 0 && framesOf(s).length < linkedOf(s).length)),
      ];
    case 'visual':
      return [
        check('frame', 'Every screen still has its frame', screens.filter((s) => framesOf(s).length === 0)),
        check('lint', 'No P0 or P1 lint issues', design.blocking.length === 0, `${design.blocking.length} blocking issue${design.blocking.length === 1 ? '' : 's'}, e.g. ${design.blocking[0]?.message ?? ''}`),
      ];
    case 'prototype': {
      // a step is clickable when any frame of the previous screen links to any frame of the next, whatever the device
      const broken = flows.filter((f) => {
        const steps = ((f.data.steps as string[] | undefined) ?? []).map((id) => screens.find((s) => s.id === id)).map((s) => (s ? linkedOf(s) : []));
        return steps.some((to, i) => i > 0 && !design.links.some(([a, b]) => steps[i - 1]!.includes(a) && to.includes(b)));
      });
      return [
        check('start', 'A start screen is set', !!design.start, 'Set the frame the prototype opens on'),
        check('flows', 'Every flow can be clicked end to end', broken, broken.length ? `Missing links in ${names(broken)}` : undefined),
      ];
    }
    case 'testing': {
      const tasks = of('test_task');
      const sessions = of('test_session');
      const openSevere = items.filter((i) => i.kind === 'finding' && i.status === 'open' && ['P0', 'P1'].includes(String(i.data.severity)));
      const untriaged = items.filter((i) => i.kind === 'finding' && i.status === 'open');
      const incomplete = sessions.filter((s) => tasks.some((t) => !(s.data.results as { task: string }[] | undefined)?.some((r) => r.task === t.id)));
      return [
        check('task', 'Test tasks written from user stories', tasks.length > 0 && tasks.every((t) => stories.some((s) => s.id === t.data.story)), tasks.length ? 'Some tasks are not linked to a story' : 'No tasks yet'),
        check('sessions', `At least ${MIN_TEST_SESSIONS} sessions this cycle`, sessions.length >= MIN_TEST_SESSIONS, `${sessions.length} of ${MIN_TEST_SESSIONS} recorded`),
        check('results', 'Every session has a result for every task', incomplete),
        check('severe', 'No P0 or P1 findings left open', openSevere),
        check('triage', 'Every finding is triaged', untriaged),
      ];
    }
    case 'handoff': {
      const incomplete = screens.filter((s) => REQUIRED_STATES.some((st) => !['done', 'na'].includes(s.data.states?.[st])));
      return [
        check('states', `Every screen covers ${REQUIRED_STATES.join(', ')}`, incomplete),
        check('specs', 'Every screen has developer notes', screens.filter((s) => !String(s.data.spec ?? '').trim())),
        check('lint', 'No P0 or P1 lint issues', design.blocking.length === 0, `${design.blocking.length} blocking`),
      ];
    }
    case 'launch': {
      const metrics = of('metric');
      return [
        check('metric', 'At least one metric measured against its target', metrics.some((m) => String(m.data.actual ?? '').trim()), 'Record what actually happened'),
        check('feedback', 'Feedback collected this cycle', of('feedback').length > 0, 'No feedback yet'),
      ];
    }
  }
}

export type ReviewStatus = 'working' | 'in_review' | 'changes_requested' | 'approved';

export interface SignoffState {
  required: boolean;
  status: ReviewStatus;
  /** who asked for the open review */
  requestedBy: string | null;
  approved: boolean;
  blocked: boolean;
  /** the latest decision of each reviewer in this round */
  decisions: Signoff[];
  /** distinct approvals the stage needs */
  needed: number;
  /** when this round began (the stage was entered, or a review asked for or withdrawn) */
  roundStart: string | null;
}

/**
 * working → in_review → changes_requested → (fix) → in_review → approved → move on.
 * A round starts whenever the stage is entered, a review is requested or one is withdrawn,
 * so a decision always refers to the work as it stands.
 */
export function signoffState(stage: StageId, cycle: number, signoffs: Signoff[], events: StageEvent[], policy: { required?: boolean; approvals?: number } = {}): SignoffState {
  const required = policy.required ?? stageDef(stage)?.signoff ?? false;
  const needed = Math.max(1, policy.approvals ?? 1);
  const time = (s: string) => new Date(s).getTime();
  const latestEvent = events.filter((e) => e.to_stage === stage && e.cycle === cycle).reduce<StageEvent | null>((best, e) => (!best || time(e.created_at) >= time(best.created_at) ? e : best), null);
  const since = latestEvent ? time(latestEvent.created_at) : 0;
  const latest = new Map<string, Signoff>();
  for (const s of [...signoffs].sort((x, y) => time(x.created_at) - time(y.created_at))) {
    if (s.stage === stage && s.cycle === cycle && time(s.created_at) >= since) latest.set(s.reviewer, s);
  }
  const decisions = [...latest.values()];
  const blocked = decisions.some((d) => d.decision === 'changes_requested');
  const approved = !blocked && decisions.filter((d) => d.decision === 'approved').length >= needed;
  const open = latestEvent?.kind === 'review_requested';
  const status: ReviewStatus = !open ? 'working' : blocked ? 'changes_requested' : approved ? 'approved' : 'in_review';
  return { required, status, requestedBy: open ? latestEvent.actor : null, approved: status === 'approved', blocked, decisions, needed, roundStart: latestEvent?.created_at ?? null };
}

// ---------------------------------------------------------------- work types

export type WorkType = 'full' | 'feature' | 'fix' | 'regulated';

export interface WorkTypeDef {
  id: WorkType;
  name: string;
  description: string;
  /** stages whose checks apply; the others are shown but stay quiet */
  stages: readonly StageId[];
  /** stages that ask for a reviewer's approval */
  signoffs: readonly StageId[];
  /** distinct approvals each of those needs */
  approvals: number;
  /** strict mode is always on, whatever the organization setting */
  strict: boolean;
}

const ALL_STAGES = STAGES.map((s) => s.id);

/** Sets default checks and approvals only. Every stage view stays open whatever the type. */
export const WORK_TYPES: Record<WorkType, WorkTypeDef> = {
  full: { id: 'full', name: 'Full', description: 'Research to launch: every stage is checked and each review stage is approved.', stages: ALL_STAGES, signoffs: STAGES.filter((s) => s.signoff).map((s) => s.id), approvals: 1, strict: false },
  feature: { id: 'feature', name: 'Feature', description: 'Design a feature from agreed screens: structure, visual, prototype and handoff are checked. Visual and Handoff are approved.', stages: ['ia', 'wireframes', 'visual', 'prototype', 'handoff'], signoffs: ['visual', 'handoff'], approvals: 1, strict: false },
  fix: { id: 'fix', name: 'Fix', description: 'Change released screens with a note and before and after. One approval at Handoff.', stages: ['visual', 'handoff'], signoffs: ['handoff'], approvals: 1, strict: false },
  regulated: { id: 'regulated', name: 'Regulated', description: 'Every stage checked, two approvals on each review stage, and strict mode always on.', stages: ALL_STAGES, signoffs: STAGES.filter((s) => s.signoff).map((s) => s.id), approvals: 2, strict: true },
};
export const WORK_TYPE_IDS = Object.keys(WORK_TYPES) as WorkType[];
/** New work starts as a Feature; Full is one click away. */
export const DEFAULT_WORK_TYPE: WorkType = 'feature';
export const workTypeDef = (id: string | null | undefined): WorkTypeDef => WORK_TYPES[(id && id in WORK_TYPES ? id : DEFAULT_WORK_TYPE) as WorkType];

/** What a work type asks of one stage. */
export function stagePolicy(type: WorkTypeDef, stage: StageId): { inType: boolean; required: boolean; approvals: number } {
  return { inType: type.stages.includes(stage), required: type.signoffs.includes(stage), approvals: type.approvals };
}

/** Strict mode applies when the organization turns it on, or the work type demands it. */
export const isStrict = (orgStrict: boolean, type: WorkTypeDef): boolean => orgStrict || type.strict;

/** The gaps a stage has, as warnings: they never block entry or editing. */
export function stageWarnings(stage: { id: StageId; name: string; checks: Check[]; inType: boolean }): { stage: StageId; check: string; message: string }[] {
  if (!stage.inType) return [];
  return stage.checks.filter((c) => !c.ok).map((c) => ({ stage: stage.id, check: c.id, message: `${stage.name}: ${c.label}${c.detail ? ` (${c.detail})` : ''}` }));
}

/** The actions strict mode can block. Approval of a stage, and releasing (leaving Handoff). */
export type StrictAction = 'approve' | 'release';

/**
 * The permissions page: one row per capability, in plain words. Which roles hold each one comes from
 * capabilities.ts (`hasCapability`), the same table the database enforces, so this page cannot drift from it.
 * Organization rows are about the organization; project rows are about one project and its project role.
 */
export const PERMISSIONS: { action: string; level: 'organization' | 'project'; capability: import('./capabilities.js').Capability; note?: string }[] = [
  { level: 'organization', capability: 'org.members.manage', action: 'Manage members, guests, invites and project roles' },
  { level: 'organization', capability: 'org.settings.manage', action: 'Rename the organization and change its settings' },
  { level: 'organization', capability: 'org.projects.create', action: 'Create projects (and lead them)' },
  { level: 'organization', capability: 'org.projects.delete', action: 'Delete projects' },
  { level: 'organization', capability: 'org.directory.read', action: 'See everyone in the organization' },
  { level: 'organization', capability: 'org.audit.read', action: 'Read the activity log' },
  { level: 'organization', capability: 'org.transfer', action: 'Hand the organization to someone else' },
  { level: 'organization', capability: 'org.delete', action: 'Delete the organization' },
  { level: 'project', capability: 'design.view', action: 'View the design and snapshots' },
  { level: 'project', capability: 'comment', action: 'Comment and suggest changes' },
  { level: 'project', capability: 'design.edit', action: 'Edit the design, the plan, and move the project between stages' },
  { level: 'project', capability: 'suggestion.accept', action: 'Accept or reject suggestions' },
  { level: 'project', capability: 'evidence.add', action: 'Add sources and evidence: research, sessions, findings, feedback' },
  { level: 'project', capability: 'decision.record', action: 'Record decisions' },
  { level: 'project', capability: 'decision.propose', action: 'Propose decisions' },
  { level: 'project', capability: 'transcript.read', action: 'See raw transcripts and participant details' },
  { level: 'project', capability: 'task.create', action: 'Create and assign tasks' },
  { level: 'project', capability: 'export.run', action: 'Export, hand off and map code' },
  { level: 'project', capability: 'export.view', action: 'View exports and handoff' },
  { level: 'project', capability: 'release', action: 'Release' },
  { level: 'project', capability: 'approve', action: 'Approve a stage or request changes', note: 'Only people named as approvers, never on their own request' },
  { level: 'project', capability: 'members.manage', action: 'Manage who works on the project' },
  { level: 'project', capability: 'override.strict', action: 'Override strict mode or skip a gate, with a reason' },
];
