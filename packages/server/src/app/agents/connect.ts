/**
 * The connect flow (design direction "Connecting Claude or Cursor"): each person makes their own project-scoped
 * token for their agent, copies one command or URL, and tells the agent "Check my Rangoli queue". Also a person's
 * per-page choice for team imports: Protected (agents suggest) or Draft (the importer's agent edits).
 *
 * Browser sessions only: the design plane refuses tokens on every route but /mcp, so a token never mints a token
 * or loosens the rules it works under.
 */
import type { IncomingMessage } from 'node:http';
import { newToken, tokenHash } from '../auth.js';
import type { DesignAccess } from '../../design-routes.js';
import { dbErrorMessage } from '../db.js';
import type { AppCore } from '../http/context.js';
import type { DbAgentPlatform } from './platform-db.js';

/** What an agent token may do unless the person chooses otherwise: read, suggest, draft and take queued work. */
export const AGENT_TOKEN_SCOPES = ['read', 'propose', 'draft', 'jobs'] as const;
export const AGENT_TOKEN_DAYS = 90;

interface Ctx {
  req: IncomingMessage;
  url: URL;
  access: DesignAccess;
  json: (status: number, body: unknown) => void | Promise<void>;
  projectId: string;
  platform: DbAgentPlatform;
  core: AppCore;
}

const readJson = (req: IncomingMessage, limit = 10_000) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown;
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
      } catch {
        reject(new Error('Body is not JSON'));
      }
    });
    req.on('error', reject);
  });

/** The two steps the connect sheet shows: a command for Claude Code, a config for Cursor, and what to say. */
export function connectInstructions(origin: string, projectId: string, token: string) {
  const url = `${origin}/d/${projectId}/mcp`;
  return {
    mcpUrl: url,
    orgMcpUrl: `${origin}/mcp`,
    claudeCode: `claude mcp add --transport http rangoli ${url} --header "Authorization: Bearer ${token}"`,
    cursor: { mcpServers: { rangoli: { url, headers: { Authorization: `Bearer ${token}` } } } },
    thenSay: 'Check my Rangoli queue',
  };
}

export async function agentRoutes(c: Ctx): Promise<boolean> {
  const { req, url, access, json } = c;
  if (access.viaToken) return false;
  const can = (cap: string) => (access.can ?? []).includes(cap as never);

  if (url.pathname === '/api/agent-connect' && req.method === 'POST') {
    if (!access.userId) { await json(401, { error: 'Sign in to continue' }); return true; }
    const b = await readJson(req);
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : 'Claude Code';
    const days = typeof b.days === 'number' && b.days >= 1 && b.days <= 365 ? Math.round(b.days) : AGENT_TOKEN_DAYS;
    const token = newToken('rng_');
    try {
      const [row] = await c.core.as(access.userId, (q) => q<{ id: string }>(`SELECT token_create($1, $2, $3::uuid[], $4::text[], $5) AS id`, [name, tokenHash(token), [c.projectId], [...AGENT_TOKEN_SCOPES], days]));
      await json(200, { id: row!.id, token, scopes: AGENT_TOKEN_SCOPES, days, ...connectInstructions(c.core.originOf(req), c.projectId, token) });
    } catch (e) {
      const known = dbErrorMessage(e);
      await json(known?.status ?? 400, { error: known?.message ?? (e instanceof Error ? e.message : String(e)) });
    }
    return true;
  }

  const m = /^\/api\/pages\/([\w-]{1,80})\/agent-policy$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    if (!can('design.edit')) { await json(403, { error: 'Only people who can edit the design choose how agents treat a page' }); return true; }
    const b = await readJson(req);
    if (b.mode !== 'protected' && b.mode !== 'draft') { await json(400, { error: 'mode must be protected or draft' }); return true; }
    const importedBy = typeof b.importedBy === 'string' && /^[0-9a-f-]{36}$/i.test(b.importedBy) ? b.importedBy : null;
    try {
      await c.platform.setPagePolicy(m[1]!, b.mode, importedBy);
      await json(200, { page: m[1], mode: b.mode });
    } catch (e) {
      const known = dbErrorMessage(e);
      await json(known?.status ?? 400, { error: known?.message ?? (e instanceof Error ? e.message : String(e)) });
    }
    return true;
  }
  return false;
}
