/** Organizations, members, invites, guests, project roles and the Approver designation. */
import { ASSIGNABLE_PROJECT_ROLES, type OrgCapability, type ProjectCapability } from '@rangoli/engine';
import { z } from 'zod';
import { newToken, tokenHash } from '../auth.js';
import type { AppCore, Ctx, PublicRoute } from '../http/context.js';
import { readJson } from '../http/body.js';
import { HttpError, notFound } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import { email } from '../identity/schemas.js';
import { audit } from './audit.js';
import { requireOrgCapability } from './roles.js';

const INVITE_DAYS = 7;
/** Owner is never given or taken here: an organization has one, and it changes hands only by transfer. */
const orgRole = z.enum(['admin', 'member', 'guest']);
const projectRole = z.enum(ASSIGNABLE_PROJECT_ROLES);

const OWNER_STAYS = 'The owner stays until they hand the organization over.';

export function registerAccessRoutes(router: Router, core: AppCore): void {
  const { mail, notify, originOf, sessions } = core;
  const on = router.on.bind(router);

  /** 409 when the person is the owner, 404 when they are not in the organization. */
  const assertNotOwner = async (c: Ctx, orgId: string, userId: string) => {
    const [m] = await c.as((q) => q<{ role: string }>(`SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2`, [orgId, userId]));
    if (!m) throw notFound();
    if (m.role === 'owner') throw new HttpError(409, OWNER_STAYS);
  };

  /** A project's lead, or whoever manages its organization, may change who works on it. */
  const requireProjectStaffing = async (c: Ctx, projectId: string) => {
    const [p] = await c.as((q) => q<{ org_id: string; can: ProjectCapability[]; org_can: OrgCapability[] }>(`SELECT org_id, my_capabilities(id, 'project') AS can, my_capabilities(org_id, 'org') AS org_can FROM projects WHERE id = $1`, [projectId]));
    if (!p) throw notFound();
    if (!p.can.includes('members.manage') && !p.org_can.includes('org.members.manage')) throw new HttpError(403, 'Only the project lead and organization admins can change who works on a project.');
    return p;
  };

  // ---- organizations
  on('POST', '/api/orgs', async (c) => {
    const b = await c.body(z.object({ name: z.string().trim().min(1, 'Enter a name').max(80) }));
    const [org] = await c.as(async (q) => {
      const rows = await q<{ id: string; slug: string }>(`SELECT id, slug FROM create_org($1)`, [b.name]);
      await audit(q, c.user, rows[0]!.id, null, 'org.create', { name: b.name });
      return rows;
    });
    c.json(200, org);
  });

  // ---- admin panel
  on('GET', `/api/orgs/${U}/admin`, async (c) => {
    const { role, can } = await requireOrgCapability(c, c.p[0]!, 'org.members.manage');
    const out = await c.as(async (q) => {
      const org = await q(`SELECT id, name, slug FROM orgs WHERE id = $1`, [c.p[0]]);
      const members = await q(`SELECT u.id, u.name, u.email, m.role, m.created_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = $1 ORDER BY u.name`, [c.p[0]]);
      const invites = await q(`SELECT id, email, role, project_role, is_approver, project_ids, expires_at, created_at FROM invites WHERE org_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [c.p[0]]);
      const projects = await q(`SELECT id, name, stage FROM projects WHERE org_id = $1 ORDER BY name`, [c.p[0]]);
      const assignments = await q(`SELECT project_id, user_id, role, is_approver FROM project_members WHERE org_id = $1`, [c.p[0]]);
      // the activity log is the owner's (and later an auditor's): RLS returns nothing to anyone else
      const log = await q(`SELECT a.id, a.action, a.detail, a.created_at, u.name AS actor_name, p.name AS project_name FROM audit_log a LEFT JOIN users u ON u.id = a.actor LEFT JOIN projects p ON p.id = a.project_id WHERE a.org_id = $1 ORDER BY a.created_at DESC LIMIT 100`, [c.p[0]]);
      return { org: org[0], members, invites, projects, assignments, audit: log };
    });
    c.json(200, { ...out, me: { role, can } });
  });

  on('PATCH', `/api/orgs/${U}`, async (c) => {
    await requireOrgCapability(c, c.p[0]!, 'org.settings.manage');
    const b = await c.body(z.object({ name: z.string().trim().min(1).max(80) }));
    await c.as(async (q) => {
      await q(`UPDATE orgs SET name = $1 WHERE id = $2`, [b.name, c.p[0]]);
      await audit(q, c.user, c.p[0]!, null, 'org.rename', { name: b.name });
    });
    c.json(200, { ok: true });
  });

  on('POST', `/api/orgs/${U}/transfer`, async (c) => {
    await requireOrgCapability(c, c.p[0]!, 'org.transfer', 'Only the owner can hand the organization over.');
    const b = await c.body(z.object({ user: z.string().uuid() }));
    await c.as(async (q) => {
      await q(`SELECT transfer_org($1, $2)`, [c.p[0], b.user]);
      await audit(q, c.user, c.p[0]!, null, 'org.transfer', { user: b.user });
    });
    // the caller just lost the owner's rights: a fresh session token for the new privilege level
    await sessions.rotate(c.req, c.res);
    c.json(200, { ok: true });
  });

  on('PATCH', `/api/orgs/${U}/members/${U}`, async (c) => {
    await requireOrgCapability(c, c.p[0]!, 'org.members.manage');
    const b = await c.body(z.object({ role: orgRole }));
    await assertNotOwner(c, c.p[0]!, c.p[1]!);
    const rows = await c.as(async (q) => {
      const r = await q(`UPDATE org_members SET role = $1 WHERE org_id = $2 AND user_id = $3 RETURNING 1`, [b.role, c.p[0], c.p[1]]);
      if (r.length) {
        await audit(q, c.user, c.p[0]!, null, 'member.role', { user: c.p[1], role: b.role });
        // what they may do changed: their browsers sign in again
        await q(`SELECT member_sessions_end($1, $2)`, [c.p[0], c.p[1]]);
      }
      return r;
    });
    if (!rows.length) throw notFound();
    c.json(200, { ok: true });
  });

  // removing someone else needs org.members.manage; anyone but the owner may leave
  on('DELETE', `/api/orgs/${U}/members/${U}`, async (c) => {
    if (c.p[1] !== c.user.id) await requireOrgCapability(c, c.p[0]!, 'org.members.manage');
    await assertNotOwner(c, c.p[0]!, c.p[1]!);
    const rows = await c.as(async (q) => {
      // someone removed is signed out everywhere; leaving yourself keeps your other organizations' sessions
      if (c.p[1] !== c.user.id) await q(`SELECT member_sessions_end($1, $2)`, [c.p[0], c.p[1]]);
      const r = await q(`DELETE FROM org_members WHERE org_id = $1 AND user_id = $2 RETURNING 1`, [c.p[0], c.p[1]]);
      if (r.length) await audit(q, c.user, c.p[0]!, null, 'member.remove', { user: c.p[1] });
      return r;
    });
    if (!rows.length) throw notFound();
    c.json(200, { ok: true });
  });

  // ---- invites: an organization role, and a project role in the projects named
  on('POST', `/api/orgs/${U}/invites`, async (c) => {
    await requireOrgCapability(c, c.p[0]!, 'org.members.manage');
    const b = await c.body(
      z.object({
        email,
        role: orgRole,
        projects: z.array(z.string().uuid()).max(100).default([]),
        projectRole: projectRole.default('designer'),
        approver: z.boolean().optional(),
      }).refine((x) => x.role !== 'guest' || x.projects.length === 1, { message: 'A guest is invited to exactly one project', path: ['projects'] }),
    );
    // reviewers are there to decide, so they are approvers unless told otherwise
    const approver = b.approver ?? b.projectRole === 'reviewer';
    const token = newToken();
    await c.as(async (q) => {
      await q(`INSERT INTO invites (org_id, email, role, project_role, is_approver, token_hash, project_ids, invited_by, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], app_uid(), now() + make_interval(days => $8))`, [c.p[0], b.email, b.role, b.projectRole, approver, tokenHash(token), b.projects, INVITE_DAYS]);
      await audit(q, c.user, c.p[0]!, null, 'invite.create', { email: b.email, role: b.role, projectRole: b.projectRole, approver });
    });
    const url = `${originOf(c.req)}/invite/${token}`;
    const as = b.role === 'guest' ? 'a guest on one project' : `${b.role === 'admin' ? 'an admin' : 'a member'}`;
    if (mail.delivers) notify([b.email], `${c.user.name} invited you to Rangoli`, `${c.user.name} invited you to join their organization on Rangoli as ${as}.\n\nAccept: ${url}\n\nThis link works only for this address and expires in ${INVITE_DAYS} days.`);
    c.json(200, { url, emailed: mail.delivers, expiresInDays: INVITE_DAYS });
  });

  on('DELETE', `/api/orgs/${U}/invites/${U}`, async (c) => {
    await requireOrgCapability(c, c.p[0]!, 'org.members.manage');
    await c.as(async (q) => {
      await q(`UPDATE invites SET revoked_at = now() WHERE org_id = $1 AND id = $2`, [c.p[0], c.p[1]]);
      await audit(q, c.user, c.p[0]!, null, 'invite.revoke', { invite: c.p[1] });
    });
    c.json(200, { ok: true });
  });

  on('POST', '/api/invites/accept', async (c) => {
    const b = await c.body(z.object({ token: z.string().min(10).max(200) }));
    const [row] = await c.as((q) => q<{ slug: string }>(`SELECT accept_invite($1) AS slug`, [tokenHash(b.token)]));
    c.json(200, { slug: row!.slug });
  });

  // ---- who works on a project, in which role, and whether they approve
  on('PUT', `/api/projects/${U}/members/${U}`, async (c) => {
    const b = await c.body(z.object({ role: projectRole.optional(), approver: z.boolean().optional() }));
    const project = await requireProjectStaffing(c, c.p[0]!);
    await c.as(async (q) => {
      await q(
        `INSERT INTO project_members (project_id, org_id, user_id, added_by, role, is_approver) VALUES ($1, $2, $3, app_uid(), coalesce($4, 'designer'), coalesce($5, false))
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = coalesce($4, project_members.role), is_approver = coalesce($5, project_members.is_approver)`,
        [c.p[0], project.org_id, c.p[1], b.role ?? null, b.approver ?? null],
      );
      await audit(q, c.user, project.org_id, c.p[0]!, 'project.assign', { user: c.p[1], ...(b.role ? { role: b.role } : {}), ...(b.approver !== undefined ? { approver: b.approver } : {}) });
    });
    c.json(200, { ok: true });
  });

  on('DELETE', `/api/projects/${U}/members/${U}`, async (c) => {
    const project = await requireProjectStaffing(c, c.p[0]!);
    await c.as(async (q) => {
      await q(`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, [c.p[0], c.p[1]]);
      await audit(q, c.user, project.org_id, c.p[0]!, 'project.unassign', { user: c.p[1] });
    });
    c.json(200, { ok: true });
  });
}

/** What an invite link is for, shown before the person signs up or signs in. */
export function createAccessPublicRoutes(core: AppCore): PublicRoute {
  const { as } = core;
  return async (req, _res, url, json) => {
    if (req.method === 'POST' && url.pathname === '/api/invites/preview') {
      const b = z.object({ token: z.string().min(10).max(200) }).parse(await readJson(req));
      const [row] = await as(null, (q) => q(`SELECT * FROM invite_preview($1)`, [tokenHash(b.token)]));
      if (!row) throw notFound();
      json(200, row);
      return true;
    }
    return false;
  };
}
