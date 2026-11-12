/** Lifecycle items (problem, personas, stories, screens, flows, findings, feedback…): create, change, delete. */
import type { ItemKind, LifecycleItem, ProjectRole } from '@rangoli/engine';
import { z } from 'zod';
import { logger } from '../../telemetry/log.js';
import type { ProjectAccessOf } from '../access/roles.js';
import type { Designs } from '../agents/designs.js';
import type { Q } from '../db.js';
import { HttpError, notFound } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import { ITEM_KINDS, references, validateData, validateStatus } from '../items.js';
import { actor } from '../store.js';

const assertRefs = async (q: Q, projectId: string, kind: ItemKind, data: Record<string, unknown>) => {
  const refs = references(kind, data);
  if (!refs.length) return;
  const found = await q<{ id: string; kind: ItemKind }>(`SELECT id, kind FROM items WHERE project_id = $1 AND id = ANY($2::uuid[])`, [projectId, refs.map((r) => r.id)]);
  for (const r of refs) if (!found.some((f) => f.id === r.id && f.kind === r.kind)) throw new HttpError(400, 'One of the linked items no longer exists.');
};

/**
 * The caller's access, read inside the transaction that writes, so a removal or role change cannot land between
 * the check and the write. Every stage is open: any item can be added or changed at any time.
 */
const accessIn = async (q: Q, projectId: string) => {
  const [row] = await q<{ org_id: string; cycle: number; role: ProjectRole | null }>(`SELECT org_id, cycle, project_role_of(id) AS role FROM projects WHERE id = $1`, [projectId]);
  if (!row?.role) throw notFound();
  return row;
};

const itemInput = z.object({ title: z.string().trim().max(300).optional(), body: z.string().trim().max(20000).optional(), data: z.record(z.string(), z.unknown()).optional(), status: z.string().optional() });

// The access function stays in the signature for the server's wiring; the checks now run in the write's transaction.
export function registerItemRoutes(router: Router, _projectAccess: ProjectAccessOf, designs: Designs): void {
  const design = designs.open;
  const on = router.on.bind(router);

  on('POST', `/api/projects/${U}/items`, async (c) => {
    const b = await c.body(itemInput.extend({ kind: z.enum(ITEM_KINDS as [ItemKind, ...ItemKind[]]) }));
    const data = validateData(b.kind, b.data);
    const { item, orgId, frame } = await c.as(async (q) => {
      const access = await accessIn(q, c.p[0]!);
      await assertRefs(q, c.p[0]!, b.kind, data);
      const [item] = await q<LifecycleItem>(`INSERT INTO items (project_id, org_id, kind, cycle, title, body, data, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, app_uid()) RETURNING id, kind, cycle, title, body, data, status, created_by, created_at`, [c.p[0], access.org_id, b.kind, access.cycle, b.title ?? '', b.body ?? '', JSON.stringify(data)]);
      // a usability finding is pinned to its screen's primary frame
      const [screen] = b.kind === 'finding' && data.screen ? await q<{ data: { frame?: string } }>(`SELECT data FROM items WHERE id = $1 AND project_id = $2`, [data.screen, c.p[0]]) : [];
      return { item: item!, orgId: access.org_id, frame: screen?.data.frame };
    });
    // after commit, and best effort: the finding is saved whether or not its pin can be placed
    if (frame) {
      try {
        const entry = await design(c.p[0]!, orgId, c.user.id);
        if (entry.session.doc.findNode(frame)) {
          const thread = actor.run(c.user.id, () => entry.session.addThread({ node: frame, author: `human:${c.user.name}`, body: item.body || item.title, kind: 'review', severity: data.severity as 'P0', title: item.title }));
          await c.as((q) => q(`UPDATE items SET data = data || $1::jsonb WHERE id = $2`, [JSON.stringify({ thread: thread.id }), item.id]));
        }
      } catch (err) {
        logger.error('could not pin a finding to its screen', { err, item: item.id });
      }
    }
    c.json(200, item);
  });

  on('PATCH', `/api/projects/${U}/items/${U}`, async (c) => {
    const b = await c.body(itemInput);
    await c.as(async (q) => {
      await accessIn(q, c.p[0]!);
      const [item] = await q<LifecycleItem>(`SELECT id, kind, data, status FROM items WHERE id = $1 AND project_id = $2`, [c.p[1], c.p[0]]);
      if (!item) throw notFound();
      const data = validateData(item.kind, { ...item.data, ...(b.data ?? {}) });
      const status = b.status === undefined ? item.status : validateStatus(item.kind, b.status);
      await assertRefs(q, c.p[0]!, item.kind, data);
      const out = await q(`UPDATE items SET title = coalesce($1, title), body = coalesce($2, body), data = $3::jsonb, status = $4, updated_at = clock_timestamp() WHERE id = $5 AND project_id = $6 RETURNING id`, [b.title ?? null, b.body ?? null, JSON.stringify(data), status, c.p[1], c.p[0]]);
      if (!out.length) throw new HttpError(403, 'You can only change your own findings and feedback.');
    });
    c.json(200, { ok: true });
  });

  on('DELETE', `/api/projects/${U}/items/${U}`, async (c) => {
    await c.as(async (q) => {
      await accessIn(q, c.p[0]!);
      const [item] = await q(`SELECT 1 FROM items WHERE id = $1 AND project_id = $2`, [c.p[1], c.p[0]]);
      if (!item) throw notFound();
      const rows = await q(`DELETE FROM items WHERE id = $1 AND project_id = $2 RETURNING 1`, [c.p[1], c.p[0]]);
      if (!rows.length) throw new HttpError(403, 'You cannot delete that.');
    });
    c.json(200, { ok: true });
  });
}
