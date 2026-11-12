import {
  agentHasCapability,
  ASSIGNABLE_ORG_ROLES,
  ASSIGNABLE_PROJECT_ROLES,
  capabilitiesOf,
  createDocument,
  itemCapability,
  ORG_CAPABILITIES,
  PROJECT_CAPABILITIES,
  roleCapabilityRows,
  SCOPE_GRANTS,
  TOKEN_SCOPES,
  type Capability,
  type TokenScope,
} from '@rangoli/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase, tokenActor, withUser, type Database, type Q } from '../db.js';
import { ITEM_KINDS } from '../items.js';

/**
 * packages/engine/src/capabilities.ts is the source of truth; the database enforces it through `has_capability`.
 * These tests fail as soon as the two disagree, in the table or in what a real person ends up holding.
 */
describe('capabilities.ts and the database agree', () => {
  let db: Database;
  let org = '';
  let project = '';
  const users: Record<string, string> = {};
  const as = <T>(id: string | null, fn: (q: Q) => Promise<T>) => withUser(db, id, fn);
  const sorted = <T>(xs: T[]) => [...xs].sort();
  const subsets = <T>(items: readonly T[]): T[][] => items.reduce<T[][]>((all, item) => all.concat(all.map((set) => [...set, item])), [[]]);
  const signup = async (name: string) => (await as(null, (q) => q<{ id: string }>(`SELECT auth_signup($1, $2, 'hash') AS id`, [`${name}@caps.io`, name])))[0]!.id;
  const projectCaps = (who: string, p = project) => as(who, (q) => q<{ c: string[] }>(`SELECT my_capabilities($1, 'project') AS c`, [p])).then((r) => r[0]!.c);
  const orgCaps = (who: string, o = org) => as(who, (q) => q<{ c: string[] }>(`SELECT my_capabilities($1, 'org') AS c`, [o])).then((r) => r[0]!.c);
  const only = (caps: Capability[], level: 'org' | 'project') => caps.filter((c) => (level === 'org' ? (ORG_CAPABILITIES as readonly string[]) : (PROJECT_CAPABILITIES as readonly string[])).includes(c));

  beforeAll(async () => {
    db = await openDatabase({ url: process.env.TEST_DATABASE_URL });
    users.owner = await signup('owner');
    org = (await as(users.owner, (q) => q<{ id: string }>(`SELECT id FROM create_org('Caps')`)))[0]!.id;
    project = (await as(users.owner, (q) => q<{ id: string }>(`SELECT create_project($1, 'P', '', $2::json) AS id`, [org, JSON.stringify(createDocument('x').data)])))[0]!.id;
    const orgPeople = ASSIGNABLE_ORG_ROLES.filter((r) => r !== 'owner');
    for (const orgRole of orgPeople) users[`org:${orgRole}`] = await signup(`org-${orgRole}`);
    for (const projectRole of ASSIGNABLE_PROJECT_ROLES) for (const approver of [true, false]) users[`${projectRole}:${approver}`] = await signup(`${projectRole}-${approver}`);
    // joining normally goes through accept_invite; the schema owner keeps this setup short
    await db.tx(async (q) => {
      for (const orgRole of orgPeople) await q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, $3)`, [org, users[`org:${orgRole}`], orgRole]);
      for (const projectRole of ASSIGNABLE_PROJECT_ROLES) {
        for (const approver of [true, false]) {
          const id = users[`${projectRole}:${approver}`];
          await q(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'member')`, [org, id]);
          await q(`INSERT INTO project_members (project_id, org_id, user_id, role, is_approver) VALUES ($1, $2, $3, $4, $5)`, [project, org, id, projectRole, approver]);
        }
      }
    });
  }, 60000);
  afterAll(() => db?.close());

  it('holds the same role table', async () => {
    const rows = await db.tx((q) => q<{ level: string; role: string; capability: string }>(`SELECT level, role, capability FROM role_capabilities`));
    const key = (r: { level: string; role: string; capability: string }) => `${r.level}/${r.role}/${r.capability}`;
    expect(sorted(rows.map(key))).toEqual(sorted(roleCapabilityRows().map(key)));
  });

  it('holds the same token scopes', async () => {
    const rows = await db.tx((q) => q<{ scope: string; capability: string }>(`SELECT scope, capability FROM token_scope_grants`));
    const expected = TOKEN_SCOPES.flatMap((scope) => SCOPE_GRANTS[scope].map((capability) => `${scope}/${capability}`));
    expect(sorted(rows.map((r) => `${r.scope}/${r.capability}`))).toEqual(sorted(expected));
  });

  it('accepts exactly the assignable roles', async () => {
    const checks = await db.tx((q) => q<{ name: string; def: string }>(`SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname IN ('org_members_role_check', 'project_members_role_check')`));
    const roles = (name: string) => sorted([...checks.find((c) => c.name === name)!.def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!));
    expect(roles('org_members_role_check')).toEqual(sorted([...ASSIGNABLE_ORG_ROLES]));
    expect(roles('project_members_role_check')).toEqual(sorted([...ASSIGNABLE_PROJECT_ROLES]));
  });

  it('splits lifecycle items the same way', async () => {
    const rows = await db.tx((q) => q<{ k: string; c: string }>(`SELECT k, item_capability(k) AS c FROM unnest($1::text[]) k`, [ITEM_KINDS]));
    for (const r of rows) expect(r.c, r.k).toBe(itemCapability(r.k));
  });

  it('gives every project role what capabilities.ts gives it, with and without the Approver designation', async () => {
    for (const projectRole of ASSIGNABLE_PROJECT_ROLES) {
      for (const isApprover of [true, false]) {
        const expected = only(capabilitiesOf({ orgRole: 'member', projectRole, isApprover }), 'project');
        expect(await projectCaps(users[`${projectRole}:${isApprover}`]!), `${projectRole} approver=${isApprover}`).toEqual(sorted(expected));
      }
    }
  });

  it('gives every organization role what capabilities.ts gives it, and nothing in a project without a project role', async () => {
    for (const orgRole of ASSIGNABLE_ORG_ROLES) {
      const id = orgRole === 'owner' ? users.owner! : users[`org:${orgRole}`]!;
      expect(await orgCaps(id), orgRole).toEqual(sorted(only(capabilitiesOf({ orgRole }), 'org')));
      if (orgRole !== 'owner') expect(await projectCaps(id), orgRole).toEqual([]);
    }
  });

  it('has no approval in a solo organization: Release replaces it', async () => {
    const solo = await signup('solo');
    const soloOrg = (await as(solo, (q) => q<{ id: string }>(`SELECT id FROM create_org('Solo')`)))[0]!.id;
    const soloProject = (await as(solo, (q) => q<{ id: string }>(`SELECT create_project($1, 'S', '', '{}'::json) AS id`, [soloOrg])))[0]!.id;
    expect(await projectCaps(solo, soloProject)).toEqual(sorted(only(capabilitiesOf({ orgRole: 'owner', projectRole: 'lead', isApprover: true, solo: true }), 'project')));
    expect(await projectCaps(solo, soloProject)).toContain('release');
  });

  it('intersects the person with every combination of token scopes, and never reaches the organization', async () => {
    const lead = users['lead:true']!;
    const scopeSets = subsets(TOKEN_SCOPES).filter((s) => s.length > 0);
    const broken: string[] = [];
    for (const scopes of scopeSets) {
      const [tok] = await db.tx((q) =>
        q<{ id: string }>(`INSERT INTO api_tokens (user_id, name, token_hash, org_id, project_ids, scopes, expires_at) VALUES ($1, 't', $2, $3, $4::uuid[], $5::text[], now() + interval '1 day') RETURNING id`, [lead, `caps-${scopes.join('+')}`, org, [project], scopes]),
      );
      // the database cannot know the write rule, so editing is modelled on work the rules let an agent edit
      const expected = PROJECT_CAPABILITIES.filter((c) => agentHasCapability({ person: { orgRole: 'member', projectRole: 'lead', isApprover: true }, scopes: scopes as TokenScope[], work: { kind: 'solo_frame' } }, c));
      const got = await tokenActor.run(tok!.id, () => projectCaps(lead));
      if (JSON.stringify(got) !== JSON.stringify(sorted(expected))) broken.push(`${scopes.join('+')}: got ${got.join(',')} want ${sorted(expected).join(',')}`);
      const org_ = await tokenActor.run(tok!.id, () => orgCaps(lead));
      if (org_.length) broken.push(`${scopes.join('+')}: org ${org_.join(',')}`);
    }
    expect(broken).toEqual([]);
  }, 60000);

  it('gives a token nothing when it is revoked, expired, unknown or someone else\'s', async () => {
    const lead = users['lead:true']!;
    const designer = users['designer:true']!;
    const make = (user: string, extra: string) =>
      db.tx((q) => q<{ id: string }>(`INSERT INTO api_tokens (user_id, name, token_hash, org_id, project_ids, scopes, expires_at, revoked_at) VALUES ($1, 't', $2, $3, $4::uuid[], '{read,propose,draft,items,export,jobs}', ${extra}) RETURNING id`, [user, `dead-${extra}-${user}`, org, [project]])).then((r) => r[0]!.id);
    for (const tok of [await make(lead, `now() + interval '1 day', now()`), await make(lead, `now() - interval '1 second', NULL`), '00000000-0000-4000-8000-00000000dead', await make(designer, `now() + interval '1 day', NULL`)]) {
      expect(await tokenActor.run(tok, () => projectCaps(lead)), tok).toEqual([]);
    }
  });
});
