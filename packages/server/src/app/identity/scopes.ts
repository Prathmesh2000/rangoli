/**
 * What an API token may do. A token names its projects and some of these scopes; an agent's reach is the
 * lowest of the token's scopes and the authorizing person's role (the role is checked separately).
 *
 * Every MCP tool is listed here under the one scope it needs. A tool that is not listed is refused, so a new
 * tool stays off for agents until someone decides which scope it belongs to.
 */
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

const TOOLS: Record<TokenScope, string[]> = {
  read: [
    'rdl_help', 'doc_info', 'doc_outline', 'node_get', 'search_nodes', 'rdl_check', 'history', 'lint', 'tokens_get', 'palette_generate',
    'contrast_check', 'motion_get', 'motion_curve', 'motion_presets', 'suggestions_list', 'comments_list', 'diff', 'versions_list', 'proto_get',
    'render_png', 'render_preview', 'motion_filmstrip', 'icon_list', 'icon_get', 'icon_render', 'components_list', 'component_help', 'patterns_list',
    'pattern_help', 'asset_list', 'image_templates', 'selection_get', 'journey_get',
  ],
  propose: ['suggest', 'comment', 'review_add'],
  draft: [
    'rdl_apply', 'undo', 'redo', 'tokens_set_brand', 'design_language', 'token_set', 'motion_preset', 'version_save', 'image_edit', 'image_template',
    'image_placeholder', 'annotate', 'wireframe_start', 'asset_upload',
  ],
  items: [],
  export: ['export', 'prototype_export', 'icon_export', 'image_export'],
  jobs: ['inbox', 'agent_requests', 'agent_request_done'],
};

const TOOL_SCOPE = new Map<string, TokenScope>(Object.entries(TOOLS).flatMap(([scope, tools]) => tools.map((t) => [t, scope as TokenScope] as const)));

/** The scope a tool needs, or undefined for a tool no token may call. */
export const scopeForTool = (tool: string): TokenScope | undefined => TOOL_SCOPE.get(tool);

/** null when allowed, otherwise the reason to give the agent. */
export function toolRefusal(tool: string, scopes: readonly string[]): string | null {
  const need = scopeForTool(tool);
  if (!need) return `${tool} is not available to API tokens.`;
  if (!scopes.includes(need)) return `This token does not have the "${need}" scope, which ${tool} needs. Ask the person who made it for a token with that scope.`;
  return null;
}
