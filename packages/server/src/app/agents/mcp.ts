/** How an agent's MCP tools run in a hosted project: re-checked access, no host disk, lifecycle-aware writes. */
import type { DesignAccess } from '../../design-routes.js';
import type { McpOptions } from '../../mcp.js';
import type { Session } from '../../session.js';
import { lockFor, type ProjectAccessOf } from '../access/roles.js';
import { toolRefusal } from '../identity/scopes.js';
import type { TokenGrants } from '../identity/tokens.js';
import { tokenActor } from '../db.js';
import { actor } from '../store.js';
import type { Lifecycle } from '../projects/journey.js';

/** Agent tools that touch the server's own disk. On a shared server those paths are not the caller's. */
const HOST_DISK_TOOLS = new Set(['render_preview', 'export', 'prototype_export', 'icon_export', 'asset_upload', 'image_export']);
const DESIGN_WRITE_TOOLS = new Set(['agent_requests', 'agent_request_done', 'wireframe_start', 'annotate', 'rdl_apply', 'undo', 'redo', 'tokens_set_brand', 'design_language', 'token_set', 'motion_preset', 'image_edit', 'image_template', 'image_placeholder', 'version_save']);

export interface AgentDeps {
  projectAccess: ProjectAccessOf;
  journey: Lifecycle['journey'];
  /** the token's live scopes on this project, re-read at every call */
  tokenScopes: TokenGrants;
}

export function agentOptions(deps: AgentDeps, projectId: string, access: DesignAccess, session: Session): McpOptions {
  const { projectAccess, journey, tokenScopes } = deps;
  const userId = access.userId!;
  return {
    author: `agent:${access.name}`,
    // re-checked on every tool call, so a removed member's token stops working immediately
    wrap: (tool, run) =>
      tokenActor.run(access.tokenId!, () => actor.run(userId, async () => {
        const denied = (m: string) => ({ content: [{ type: 'text' as const, text: `Error: ${m}` }], isError: true });
        const now = await projectAccess(userId, projectId);
        if (!now) return denied('You no longer have access to this project.');
        // the token itself: revoked, expired or moved off this project stops the agent at its next call
        const scopes = await tokenScopes(userId, access.tokenId!, projectId);
        if (!scopes) return denied('This token was revoked, has expired, or does not cover this project.');
        const refusal = toolRefusal(tool, scopes);
        if (refusal) return denied(refusal);
        if (HOST_DISK_TOOLS.has(tool)) return denied(`${tool} reads or writes files on the server, so it is off in hosted projects. Use the app's downloads and uploads.`);
        if (DESIGN_WRITE_TOOLS.has(tool)) {
          // the person's role and the token's scopes, intersected by the database
          if (!now.can.includes('design.edit')) return denied('This agent cannot edit the design: the role of the person who made its token, or the token itself, does not allow it. Use suggest or comment.');
          const lock = lockFor(now.stage, now.can, now.frozen);
          if (lock) return denied(lock);
        }
        await session.store.warmAssets?.();
        return run();
      })),
    extraTools: (server) => {
      server.registerTool(
        'journey_get',
        { description: 'Where this project is in the UI/UX lifecycle: current stage, what is blocking it, and the problem, personas, stories, screens (with their frame ids) and flows to design from. Read this before designing.', inputSchema: {} },
        async () => {
          const j = await journey(userId, projectId);
          return { content: [{ type: 'text' as const, text: JSON.stringify({ stage: j.project.stage, cycle: j.project.cycle, role: j.role, can: j.can, current: j.stages.find((s) => s.current), items: j.items.map(({ id, kind, title, body, data, status }) => ({ id, kind, title, body, data, status })) }) }] };
        },
      );
    },
  };
}
