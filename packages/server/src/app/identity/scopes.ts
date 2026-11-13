/**
 * What an API token may do. A token names its projects and some of these scopes; an agent's reach is the
 * lowest of the token's scopes and the authorizing person's role (the role is checked separately).
 *
 * Every MCP tool is listed once, with the one scope it needs, in the agent tool allowlist
 * (design/agent-tools.ts). A tool that is not listed is refused, so a new tool stays off for agents until someone
 * decides which scope it belongs to.
 */
import { toolPolicy } from '../../design/agent-tools.js';

export const TOKEN_SCOPES = ['read', 'propose', 'draft', 'items', 'export', 'jobs'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

export const SCOPE_LABELS: Record<TokenScope, string> = {
  read: 'Read the design, its history, lint and renders',
  propose: 'Comment and suggest changes for a person to accept',
  draft: 'Edit the design directly where the project allows it',
  items: 'Read and write lifecycle items: research, stories, screens',
  export: 'Export code, images and prototypes',
  jobs: 'Take requests queued for agents and mark them done',
};

/** The scope a tool needs, or undefined for a tool no token may call. */
export const scopeForTool = (tool: string): TokenScope | undefined => toolPolicy(tool)?.scope;

/** null when allowed, otherwise the reason to give the agent. */
export function toolRefusal(tool: string, scopes: readonly string[]): string | null {
  const need = scopeForTool(tool);
  if (!need) return `${tool} is not available to API tokens.`;
  if (!scopes.includes(need)) return `This token does not have the "${need}" scope, which ${tool} needs. Ask the person who made it for a token with that scope.`;
  return null;
}
