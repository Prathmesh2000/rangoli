/**
 * Who may do what, as capabilities (packages/engine/src/capabilities.ts), and when the canvas is locked.
 *
 * The database answers through `has_capability`, the same check its RLS policies use, so the app never keeps
 * a second copy of the role table. RLS is the boundary; these checks exist to give clear errors and enforce
 * workflow. Nothing here compares role names.
 */
import { designOpenAt, hasCapability, stageDef, type OrgCapability, type OrganizationRole, type ProjectCapability, type ProjectRole, type StageId } from '@rangoli/engine';
import type { Q } from '../db.js';
import type { Role } from '../../session.js';
import type { As, Ctx } from '../http/context.js';
import { HttpError, notFound } from '../http/errors.js';

export interface ProjectAccess {
  org_id: string;
  stage: StageId;
  cycle: number;
  /** the caller's project role, for display */
  role: ProjectRole;
  /** what the caller may do here; under an API token, already narrowed to the token's scopes */
  can: ProjectCapability[];
  frozen: boolean;
}

/** The caller's capabilities on a project, with its stage; null when they are not on it. */
export type ProjectAccessOf = (userId: string, projectId: string) => Promise<ProjectAccess | null>;

/** The caller's capabilities on a project, inside a transaction already running as them. */
export const projectCapabilities = async (q: Q, projectId: string): Promise<ProjectCapability[]> =>
  (await q<{ can: ProjectCapability[] }>(`SELECT my_capabilities($1, 'project') AS can`, [projectId]))[0]?.can ?? [];

export const createProjectAccess = (as: As): ProjectAccessOf => async (userId, projectId) => {
  const [row] = await as(userId, (q) =>
    q<ProjectAccess & { role: ProjectRole | null }>(
      `SELECT org_id, stage, cycle, project_role_of(id) AS role, my_capabilities(id, 'project') AS can, coalesce(stage_frozen(id), false) AS frozen FROM projects WHERE id = $1`,
      [projectId],
    ),
  );
  return row?.role ? row : null;
};

/** Why this person cannot edit the canvas right now, or null when they can (or never could). */
export const lockFor = (stage: StageId, can: readonly ProjectCapability[], frozen: boolean): string | null => {
  if (!can.includes('design.edit')) return null;
  if (!designOpenAt(stage)) return `This project is in ${stageDef(stage)!.name}. The canvas accepts edits during Wireframes, Visual design and Prototype.`;
  return frozen ? 'This stage is out for review, so the design is frozen. Withdraw the review to keep editing.' : null;
};

/** Capabilities that change the design, withheld while the canvas is locked. */
const CANVAS_WRITES: readonly ProjectCapability[] = ['design.edit', 'suggestion.accept'];

/** What the design plane lets this person do: their capabilities, less the canvas writes while it is locked. */
export const designCapabilities = (can: readonly ProjectCapability[], lock: string | null): ProjectCapability[] => (lock ? can.filter((c) => !CANVAS_WRITES.includes(c)) : [...can]);

/** The design session's display role for a set of capabilities. Hosted projects never hand out 'owner'. */
export const designRole = (can: readonly ProjectCapability[]): Role => (can.includes('design.edit') ? 'editor' : can.includes('comment') ? 'reviewer' : 'viewer');

export function requireCapability(can: readonly ProjectCapability[], capability: ProjectCapability, message: string): void {
  if (!can.includes(capability)) throw new HttpError(403, message);
}

export interface OrgAccess {
  role: OrganizationRole;
  can: OrgCapability[];
}

/** The caller's organization role and capabilities; 404 when they are not in it, so its existence stays private. */
export const orgAccessOf = async (c: Ctx, orgId: string): Promise<OrgAccess> => {
  const [r] = await c.as((q) => q<{ role: OrganizationRole | null; can: OrgCapability[] }>(`SELECT org_role_of($1) AS role, my_capabilities($1, 'org') AS can`, [orgId]));
  if (!r?.role) throw notFound();
  return { role: r.role, can: r.can };
};

export const requireOrgCapability = async (c: Ctx, orgId: string, capability: OrgCapability, message = 'Only owners and admins can do that.'): Promise<OrgAccess> => {
  const access = await orgAccessOf(c, orgId);
  if (!access.can.includes(capability)) throw new HttpError(403, message);
  return access;
};

// ---------------------------------------------------------------- older call sites
// Kept so code written against the old names still compiles; each answers from the capability table, not a role name.

/** @deprecated use requireOrgCapability with the capability the route needs */
export const requireAdmin = async (c: Ctx, orgId: string): Promise<void> => void (await requireOrgCapability(c, orgId, 'org.members.manage'));

/** @deprecated use requireCapability(access.can, 'design.edit', …) */
export const requireWriter = (role: ProjectRole | null | undefined): void => {
  if (!role || !hasCapability({ projectRole: role }, 'design.edit')) throw new HttpError(403, 'Your role in this project can comment and review, but not change it.');
};

/** @deprecated use orgAccessOf */
export const orgRoleOf = async (c: Ctx, orgId: string): Promise<OrganizationRole> => (await orgAccessOf(c, orgId)).role;
