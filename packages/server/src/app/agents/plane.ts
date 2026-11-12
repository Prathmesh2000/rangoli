/** /d/<project>/… is one design's editor API, live events, preview, prototype and MCP endpoint. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { crossSiteWrite, type DesignAccess } from '../../design-routes.js';
import { designCapabilities, designRole, lockFor, type ProjectAccessOf } from '../access/roles.js';
import { tokenActor } from '../db.js';
import type { User } from '../http/context.js';
import { HttpError } from '../http/errors.js';
import { assertApiWrite, sameOrigin } from '../http/headers.js';
import type { Sessions } from '../identity/sessions.js';
import { actor } from '../store.js';
import type { Designs } from './designs.js';

export type DesignPlane = (req: IncomingMessage, res: ServerResponse, url: URL, projectId: string, rest: string) => Promise<void>;

export function createDesignPlane(sessions: Sessions, projectAccess: ProjectAccessOf, designs: Designs): DesignPlane {
  return async (req, res, url, projectId, rest) => {
    const bearer = /^Bearer (rng_[\w-]+)$/.exec(req.headers.authorization ?? '')?.[1];
    // agents work through MCP; every other route here is a person's and needs a browser session
    if (bearer && rest !== '/mcp') return void res.writeHead(403, { 'content-type': 'text/plain' }).end('API tokens only work on the MCP endpoint');
    // A browser sends the session cookie wherever a request comes from, so a cookie write must be provably
    // same-site JSON before anything else runs. A bearer token is never sent by a browser on its own; it still
    // may not come from another origin.
    if (!bearer) {
      assertApiWrite(req);
      if (crossSiteWrite(req)) throw new HttpError(403, 'Cross-origin or non-JSON write rejected');
    } else if (!sameOrigin(req)) {
      throw new HttpError(403, 'Cross-origin request rejected');
    }
    let token: (User & { token_id: string }) | undefined;
    // a token works only on the projects it names
    if (bearer) token = await sessions.tokenUser(bearer, projectId);
    const user = bearer ? token ?? null : await sessions.currentUser(req);
    if (!user) return void res.writeHead(401, { 'content-type': 'text/plain' }).end('Sign in to continue');
    const signedIn = user;
    // under a token, what it may do is already narrowed to the token's scopes
    const access = await (token ? tokenActor.run(token.token_id, () => projectAccess(signedIn.id, projectId)) : projectAccess(signedIn.id, projectId));
    if (!access) return void res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    const entry = await designs.open(projectId, access.org_id, signedIn.id);
    const lock = lockFor(access.stage, access.can, access.frozen);
    const can = designCapabilities(access.can, lock);
    const sub = new URL(url);
    sub.pathname = rest || '/';
    const da: DesignAccess = {
      // while the canvas is locked, nobody gets the capabilities that change it
      role: designRole(can),
      can,
      name: signedIn.name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 32),
      fixedName: true,
      userId: signedIn.id,
      viaToken: !!bearer,
      tokenId: token?.token_id,
      lockReason: lock,
      stillAllowed: async () => !!(await projectAccess(signedIn.id, projectId)),
    };
    const serve = () => actor.run(signedIn.id, async () => {
      if (!(await entry.routes.handle(req, res, sub, da))) res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    });
    await (token ? tokenActor.run(token.token_id, serve) : serve());
  };
}
