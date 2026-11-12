/**
 * Roles and named capabilities (PRD §9, §10) and agent access (PRD §11).
 *
 * Roles are presets over capabilities. The database enforces them through `has_capability`; this
 * module is the same table for the app and for tests. Organization and project roles are separate:
 * an organization owner or admin gains nothing inside a project from that role alone.
 */

export const ORG_ROLES = ['owner', 'admin', 'member', 'billing_admin', 'library_maintainer', 'auditor', 'guest'] as const;
export type OrganizationRole = (typeof ORG_ROLES)[number];

export const PROJECT_ROLES = ['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer', 'viewer', 'writer', 'guest'] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const PROJECT_CAPABILITIES = [
  'design.view',
  'comment',
  'design.edit',
  'suggestion.accept',
  'evidence.add',
  'decision.record',
  'decision.propose',
  'transcript.read',
  'task.create',
  'export.run',
  'export.view',
  'release',
  'approve',
  'members.manage',
  'override.strict',
] as const;
export type ProjectCapability = (typeof PROJECT_CAPABILITIES)[number];

export const ORG_CAPABILITIES = [
  'org.members.manage',
  'org.billing.manage',
  'org.settings.manage',
  'org.library.maintain',
  'org.audit.read',
  'org.directory.read',
  'org.projects.create',
  'org.projects.delete',
  'org.delete',
  'org.transfer',
] as const;
export type OrgCapability = (typeof ORG_CAPABILITIES)[number];

export type Capability = ProjectCapability | OrgCapability;

const EVERY_PARTICIPANT: readonly ProjectRole[] = ['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer'];

/**
 * PRD §9, one row per capability. "Propose" and "View" cells are their own capabilities.
 * Writer and guest have no column in the PRD, so they hold nothing until one is written.
 */
const PROJECT_MATRIX: Record<ProjectCapability, readonly ProjectRole[]> = {
  'design.view': [...EVERY_PARTICIPANT, 'viewer'],
  comment: EVERY_PARTICIPANT,
  'design.edit': ['lead', 'designer'],
  'suggestion.accept': ['lead', 'designer'],
  'evidence.add': ['lead', 'designer', 'researcher', 'product_manager', 'reviewer'],
  'decision.record': ['lead', 'designer', 'product_manager'],
  'decision.propose': EVERY_PARTICIPANT,
  'transcript.read': ['lead', 'researcher'],
  'task.create': ['lead', 'designer', 'researcher', 'product_manager', 'developer'],
  'export.run': ['lead', 'designer', 'developer'],
  'export.view': ['lead', 'designer', 'product_manager', 'developer'],
  release: ['lead', 'designer'],
  approve: EVERY_PARTICIPANT,
  'members.manage': ['lead'],
  'override.strict': ['lead'],
};

/** Everyone who belongs to the organization itself. A guest belongs to one project, not the organization. */
const ORG_PEOPLE: readonly OrganizationRole[] = ['owner', 'admin', 'member', 'billing_admin', 'library_maintainer', 'auditor'];

/**
 * The PRD names these roles but gives no organization matrix; this is the narrowest reading.
 * Members create projects (they become its Lead) and see who else is in the organization; nothing more.
 * Deleting the organization and handing it to someone else are the Owner's alone.
 */
const ORG_MATRIX: Record<OrgCapability, readonly OrganizationRole[]> = {
  'org.members.manage': ['owner', 'admin'],
  'org.billing.manage': ['owner', 'billing_admin'],
  'org.settings.manage': ['owner', 'admin'],
  'org.library.maintain': ['owner', 'admin', 'library_maintainer'],
  'org.audit.read': ['owner', 'auditor'],
  'org.directory.read': ORG_PEOPLE,
  'org.projects.create': ['owner', 'admin', 'member'],
  'org.projects.delete': ['owner', 'admin'],
  'org.delete': ['owner'],
  'org.transfer': ['owner'],
};

/** Roles the database accepts today (R1 and R2). The rest are named for later releases and hold their matrix rows already. */
export const ASSIGNABLE_ORG_ROLES = ['owner', 'admin', 'member', 'guest'] as const satisfies readonly OrganizationRole[];
export const ASSIGNABLE_PROJECT_ROLES = ['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer', 'viewer'] as const satisfies readonly ProjectRole[];

/**
 * Lifecycle items that count as sources and evidence (`evidence.add`). Every other kind is part of the
 * design plan and needs `design.edit`. Holders of `evidence.add` alone change only what they added.
 */
export const EVIDENCE_ITEM_KINDS = ['research', 'test_session', 'finding', 'feedback', 'metric'] as const;

/** The capability that writing a lifecycle item of this kind needs. */
export const itemCapability = (kind: string): ProjectCapability => ((EVIDENCE_ITEM_KINDS as readonly string[]).includes(kind) ? 'evidence.add' : 'design.edit');

/** The role table as rows, the shape the database's `role_capabilities` holds. */
export function roleCapabilityRows(): { level: 'org' | 'project'; role: string; capability: Capability }[] {
  return [
    ...ORG_CAPABILITIES.flatMap((capability) => ORG_MATRIX[capability].map((role) => ({ level: 'org' as const, role, capability }))),
    ...PROJECT_CAPABILITIES.flatMap((capability) => PROJECT_MATRIX[capability].map((role) => ({ level: 'project' as const, role, capability }))),
  ];
}

export interface Subject {
  orgRole?: OrganizationRole;
  projectRole?: ProjectRole;
  /** the Approver designation (`project_members.is_approver`) */
  isApprover?: boolean;
  /** solo organizations have no approval: Release replaces it */
  solo?: boolean;
}

function isOrgCapability(capability: Capability): capability is OrgCapability {
  return capability.startsWith('org.');
}

export function hasCapability(subject: Subject, capability: Capability): boolean {
  if (isOrgCapability(capability)) {
    return subject.orgRole !== undefined && ORG_MATRIX[capability].includes(subject.orgRole);
  }
  if (subject.projectRole === undefined || !PROJECT_MATRIX[capability].includes(subject.projectRole)) return false;
  if (capability === 'approve') return subject.isApprover === true && subject.solo !== true;
  return true;
}

export function capabilitiesOf(subject: Subject): Capability[] {
  return [...PROJECT_CAPABILITIES, ...ORG_CAPABILITIES].filter((capability) => hasCapability(subject, capability));
}

export interface ApprovalAttempt {
  subject: Subject;
  actorId: string;
  requesterId: string;
  /** set when the request came through an agent token */
  tokenId?: string | null;
}

/** PRD §10, for every role, admins included: no self-approval, and no approving through a token. */
export function canDecideApproval(attempt: ApprovalAttempt): boolean {
  return attempt.tokenId == null && attempt.actorId !== attempt.requesterId && hasCapability(attempt.subject, 'approve');
}

// ---------------------------------------------------------------- agents

export const TOKEN_SCOPES = ['read', 'propose', 'draft', 'items', 'export', 'jobs'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/**
 * Capabilities no agent can hold, whatever its person's role or token scope. The first five are
 * the PRD §11 list. The rest are person-only in ARCHITECTURE §6 and §12: accepting suggestions,
 * strict overrides, releases, recording decisions, and creating the tasks that count as requests.
 */
export const AGENT_NEVER: readonly Capability[] = [
  'approve',
  'members.manage',
  'org.members.manage',
  'org.billing.manage',
  'transcript.read',
  'suggestion.accept',
  'override.strict',
  'release',
  'decision.record',
  'task.create',
];

/** What each token scope can reach, before the person's role and the write rules narrow it. `jobs` governs the queue tools and maps to no §9 capability. */
export const SCOPE_GRANTS: Readonly<Record<TokenScope, readonly ProjectCapability[]>> = {
  read: ['design.view'],
  propose: ['design.view', 'comment', 'decision.propose'],
  draft: ['design.view', 'comment', 'decision.propose', 'design.edit'],
  items: ['evidence.add', 'decision.propose'],
  export: ['export.run', 'export.view'],
  jobs: [],
};

export const AGENT_ACCESS_LEVELS = ['none', 'view', 'suggest', 'edit'] as const;
export type AgentAccessLevel = (typeof AGENT_ACCESS_LEVELS)[number];

/** What the agent is trying to work on, from the PRD §11 write-rule table. */
export type AgentWork =
  | { kind: 'own_unreviewed_frame' }
  | { kind: 'solo_frame' }
  | { kind: 'team_import'; page: 'protected' | 'draft'; authorizerOwnsImport: boolean }
  | { kind: 'approved_or_in_review' }
  | { kind: 'others_frame' }
  | { kind: 'tokens' }
  | { kind: 'components' }
  | { kind: 'claim_about_people' };

export type AgentAccessLimit = 'role' | 'scope' | 'write_rule';

export interface AgentAccess {
  level: AgentAccessLevel;
  /** whichever of the three inputs set the level (more than one on a tie) */
  limitedBy: AgentAccessLimit[];
  /** the work must happen inside a named run */
  namedRun: boolean;
  /** edits land on the working copy only */
  workingCopyOnly: boolean;
  /** the result is held until a person accepts it */
  heldUntilAccepted: boolean;
}

export interface AgentAccessInput {
  person: Subject;
  scopes: readonly TokenScope[];
  work: AgentWork;
}

const rank = (level: AgentAccessLevel) => AGENT_ACCESS_LEVELS.indexOf(level);

function roleLevel(person: Subject): AgentAccessLevel {
  if (hasCapability(person, 'design.edit')) return 'edit';
  if (hasCapability(person, 'comment')) return 'suggest';
  if (hasCapability(person, 'design.view')) return 'view';
  return 'none';
}

function scopeLevel(scopes: readonly TokenScope[]): AgentAccessLevel {
  if (scopes.includes('draft')) return 'edit';
  if (scopes.includes('propose')) return 'suggest';
  if (scopes.includes('read')) return 'view';
  return 'none';
}

function writeRuleLevel(work: AgentWork): AgentAccessLevel {
  switch (work.kind) {
    case 'own_unreviewed_frame':
    case 'solo_frame':
      return 'edit';
    case 'team_import':
      return work.page === 'draft' && work.authorizerOwnsImport ? 'edit' : 'suggest';
    case 'approved_or_in_review':
    case 'others_frame':
    case 'tokens':
    case 'components':
    case 'claim_about_people':
      return 'suggest';
  }
}

/** PRD §11: the lowest of the authorizing person's role, the token's scope and the write rule. */
export function agentAccess({ person, scopes, work }: AgentAccessInput): AgentAccess {
  const limits: [AgentAccessLimit, AgentAccessLevel][] = [['role', roleLevel(person)], ['scope', scopeLevel(scopes)], ['write_rule', writeRuleLevel(work)]];
  const lowest = Math.min(...limits.map(([, level]) => rank(level)));
  const level = AGENT_ACCESS_LEVELS[lowest]!;
  return {
    level,
    limitedBy: limits.filter(([, l]) => rank(l) === lowest).map(([name]) => name),
    namedRun: level === 'edit' && work.kind === 'own_unreviewed_frame',
    workingCopyOnly: level === 'edit' && work.kind === 'solo_frame',
    heldUntilAccepted: work.kind === 'claim_about_people',
  };
}

/**
 * Whether an agent may use a capability. Editing also needs `work`, since the write rules decide
 * it; without `work` the answer is no.
 */
export function agentHasCapability(input: { person: Subject; scopes: readonly TokenScope[]; work?: AgentWork }, capability: Capability): boolean {
  if (AGENT_NEVER.includes(capability) || isOrgCapability(capability)) return false;
  if (!hasCapability(input.person, capability)) return false;
  if (!input.scopes.some((scope) => SCOPE_GRANTS[scope].includes(capability))) return false;
  if (capability === 'design.edit') {
    return input.work !== undefined && agentAccess({ person: input.person, scopes: input.scopes, work: input.work }).level === 'edit';
  }
  return true;
}
