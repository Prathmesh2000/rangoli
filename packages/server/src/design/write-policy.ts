/**
 * The PRD §11 write rules, applied to a concrete change before it lands.
 *
 * An agent's reach is the lowest of the authorizing person's role, the token's scope and the write rule for
 * what the change touches (packages/engine/src/capabilities.ts `agentAccess`). This module works out what a
 * change touches, from the targets the engine reports, and asks the engine for each one:
 *
 *  - the authorizing person's own unreviewed frames: direct, in a named run
 *  - a solo organization's frames: direct, on the working copy
 *  - team imports: per page, Protected (suggest only) or Draft (the importer's agent edits)
 *  - approved or in-review team work, other people's frames, tokens, components: suggest only
 *  - claims about people: held until a person accepts them
 */
import { agentAccess, type AgentAccess, type AgentAccessLevel, type AgentWork, type RangoliDocument, type Subject, type TokenScope } from '@rangoli/engine';

export type ReviewState = 'none' | 'in_review' | 'approved';

/** What the server knows about the project when an agent writes. Hosted projects read it from the database. */
export interface WriteFacts {
  /** the person whose token the agent uses */
  authorizer: string;
  /** their capabilities as a Subject (role, approver, solo) */
  person: Subject;
  scopes: readonly TokenScope[];
  /** a one-person organization */
  solo: boolean;
  /** the project's current review: anything in review or approved is suggest-only */
  review: ReviewState;
  /** who made each top-level frame; absent when unknown */
  frameOwner(frameId: string): string | undefined;
  /** a page that came from a team import, with its agent mode and who imported it */
  pageImport(pageId: string): { mode: 'protected' | 'draft'; importedBy: string | null } | undefined;
}

export interface TargetDecision {
  /** a frame id, '$tokens', '@Component', '$prototype' … */
  target: string;
  work: AgentWork['kind'];
  access: AgentAccess;
  /** in words, for the agent */
  reason: string;
}

export interface WriteDecision {
  /** apply directly, save as a suggestion, or refuse */
  mode: 'apply' | 'suggest' | 'refuse';
  level: AgentAccessLevel;
  targets: TargetDecision[];
  /** the targets that set the mode, explained */
  message: string;
}

const LEVELS: AgentAccessLevel[] = ['none', 'view', 'suggest', 'edit'];

/** The top-level frame a node lives under, in this document. */
export function rootFrameOf(doc: RangoliDocument, id: string): { root: string; page: string } | undefined {
  const found = doc.findNode(id);
  if (!found) return undefined;
  let n = found.node;
  while (n.parent && found.page.nodes[n.parent]) n = found.page.nodes[n.parent]!;
  return { root: n.id, page: found.page.id };
}

interface Target {
  key: string;
  kind: 'frame' | 'tokens' | 'components' | 'project' | 'asset';
  page?: string;
  /** created by this very change, so it will be the authorizer's */
  isNew?: boolean;
}

/**
 * Turn the engine's touched list (node ids and "$…" keys) into what the write rules talk about.
 * `before` is the document as it is now; `after` is a preview with the change applied.
 */
export function writeTargets(before: RangoliDocument, after: RangoliDocument, touched: readonly string[]): Target[] {
  const out = new Map<string, Target>();
  const frame = (id: string) => {
    const now = rootFrameOf(before, id);
    const then = rootFrameOf(after, id);
    const at = now ?? then;
    if (!at) return;
    // a frame that does not exist yet is a new frame, and new frames are the authorizer's own
    const isNew = !before.findNode(at.root);
    if (!out.has(at.root)) out.set(at.root, { key: at.root, kind: 'frame', page: at.page, isNew });
  };
  for (const t of touched) {
    if (!t.startsWith('$')) frame(t);
    else if (t === '$tokens') out.set('$tokens', { key: '$tokens', kind: 'tokens' });
    else if (t.startsWith('$component:')) out.set(t, { key: t, kind: 'components' });
    else if (t.startsWith('$icon')) out.set(t, { key: t, kind: 'components' });
    else if (t.startsWith('$motion:#')) frame(t.slice(9).replace(/\[.*$/, ''));
    else if (t.startsWith('$motion:')) out.set(t, { key: t, kind: 'components' });
    else if (t.startsWith('$proto:') && t !== '$proto:start' && t !== '$proto:vars') frame(t.slice(7));
    else if (t.startsWith('$asset:')) out.set(t, { key: t, kind: 'asset' });
    else out.set(t, { key: t, kind: 'project' });
  }
  return [...out.values()];
}

function workFor(target: Target, facts: WriteFacts): { work: AgentWork; reason: string } {
  switch (target.kind) {
    case 'tokens':
      return { work: { kind: 'tokens' }, reason: 'design tokens change every screen, so agents suggest them' };
    case 'components':
      return { work: { kind: 'components' }, reason: 'components are shared, so agents suggest changes to them' };
    case 'asset':
      // adding an image is additive and is judged by the frame that uses it
      return facts.solo ? { work: { kind: 'solo_frame' }, reason: 'image in a solo organization' } : { work: { kind: 'own_unreviewed_frame' }, reason: 'a new image' };
    case 'project':
      return facts.solo ? { work: { kind: 'solo_frame' }, reason: 'project setting in a solo organization' } : { work: { kind: 'others_frame' }, reason: 'project-wide prototype settings are shared, so agents suggest them' };
    case 'frame':
      break;
  }
  if (facts.solo) return { work: { kind: 'solo_frame' }, reason: 'a frame in a one-person organization, edited on the working copy' };
  if (facts.review !== 'none' && !target.isNew) return { work: { kind: 'approved_or_in_review' }, reason: `the project's work is ${facts.review === 'approved' ? 'approved' : 'in review'}` };
  const imported = target.page ? facts.pageImport(target.page) : undefined;
  if (imported && !target.isNew) {
    return {
      work: { kind: 'team_import', page: imported.mode, authorizerOwnsImport: imported.importedBy === facts.authorizer },
      reason: imported.mode === 'protected' ? 'this page is a protected import' : imported.importedBy === facts.authorizer ? 'a draft import by the person who authorized this agent' : 'a draft import by someone else',
    };
  }
  if (target.isNew) return { work: { kind: 'own_unreviewed_frame' }, reason: 'a new frame, owned by the person who authorized this agent' };
  const owner = facts.frameOwner(target.key);
  if (owner === facts.authorizer) return { work: { kind: 'own_unreviewed_frame' }, reason: "the authorizing person's own unreviewed frame" };
  return { work: { kind: 'others_frame' }, reason: owner ? "another person's frame" : 'a frame nobody has claimed, treated as another person’s' };
}

/** The rule for a change that touches these targets: the lowest level any of them allows. */
export function decideWrite(targets: readonly Target[], facts: WriteFacts): WriteDecision {
  const decisions: TargetDecision[] = targets.map((target) => {
    const { work, reason } = workFor(target, facts);
    return { target: target.key, work: work.kind, access: agentAccess({ person: facts.person, scopes: facts.scopes, work }), reason };
  });
  if (!decisions.length) return { mode: 'apply', level: 'edit', targets: [], message: 'Nothing in the design changes.' };
  const lowest = decisions.reduce((lo, d) => (LEVELS.indexOf(d.access.level) < LEVELS.indexOf(lo) ? d.access.level : lo), 'edit' as AgentAccessLevel);
  const setters = decisions.filter((d) => d.access.level === lowest);
  const why = setters.map((d) => `${d.target.startsWith('$') ? d.target.slice(1) : `#${d.target}`}: ${d.reason}${d.access.limitedBy.includes('write_rule') ? '' : ` (limited by the ${d.access.limitedBy.join(' and ')})`}`).join('; ');
  if (lowest === 'edit') return { mode: 'apply', level: lowest, targets: decisions, message: `Direct edit allowed (${why}).` };
  if (lowest === 'suggest') return { mode: 'suggest', level: lowest, targets: decisions, message: `Saved as a suggestion instead of applied: ${why}.` };
  return { mode: 'refuse', level: lowest, targets: decisions, message: `Refused: ${why}.` };
}

/** Lifecycle item kinds that state something about people. An agent's write of one is held until accepted. */
export const PEOPLE_CLAIM_KINDS = ['persona', 'research', 'finding', 'feedback', 'test_session'] as const;
export const isClaimAboutPeople = (kind: string): boolean => (PEOPLE_CLAIM_KINDS as readonly string[]).includes(kind);
