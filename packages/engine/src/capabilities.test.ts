import { describe, expect, it } from 'vitest';
import {
  AGENT_ACCESS_LEVELS,
  ASSIGNABLE_ORG_ROLES,
  ASSIGNABLE_PROJECT_ROLES,
  itemCapability,
  roleCapabilityRows,
  SCOPE_GRANTS,
  AGENT_NEVER,
  agentAccess,
  agentHasCapability,
  canDecideApproval,
  capabilitiesOf,
  hasCapability,
  ORG_CAPABILITIES,
  ORG_ROLES,
  PROJECT_CAPABILITIES,
  PROJECT_ROLES,
  TOKEN_SCOPES,
  type AgentWork,
  type Capability,
  type ProjectCapability,
  type ProjectRole,
  type Subject,
  type TokenScope,
} from './capabilities.js';

const COLUMNS: ProjectRole[] = ['lead', 'designer', 'researcher', 'product_manager', 'developer', 'reviewer', 'viewer'];

/** PRD §9, cell for cell. Y = 1, N = 0. Splits are noted where one PRD row holds two capabilities. */
const PRD_TABLE: [ProjectCapability, string][] = [
  ['design.view', '1111111'],
  ['comment', '1111110'],
  ['design.edit', '1100000'],
  ['suggestion.accept', '1100000'],
  ['evidence.add', '1111010'],
  ['decision.record', '1101000'],
  ['decision.propose', '1111110'], // Y or Propose
  ['transcript.read', '1010000'],
  ['task.create', '1111100'],
  ['export.run', '1100100'],
  ['export.view', '1101100'], // Y or View
  ['release', '1100000'],
  ['approve', '1111110'], // for named approvers
  ['members.manage', '1000000'],
  ['override.strict', '1000000'],
];

function subsets<T>(items: readonly T[]): T[][] {
  return items.reduce<T[][]>((all, item) => all.concat(all.map((set) => [...set, item])), [[]]);
}

const WORK: AgentWork[] = [
  { kind: 'own_unreviewed_frame' },
  { kind: 'solo_frame' },
  { kind: 'team_import', page: 'protected', authorizerOwnsImport: true },
  { kind: 'team_import', page: 'protected', authorizerOwnsImport: false },
  { kind: 'team_import', page: 'draft', authorizerOwnsImport: true },
  { kind: 'team_import', page: 'draft', authorizerOwnsImport: false },
  { kind: 'approved_or_in_review' },
  { kind: 'others_frame' },
  { kind: 'tokens' },
  { kind: 'components' },
  { kind: 'claim_about_people' },
];

describe('PRD §9 matrix', () => {
  it('covers every capability', () => {
    expect(PRD_TABLE.map(([capability]) => capability).sort()).toEqual([...PROJECT_CAPABILITIES].sort());
  });

  for (const [capability, row] of PRD_TABLE) {
    COLUMNS.forEach((role, i) => {
      const expected = row[i] === '1';
      it(`${role} ${expected ? 'has' : 'lacks'} ${capability}`, () => {
        expect(hasCapability({ projectRole: role, isApprover: true }, capability)).toBe(expected);
      });
    });
  }

  it.each(['writer', 'guest'] as const)('gives %s nothing until the PRD defines it', (projectRole) => {
    expect(capabilitiesOf({ projectRole, isApprover: true })).toEqual([]);
  });

  it('keeps "Propose" and "View" cells below the full capability', () => {
    expect(hasCapability({ projectRole: 'researcher' }, 'decision.propose')).toBe(true);
    expect(hasCapability({ projectRole: 'researcher' }, 'decision.record')).toBe(false);
    expect(hasCapability({ projectRole: 'product_manager' }, 'export.view')).toBe(true);
    expect(hasCapability({ projectRole: 'product_manager' }, 'export.run')).toBe(false);
  });
});

describe('approval', () => {
  it('needs the Approver designation', () => {
    expect(hasCapability({ projectRole: 'lead' }, 'approve')).toBe(false);
    expect(hasCapability({ projectRole: 'lead', isApprover: true }, 'approve')).toBe(true);
  });

  it('does not let a viewer approve even when designated', () => {
    expect(hasCapability({ projectRole: 'viewer', isApprover: true }, 'approve')).toBe(false);
  });

  it('is replaced by Release in a solo organization', () => {
    const solo: Subject = { orgRole: 'owner', projectRole: 'lead', isApprover: true, solo: true };
    expect(hasCapability(solo, 'approve')).toBe(false);
    expect(hasCapability(solo, 'release')).toBe(true);
  });

  const approver: Subject = { orgRole: 'admin', projectRole: 'lead', isApprover: true };

  it('blocks self-approval for every role, admins included', () => {
    expect(canDecideApproval({ subject: approver, actorId: 'a', requesterId: 'a' })).toBe(false);
    expect(canDecideApproval({ subject: { ...approver, orgRole: 'owner' }, actorId: 'a', requesterId: 'a' })).toBe(false);
  });

  it('blocks approval through an agent token', () => {
    expect(canDecideApproval({ subject: approver, actorId: 'a', requesterId: 'b', tokenId: 'tok' })).toBe(false);
  });

  it('allows a named approver reviewing someone else', () => {
    expect(canDecideApproval({ subject: approver, actorId: 'a', requesterId: 'b' })).toBe(true);
    expect(canDecideApproval({ subject: approver, actorId: 'a', requesterId: 'b', tokenId: null })).toBe(true);
  });
});

describe('organization roles stay separate from project roles', () => {
  it.each(ORG_ROLES)('%s gains no project capability without a project role', (orgRole) => {
    for (const capability of PROJECT_CAPABILITIES) expect(hasCapability({ orgRole, isApprover: true }, capability)).toBe(false);
  });

  it.each(PROJECT_ROLES)('%s gains no organization capability without an organization role', (projectRole) => {
    for (const capability of ORG_CAPABILITIES) expect(hasCapability({ projectRole }, capability)).toBe(false);
  });

  it('gives billing to the owner and billing admin only', () => {
    expect(ORG_ROLES.filter((orgRole) => hasCapability({ orgRole }, 'org.billing.manage'))).toEqual(['owner', 'billing_admin']);
  });

  it('gives an ordinary member the directory and project creation, and a guest nothing at organization level', () => {
    expect(capabilitiesOf({ orgRole: 'member' })).toEqual(['org.directory.read', 'org.projects.create']);
    expect(capabilitiesOf({ orgRole: 'guest' })).toEqual([]);
  });

  it('keeps deleting and handing over the organization to the owner', () => {
    for (const capability of ['org.delete', 'org.transfer'] as const) expect(ORG_ROLES.filter((orgRole) => hasCapability({ orgRole }, capability))).toEqual(['owner']);
  });

  it('assigns only roles that exist', () => {
    for (const r of ASSIGNABLE_ORG_ROLES) expect(ORG_ROLES).toContain(r);
    for (const r of ASSIGNABLE_PROJECT_ROLES) expect(PROJECT_ROLES).toContain(r);
  });

  it('lists every matrix cell once as a row', () => {
    const rows = roleCapabilityRows();
    expect(new Set(rows.map((r) => `${r.level}/${r.role}/${r.capability}`)).size).toBe(rows.length);
    for (const capability of ORG_CAPABILITIES) {
      expect(rows.filter((r) => r.capability === capability).map((r) => r.role).sort()).toEqual(ORG_ROLES.filter((orgRole) => hasCapability({ orgRole }, capability)).sort());
    }
    for (const capability of PROJECT_CAPABILITIES) {
      expect(rows.filter((r) => r.capability === capability).map((r) => r.role).sort()).toEqual(PROJECT_ROLES.filter((projectRole) => hasCapability({ projectRole, isApprover: true }, capability)).sort());
    }
  });
});

describe('lifecycle items', () => {
  it('splits evidence from the design plan', () => {
    expect(itemCapability('finding')).toBe('evidence.add');
    expect(itemCapability('research')).toBe('evidence.add');
    expect(itemCapability('persona')).toBe('design.edit');
    expect(itemCapability('screen')).toBe('design.edit');
  });
});

const everyScopeSet = subsets(TOKEN_SCOPES);
const everyPerson: Subject[] = ORG_ROLES.flatMap((orgRole) => PROJECT_ROLES.map((projectRole) => ({ orgRole, projectRole, isApprover: true })));

describe('agents', () => {
  // These sweeps cover hundreds of thousands of combinations. They collect what breaks and assert once:
  // one `expect` per combination is what used to make this file slow enough to time out.
  it('can never hold the forbidden capabilities, whatever the person, scope or work', () => {
    const broken: string[] = [];
    for (const person of everyPerson) {
      for (const scopes of everyScopeSet) {
        for (const capability of AGENT_NEVER) {
          if (agentHasCapability({ person, scopes }, capability)) broken.push(`${person.orgRole}/${person.projectRole} ${scopes.join('+')} ${capability}`);
          for (const work of WORK) if (agentHasCapability({ person, scopes, work }, capability)) broken.push(`${person.orgRole}/${person.projectRole} ${scopes.join('+')} ${capability} ${work.kind}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it('lists the four PRD prohibitions', () => {
    const required: Capability[] = ['approve', 'members.manage', 'org.members.manage', 'org.billing.manage', 'transcript.read'];
    for (const capability of required) expect(AGENT_NEVER).toContain(capability);
  });

  it('never holds an organization capability', () => {
    for (const capability of ORG_CAPABILITIES) {
      expect(agentHasCapability({ person: { orgRole: 'owner', projectRole: 'lead' }, scopes: TOKEN_SCOPES }, capability)).toBe(false);
    }
  });

  it('never exceeds the person', () => {
    const broken: string[] = [];
    for (const person of everyPerson) {
      for (const capability of PROJECT_CAPABILITIES) {
        if (hasCapability(person, capability)) continue;
        for (const work of WORK) if (agentHasCapability({ person, scopes: TOKEN_SCOPES, work }, capability)) broken.push(`${person.orgRole}/${person.projectRole} ${capability} ${work.kind}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('never exceeds what its scopes grant', () => {
    const broken: string[] = [];
    for (const scopes of everyScopeSet) {
      const granted = new Set(scopes.flatMap((scope) => SCOPE_GRANTS[scope]));
      for (const capability of PROJECT_CAPABILITIES) {
        if (granted.has(capability)) continue;
        for (const work of WORK) if (agentHasCapability({ person: { projectRole: 'lead', isApprover: true }, scopes, work }, capability)) broken.push(`${scopes.join('+')} ${capability}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('never exceeds the token scope', () => {
    const lead: Subject = { projectRole: 'lead' };
    expect(agentHasCapability({ person: lead, scopes: ['read'] }, 'design.view')).toBe(true);
    expect(agentHasCapability({ person: lead, scopes: ['read'] }, 'comment')).toBe(false);
    expect(agentHasCapability({ person: lead, scopes: ['propose'], work: { kind: 'own_unreviewed_frame' } }, 'design.edit')).toBe(false);
    expect(agentHasCapability({ person: lead, scopes: [] }, 'design.view')).toBe(false);
    expect(agentHasCapability({ person: lead, scopes: ['jobs'] }, 'design.view')).toBe(false);
    expect(agentHasCapability({ person: lead, scopes: ['export'] }, 'export.run')).toBe(true);
  });

  it('needs the work to be known before it can edit', () => {
    expect(agentHasCapability({ person: { projectRole: 'lead' }, scopes: ['draft'] }, 'design.edit')).toBe(false);
  });

  it('edits only where the write rules allow', () => {
    const allowed = WORK.filter((work) => agentHasCapability({ person: { projectRole: 'designer' }, scopes: ['draft'], work }, 'design.edit'));
    expect(allowed).toEqual([{ kind: 'own_unreviewed_frame' }, { kind: 'solo_frame' }, { kind: 'team_import', page: 'draft', authorizerOwnsImport: true }]);
  });

  it('is always the lowest of role, scope and write rule', () => {
    const roleRank: Record<ProjectRole, number> = { lead: 3, designer: 3, researcher: 2, product_manager: 2, developer: 2, reviewer: 2, viewer: 1, writer: 0, guest: 0 };
    const scopeRank = (scopes: TokenScope[]) => (scopes.includes('draft') ? 3 : scopes.includes('propose') ? 2 : scopes.includes('read') ? 1 : 0);
    const workRank = (work: AgentWork) => (work.kind === 'own_unreviewed_frame' || work.kind === 'solo_frame' || (work.kind === 'team_import' && work.page === 'draft' && work.authorizerOwnsImport) ? 3 : 2);
    const broken: string[] = [];
    for (const projectRole of PROJECT_ROLES) {
      for (const scopes of everyScopeSet) {
        for (const work of WORK) {
          const access = agentAccess({ person: { projectRole }, scopes, work });
          const ranks = { role: roleRank[projectRole], scope: scopeRank(scopes), write_rule: workRank(work) };
          const lowest = Math.min(...Object.values(ranks));
          const limitedBy = Object.entries(ranks).filter(([, rank]) => rank === lowest).map(([name]) => name).sort().join(',');
          if (access.level !== AGENT_ACCESS_LEVELS[lowest] || [...access.limitedBy].sort().join(',') !== limitedBy) broken.push(`${projectRole} ${scopes.join('+')} ${work.kind}: ${access.level} by ${access.limitedBy.join(',')}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  describe('write rules', () => {
    const edit = { person: { projectRole: 'lead' } as Subject, scopes: ['draft'] as TokenScope[] };

    it('edits the person\'s own unreviewed frames in a named run', () => {
      expect(agentAccess({ ...edit, work: { kind: 'own_unreviewed_frame' } })).toMatchObject({ level: 'edit', namedRun: true, workingCopyOnly: false });
    });

    it('edits solo imports and releases on the working copy', () => {
      expect(agentAccess({ ...edit, work: { kind: 'solo_frame' } })).toMatchObject({ level: 'edit', workingCopyOnly: true, namedRun: false });
    });

    it('only suggests on protected team imports and on another person\'s import', () => {
      expect(agentAccess({ ...edit, work: { kind: 'team_import', page: 'protected', authorizerOwnsImport: true } }).level).toBe('suggest');
      expect(agentAccess({ ...edit, work: { kind: 'team_import', page: 'draft', authorizerOwnsImport: false } }).level).toBe('suggest');
    });

    it.each(['approved_or_in_review', 'others_frame', 'tokens', 'components'] as const)('only suggests on %s', (kind) => {
      expect(agentAccess({ ...edit, work: { kind } })).toMatchObject({ level: 'suggest', limitedBy: ['write_rule'], heldUntilAccepted: false });
    });

    it('holds claims about people until accepted', () => {
      expect(agentAccess({ ...edit, work: { kind: 'claim_about_people' } })).toMatchObject({ level: 'suggest', heldUntilAccepted: true });
    });

    it('does not promise a named run when the agent cannot edit', () => {
      expect(agentAccess({ person: { projectRole: 'viewer' }, scopes: ['draft'], work: { kind: 'own_unreviewed_frame' } })).toMatchObject({ level: 'view', namedRun: false });
    });
  });
});
