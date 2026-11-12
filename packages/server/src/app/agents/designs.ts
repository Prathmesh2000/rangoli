/** Open designs: one live Session per project, loaded on first use and swept when idle. */
import type { DocumentData } from '@rangoli/engine';
import { hydrateDocument } from '@rangoli/engine/io';
import { createDesignRoutes, type DesignAccess, type DesignRoutes } from '../../design-routes.js';
import type { McpOptions } from '../../mcp.js';
import { Session } from '../../session.js';
import { logger } from '../../telemetry/log.js';
import type { AppCore } from '../http/context.js';
import { notFound } from '../http/errors.js';
import { tokenActor } from '../db.js';
import { actor, DbStore } from '../store.js';

export interface OpenDesign {
  session: Session;
  routes: DesignRoutes;
  lastUsed: number;
}

export interface Designs {
  /** Called only after the caller's access is confirmed; the load itself also runs under their identity. */
  open(projectId: string, orgId: string, userId: string): Promise<OpenDesign>;
  /** Forgets a project's session, e.g. after the project is deleted. */
  evict(projectId: string): void;
  /** Flushes and closes every open session. */
  close(): Promise<void>;
}

export type McpOptionsFor = (projectId: string, access: DesignAccess, session: Session) => McpOptions;

export function createDesigns(core: AppCore, mcpOptions: McpOptionsFor): Designs {
  const { db, blobs, as } = core;
  const open = new Map<string, Promise<OpenDesign>>();

  const evict = (projectId: string) => {
    const entry = open.get(projectId);
    open.delete(projectId);
    void entry?.then((e) => e.routes.close()).catch(() => undefined);
  };

  const design = (projectId: string, orgId: string, userId: string): Promise<OpenDesign> => {
    let entry = open.get(projectId);
    if (!entry) {
      entry = (async () => {
        const [row] = await as(userId, (q) => q<{ data: DocumentData }>(`SELECT data FROM designs WHERE project_id = $1`, [projectId]));
        if (!row) throw notFound();
        const store = new DbStore(db, projectId, orgId, () => {
          logger.error('a save was refused; reloading the project from the database', { projectId });
          evict(projectId);
        }, blobs);
        const session = await actor.run(userId, () => Session.fromStore(store, hydrateDocument(row.data)));
        // A finished request for a planned screen becomes that screen's frame, written as the agent's owner and
        // through the agent's token, so RLS judges it exactly as it judges the agent. The identity is taken
        // while the tool call that finished the request is still running; without one, the link is refused out
        // loud rather than written as nobody (which RLS turns into a silent no-op).
        session.on('agentRequestDone', (r) => {
          const screen = r.screen?.id;
          if (r.status !== 'done' || !screen || !r.frame) return;
          const owner = actor.getStore();
          const token = tokenActor.getStore();
          if (!owner) {
            logger.error('a finished agent request had no person behind it, so its frame was not linked', { projectId, request: r.id });
            return;
          }
          const link = () => as(owner, (q) => q(`UPDATE items SET data = data || $1::jsonb, updated_at = clock_timestamp() WHERE id = $2 AND project_id = $3 AND kind = 'screen' RETURNING 1`, [JSON.stringify({ frame: r.frame }), screen, projectId]));
          void (token ? tokenActor.run(token, link) : link())
            .then((rows) => {
              if (!rows.length) logger.warn('the frame of a finished agent request was not linked: the screen is gone or its person may not edit it', { projectId, request: r.id });
              routes.broadcast('journey', Date.now());
            })
            .catch((err: unknown) => logger.error('could not link the frame', { err, projectId }));
        });
        const routes = createDesignRoutes(session, { hosted: true, mcpOptions: (access) => mcpOptions(projectId, access, session) });
        return { session, routes, lastUsed: Date.now() };
      })();
      entry.catch(() => open.delete(projectId));
      open.set(projectId, entry);
    }
    return entry.then((e) => {
      e.lastUsed = Date.now();
      return e;
    });
  };

  const sweep = setInterval(() => {
    for (const [id, entry] of open) {
      void entry
        .then(async (e) => {
          if (e.routes.connections() > 0 || Date.now() - e.lastUsed < 10 * 60 * 1000) return;
          await e.session.flush();
          if (open.get(id) === entry) evict(id);
        })
        .catch(() => undefined);
    }
  }, 60 * 1000);
  sweep.unref();

  return {
    open: design,
    evict,
    close: async () => {
      clearInterval(sweep);
      for (const entry of open.values()) {
        const e = await entry.catch(() => null);
        if (!e) continue;
        await e.session.flush().catch(() => undefined);
        e.routes.close();
      }
      open.clear();
    },
  };
}
