/**
 * The hosted app: accounts, organizations, projects and the design lifecycle.
 *
 * Every data access goes through withUser, so RLS answers "may this person see this row".
 * The role checks in the modules exist to give clear errors and enforce workflow; they are not the boundary.
 *
 * This file only composes the modules:
 *   http/      router, request context, body reading, errors, headers and CSP, the built editor
 *   identity/  sign-up, sign-in, password reset, sessions, API tokens, the signed-in account
 *   access/    organization and project roles, members, invites, the audit log
 *   projects/  projects, stages, lifecycle items, the journey, wireframes and handoff
 *   reviews/   review requests and sign-offs
 *   agents/    open design sessions, the /d/<project> design plane and MCP wiring
 */
import { createServer, type Server } from 'node:http';
import { z } from 'zod';
import { assetProxy } from '../asset-proxy.js';
import { logger } from '../telemetry/log.js';
import { observeRequest, readinessProbe } from '../telemetry/request.js';
import { createAccessPublicRoutes, registerAccessRoutes } from './access/routes.js';
import { createProjectAccess } from './access/roles.js';
import { createDesigns } from './agents/designs.js';
import { agentOptions } from './agents/mcp.js';
import { createDesignPlane } from './agents/plane.js';
import { withUser, type Database } from './db.js';
import { readBody, parseJson } from './http/body.js';
import type { AppCore, As } from './http/context.js';
import { HttpError, notFound, sendError } from './http/errors.js';
import { assertApiWrite, jsonResponder, originOf, setBaseHeaders } from './http/headers.js';
import { Router, U } from './http/router.js';
import { clientIp } from './http/client-ip.js';
import { serveEditor } from './http/static.js';
import { resolveIdentityConfig, type IdentityOptions } from './identity/config.js';
import { createIdentityPublicRoutes } from './identity/public.js';
import { registerIdentityRoutes } from './identity/routes.js';
import { createSessions, createStepUp } from './identity/sessions.js';
import { createTokenGrants } from './identity/tokens.js';
import { logMailer, type BlobStore, type Mailer } from './infra.js';
import { registerItemRoutes } from './projects/item-routes.js';
import { createLifecycle, type Lifecycle } from './projects/journey.js';
import { registerProjectRoutes } from './projects/routes.js';
import { registerWireframeRoutes } from './projects/wireframes.js';
import { registerReviewRoutes } from './reviews/routes.js';

export interface AppOptions {
  db: Database;
  port?: number;
  host?: string;
  /** https://… when behind a proxy; makes cookies Secure and invite links absolute */
  publicUrl?: string;
  /** new accounts need an invite (the very first account does not) */
  inviteOnly?: boolean;
  /** S3 on AWS; without it image bytes stay in Postgres */
  blobs?: BlobStore;
  /** SES on AWS; without it mail goes to the server log (refused in hosted production) */
  mail?: Mailer;
  /** MFA key, trusted proxies, throttle limits; read from the environment when not given */
  identity?: IdentityOptions;
}

export interface AppServer {
  url: string;
  server: Server;
  close(): Promise<void>;
}

export async function startApp(opts: AppOptions): Promise<AppServer> {
  const { db } = opts;
  const mail = opts.mail ?? logMailer;
  const as: As = (id, fn) => withUser(db, id, fn);
  // refuses to start a hosted deployment without its own MFA key or a real mail sender
  const identity = resolveIdentityConfig({ ...opts.identity, driver: db.driver, mail, publicUrl: opts.publicUrl });
  const sessions = createSessions(as, identity);
  const core: AppCore = {
    db,
    blobs: opts.blobs,
    mail,
    publicUrl: opts.publicUrl,
    inviteOnly: opts.inviteOnly,
    as,
    notify: (to, subject, text) => {
      if (!to.length) return;
      void mail.send({ to, subject, text }).catch((err: unknown) => logger.error('mail failed', { err }));
    },
    originOf: (req) => originOf(opts.publicUrl, req),
    identity,
    sessions,
    stepUp: createStepUp(as, sessions),
    clientIp: (req) => clientIp(req, identity.trustedProxies),
  };

  const projectAccess = createProjectAccess(as);
  // the journey needs an open design, and an open design's agents need the journey: bound once both exist
  let lifecycle: Lifecycle | undefined;
  const designs = createDesigns(core, (projectId, access, session) => agentOptions({ projectAccess, journey: (u, p) => lifecycle!.journey(u, p), tokenScopes: createTokenGrants(as) }, projectId, access, session));
  lifecycle = createLifecycle(as, designs);
  const designPlane = createDesignPlane(sessions, projectAccess, designs);

  const publicRoutes = [createIdentityPublicRoutes(core, sessions), createAccessPublicRoutes(core)];
  const router = new Router();
  router.on('GET', '/api/asset-proxy/.*', (c) => assetProxy.handle(c.req, c.res, c.url, c.user.id));
  registerIdentityRoutes(router, core);
  registerAccessRoutes(router, core);
  registerProjectRoutes(router, core, designs, lifecycle);
  registerItemRoutes(router, projectAccess, designs);
  registerReviewRoutes(router, core, designs, lifecycle);
  registerWireframeRoutes(router, designs, lifecycle);

  const ready = readinessProbe(() => as(null, (q) => q('SELECT 1')));

  const server = createServer((req, res) => observeRequest(req, res, async () => {
    setBaseHeaders(res);
    const json = jsonResponder(res);
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      // liveness only: restarting the one writer cannot fix a database outage
      if (path === '/healthz') return json(200, { ok: true });
      if (path === '/readyz') {
        const ok = await ready();
        return json(ok ? 200 : 503, { ok });
      }

      const d = new RegExp(`^/d/${U}(/.*)?$`).exec(path);
      if (d) return await designPlane(req, res, url, d[1]!, d[2] ?? '/');

      if (path.startsWith('/api/')) {
        assertApiWrite(req);
        for (const route of publicRoutes) if (await route(req, res, url, json)) return;
        const user = await sessions.currentUser(req);
        if (!user) throw new HttpError(401, 'Sign in to continue');
        const m = router.match(req.method, path);
        if (m) {
          return await m.h({
            req,
            res,
            url,
            user,
            p: m.p,
            json,
            body: async <T>(schema: z.ZodType<T>) => schema.parse(parseJson(await readBody(req))),
            as: (fn) => as(user.id, fn),
          });
        }
        throw notFound();
      }

      await serveEditor(req, res, path);
    } catch (e) {
      sendError(e, res, json);
    }
  }));

  const port = await new Promise<number>((ok, fail) => {
    server.once('error', fail);
    server.listen(opts.port ?? 4400, opts.host ?? '127.0.0.1', () => ok((server.address() as { port: number }).port));
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    server,
    close: async () => {
      await designs.close();
      await new Promise<void>((r) => {
        server.close(() => r());
        server.closeAllConnections(); // live event streams would otherwise hold this open
      });
    },
  };
}
