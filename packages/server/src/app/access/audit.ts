/** The organization's audit log, written in the same transaction as the change it records. */
import type { Q } from '../db.js';
import type { User } from '../http/context.js';

export const audit = (q: Q, user: User, orgId: string, projectId: string | null, action: string, detail: object = {}) =>
  q(`INSERT INTO audit_log (org_id, project_id, actor, action, detail) VALUES ($1, $2, $3, $4, $5::jsonb)`, [orgId, projectId, user.id, action, JSON.stringify(detail)]);
