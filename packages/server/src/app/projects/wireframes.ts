/** Design work driven from the journey: starter wireframes, device frames, agent wireframe requests, the handoff bundle. */
import {
  annotationsOf,
  applyRdl,
  deviceName,
  duplicateFrameOps,
  framesOfScreen,
  MAX_FRAME_SIZE,
  SCREEN_DEVICES,
  WF_DEVICES,
  WF_TEMPLATE_IDS,
  wireframeScript,
  type ItemKind,
  type LifecycleItem,
  type ProjectCapability,
  type ScreenDevicePreset,
  type WfDevice,
} from '@rangoli/engine';
import { z } from 'zod';
import { logger } from '../../telemetry/log.js';
import { requireCapability } from '../access/roles.js';
import type { Designs } from '../agents/designs.js';
import type { Q } from '../db.js';
import { HttpError, notFound } from '../http/errors.js';
import { U, type Router } from '../http/router.js';
import { actor } from '../store.js';
import type { Snapshots } from '../snapshots/snapshots.js';
import { buildHandoff, type HandoffBundle } from './handoff.js';
import type { Lifecycle } from './journey.js';

const preset = z.enum(Object.keys(SCREEN_DEVICES) as [ScreenDevicePreset, ...ScreenDevicePreset[]]);
const px = z.number().int().min(1).max(MAX_FRAME_SIZE);

interface FrameRow { id: string; screen_id: string; frame_node: string; device: string; w: number; h: number; is_primary: boolean }

/** A writer's view of one screen, read in the transaction that changes it. */
const screenIn = async (q: Q, projectId: string, screenId: string) => {
  const [p] = await q<{ org_id: string; role: string | null; can: ProjectCapability[] }>(`SELECT org_id, project_role_of(id) AS role, my_capabilities(id, 'project') AS can FROM projects WHERE id = $1`, [projectId]);
  if (!p?.role) throw notFound();
  requireCapability(p.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
  const [screen] = await q<LifecycleItem>(`SELECT id, kind, cycle, title, body, data, status, created_by, created_at FROM items WHERE id = $1 AND project_id = $2 AND kind = 'screen'`, [screenId, projectId]);
  if (!screen) throw notFound();
  const frames = await q<FrameRow>(`SELECT id, screen_id, frame_node, device, w, h, is_primary FROM screen_frames WHERE screen_id = $1 ORDER BY is_primary DESC, created_at`, [screenId]);
  return { orgId: p.org_id, screen, frames };
};

export function registerWireframeRoutes(router: Router, designs: Designs, lifecycle: Lifecycle, snapshots: Snapshots): void {
  const design = designs.open;
  const { journey, loadForMove } = lifecycle;
  const on = router.on.bind(router);

  /** One grayscale frame per screen that lacks one, so wireframing starts from the agreed IA. Open at any stage. */
  on('POST', `/api/projects/${U}/wireframes`, async (c) => {
    const b = await c.body(z.object({ device: preset.default('desktop'), templates: z.record(z.string(), z.enum(WF_TEMPLATE_IDS as [string, ...string[]])).default({}) }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    const entry = await design(c.p[0]!, j.project.org_id, c.user.id);
    const doc = entry.session.doc;
    const size = SCREEN_DEVICES[b.device];
    const missing = j.items.filter((i) => i.kind === 'screen' && !framesOfScreen(i, j.screenFrames).some((f) => doc.findNode(f)));
    const created: [string, string, string][] = [];
    actor.run(c.user.id, () => {
      for (const s of missing) {
        const script = wireframeScript(s.title, s.body, b.templates[s.id] ?? 'blank', b.device);
        const r = applyRdl(doc, script, { author: `human:${c.user.name}`, label: `wireframe ${s.title}` });
        const frame = r.created[0]!;
        created.push([s.id, frame, doc.findNode(frame)?.page.id ?? '']);
      }
    });
    await c.as(async (q) => {
      for (const [id, frame, page] of created) {
        // links to frames no longer on the canvas go; the new frame is linked with its device, then made primary
        const stale = j.screenFrames.filter((f) => f.screen === id && !doc.findNode(f.frame)).map((f) => f.frame);
        if (stale.length) await q(`DELETE FROM screen_frames WHERE screen_id = $1 AND frame_node = ANY($2::text[])`, [id, stale]);
        await q(`INSERT INTO screen_frames (project_id, org_id, screen_id, device, w, h, page_id, frame_node, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, app_uid()) ON CONFLICT (project_id, frame_node) DO NOTHING`, [c.p[0], j.project.org_id, id, b.device, size.w, size.h, page || null, frame]);
        await q(`UPDATE items SET data = data || $1::jsonb, updated_at = clock_timestamp() WHERE id = $2`, [JSON.stringify({ frame }), id]);
      }
    });
    c.json(200, { created: created.length });
  });

  /**
   * Duplicate to device: copies a screen's frame at another size, beside the original, and links the copy to the
   * same screen. Desktop, Tablet, iPad and Mobile once each; any number of custom sizes.
   */
  on('POST', `/api/projects/${U}/screens/${U}/frames`, async (c) => {
    const b = await c.body(z.union([
      z.object({ device: preset, from: z.string().max(40).optional() }),
      z.object({ device: z.literal('custom'), w: px, h: px, from: z.string().max(40).optional() }),
    ]));
    const { orgId, screen, frames } = await c.as((q) => screenIn(q, c.p[0]!, c.p[1]!));
    const entry = await design(c.p[0]!, orgId, c.user.id);
    const doc = entry.session.doc;
    const source = b.from ?? framesOfScreen(screen, frames.map((f) => ({ screen: f.screen_id, frame: f.frame_node, device: f.device as ScreenDevicePreset, w: f.w, h: f.h, primary: f.is_primary }))).find((f) => doc.findNode(f));
    if (!source || !doc.findNode(source)) throw new HttpError(409, 'This screen has no frame on the canvas to duplicate yet.');
    if (b.from && !framesOfScreen(screen, frames.map((f) => ({ screen: f.screen_id, frame: f.frame_node, device: 'custom', w: f.w, h: f.h, primary: f.is_primary }))).includes(b.from)) throw new HttpError(400, 'That frame is not one of this screen\'s frames.');
    if (b.device !== 'custom' && frames.some((f) => f.device === b.device && doc.findNode(f.frame_node))) throw new HttpError(409, `${screen.title} already has a ${deviceName(b.device)} frame.`);
    const size = b.device === 'custom' ? { w: b.w, h: b.h, label: `Custom ${b.w}×${b.h}` } : { ...SCREEN_DEVICES[b.device], label: SCREEN_DEVICES[b.device].name };
    let created: { ops: ReturnType<typeof duplicateFrameOps>['ops']; frame: string };
    try {
      created = duplicateFrameOps(doc, source, size);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    actor.run(c.user.id, () => doc.apply(created.ops, { author: `human:${c.user.name}`, label: `duplicate ${screen.title} to ${size.label}` }));
    const page = doc.findNode(created.frame)?.page.id ?? null;
    try {
      const [row] = await c.as((q) => q<{ id: string }>(
        `INSERT INTO screen_frames (project_id, org_id, screen_id, device, w, h, page_id, frame_node, linked_from, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, (SELECT id FROM screen_frames WHERE project_id = $1 AND frame_node = $9), app_uid()) RETURNING id`,
        [c.p[0], orgId, screen.id, b.device, size.w, size.h, page, created.frame, source],
      ));
      c.json(200, { id: row!.id, frame: created.frame, device: b.device, w: size.w, h: size.h });
    } catch (e) {
      // the link is the point of the copy: without it, take the copy back off the canvas
      try {
        actor.run(c.user.id, () => doc.apply([{ op: 'delete', id: created.frame }], { author: `human:${c.user.name}`, label: 'undo duplicate to device' }));
      } catch (err) {
        logger.error('could not remove an unlinked device frame', { err, frame: created.frame });
      }
      throw e;
    }
  });

  /** Make a linked frame the screen's primary one. */
  on('PATCH', `/api/projects/${U}/screens/${U}/frames/${U}`, async (c) => {
    await c.body(z.object({ primary: z.literal(true) }));
    await c.as(async (q) => {
      const { frames } = await screenIn(q, c.p[0]!, c.p[1]!);
      const row = frames.find((f) => f.id === c.p[2]);
      if (!row) throw notFound();
      await q(`UPDATE items SET data = data || $1::jsonb, updated_at = clock_timestamp() WHERE id = $2`, [JSON.stringify({ frame: row.frame_node }), c.p[1]]);
    });
    c.json(200, { ok: true });
  });

  /** Unlink a device frame from its screen. The frame stays on the canvas; the primary frame cannot be unlinked. */
  on('DELETE', `/api/projects/${U}/screens/${U}/frames/${U}`, async (c) => {
    await c.as(async (q) => {
      const { frames } = await screenIn(q, c.p[0]!, c.p[1]!);
      const row = frames.find((f) => f.id === c.p[2]);
      if (!row) throw notFound();
      if (row.is_primary) throw new HttpError(409, 'Make another frame primary before unlinking this one.');
      await q(`DELETE FROM screen_frames WHERE id = $1`, [row.id]);
    });
    c.json(200, { ok: true });
  });

  /** Queue one request per unbuilt screen, with what the agent needs to know from earlier stages. */
  on('POST', `/api/projects/${U}/agent-wireframes`, async (c) => {
    const b = await c.body(z.object({ device: z.enum(Object.keys(WF_DEVICES) as [WfDevice, ...WfDevice[]]).default('desktop') }));
    const j = await loadForMove(c.user.id, c.p[0]!);
    requireCapability(j.can, 'design.edit', 'Your role in this project can comment and review, but not change it.');
    const entry = await design(c.p[0]!, j.project.org_id, c.user.id);
    const doc = entry.session.doc;
    const by = (k: ItemKind) => j.items.filter((i) => i.kind === k);
    const inFlight = new Set(entry.session.reviews.requests.filter((r) => r.status === 'pending' || r.status === 'working').map((r) => r.screen?.id));
    const screens = by('screen').filter((s) => !framesOfScreen(s, j.screenFrames).some((f) => doc.findNode(f)) && !inFlight.has(s.id));
    const problem = by('problem')[0]?.body;
    const personas = by('persona').map((p) => `${p.title}: ${p.body}`).join('\n');
    actor.run(c.user.id, () => {
      for (const s of screens) {
        const stories = by('story').filter((x) => (s.data.stories as string[] | undefined)?.includes(x.id)).map((x) => `- ${x.data.want}${x.data.soThat ? `, so that ${x.data.soThat}` : ''}`).join('\n');
        const flows = by('flow').filter((f) => (f.data.steps as string[] | undefined)?.includes(s.id)).map((f) => f.title).join(', ');
        const prompt = [`Low-fidelity wireframe of the "${s.title}" screen. Structure only: use the +wf-* kit, no color or real images.`, s.body && `Purpose: ${s.body}`, problem && `Problem we are solving: ${problem}`, personas && `For:\n${personas}`, stories && `It has to let people:\n${stories}`, flows && `Part of these flows: ${flows}`].filter(Boolean).join('\n\n');
        entry.session.addRequest({ author: `human:${c.user.name}`, prompt, device: b.device, screen: { id: s.id, name: s.title } });
      }
    });
    c.json(200, { queued: screens.length });
  });

  /**
   * The handoff bundle, read from a named snapshot (?snapshot=<id>), by default the latest approved one. The working
   * copy (?snapshot=working, or when nothing is approved yet) comes back marked Unapproved.
   */
  on('GET', `/api/projects/${U}/handoff`, async (c) => {
    const j = await journey(c.user.id, c.p[0]!);
    requireCapability(j.can, 'export.view', 'Your role in this project cannot open the handoff bundle.');
    const which = c.url.searchParams.get('snapshot');
    if (which && which !== 'working' && !z.string().uuid().safeParse(which).success) throw new HttpError(400, 'That snapshot id is not valid.');
    const picked = which === 'working' ? null : await c.as(async (q) => {
      const id = which ?? (await snapshots.latestApproved(q, c.p[0]!))?.id;
      if (!id) return null;
      const snap = await snapshots.load(q, c.p[0]!, id);
      const by = await q<{ name: string; at: string }>(
        `SELECT d.approver_name AS name, d.created_at AS at FROM approval_decisions d JOIN approvals a ON a.id = d.approval_id WHERE a.snapshot_id = $1 AND d.decision = 'approved' AND approval_status(a.id) = 'approved' ORDER BY d.created_at`,
        [id],
      );
      return { snap, by };
    });
    let bundle: HandoffBundle;
    if (picked) {
      const { snap, by } = picked;
      const ref = { id: snap.id, name: snap.name, contentHash: snap.content_hash, libraryHash: snap.library_hash, canonVersion: snap.canon_version, engineVersion: snap.engine_version, signature: snap.signature, signingKey: snap.signing_key, createdAt: new Date(snap.created_at).toISOString(), createdBy: snap.created_by_name };
      bundle = buildHandoff(
        { project: j.project.name, cycle: snap.cycle, workType: j.workType.id, data: snap.data, items: snap.items, frames: snap.frames, annotations: snap.annotations },
        by.length ? { status: 'approved', snapshot: ref, approvedBy: by.map((d) => ({ name: d.name, at: new Date(d.at).toISOString() })) } : { status: 'snapshot', snapshot: ref, approvedBy: [] },
      );
    } else {
      const { session } = await design(c.p[0]!, j.project.org_id, c.user.id);
      bundle = buildHandoff(
        { project: j.project.name, cycle: j.project.cycle, workType: j.workType.id, data: session.doc.data, items: j.items, frames: j.screenFrames, annotations: annotationsOf(session.reviews) },
        { status: 'unapproved', snapshot: null, approvedBy: [] },
      );
    }
    const tag = bundle.unapproved ? 'unapproved' : bundle.snapshot!.contentHash.slice(0, 12);
    c.res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-rangoli-approval': bundle.approval,
      'content-disposition': `attachment; filename="handoff-cycle-${bundle.cycle}-${tag}.json"`,
    });
    c.res.end(JSON.stringify(bundle, null, 2));
  });
}
