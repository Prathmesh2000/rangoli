/**
 * The MCP tool allowlist (ARCHITECTURE §6 "Agent reaching human actions"). Every tool an agent may call is
 * listed here once, with the token scope it needs and what it does. A tool that is not listed is refused on
 * every shared deployment, so a new tool stays off until someone decides where it belongs. This replaces the
 * HOST_DISK_TOOLS and DESIGN_WRITE_TOOLS denylists.
 */
import type { TokenScope } from '@rangoli/engine';

export type ToolEffect =
  /** reads the design or the project */
  | 'read'
  /** changes the design: gated by design.edit, the write rules and a named run */
  | 'write'
  /** leaves something for a person to accept: comments, suggestions, review pins */
  | 'propose'
  /** the agent queue: waiting, claiming and finishing notes and tasks */
  | 'queue'
  /** opens, closes and reports named runs */
  | 'run'
  /** reads or writes files on the machine running Rangoli: off wherever that machine is not the caller's */
  | 'host';

export interface ToolPolicy {
  scope: TokenScope;
  effect: ToolEffect;
}

const t = (scope: TokenScope, effect: ToolEffect): ToolPolicy => ({ scope, effect });

export const AGENT_TOOLS: Readonly<Record<string, ToolPolicy>> = Object.freeze({
  // reading
  rdl_help: t('read', 'read'),
  doc_info: t('read', 'read'),
  doc_outline: t('read', 'read'),
  node_get: t('read', 'read'),
  search_nodes: t('read', 'read'),
  rdl_check: t('read', 'read'),
  history: t('read', 'read'),
  lint: t('read', 'read'),
  tokens_get: t('read', 'read'),
  palette_generate: t('read', 'read'),
  contrast_check: t('read', 'read'),
  motion_get: t('read', 'read'),
  motion_curve: t('read', 'read'),
  motion_presets: t('read', 'read'),
  suggestions_list: t('read', 'read'),
  comments_list: t('read', 'read'),
  diff: t('read', 'read'),
  versions_list: t('read', 'read'),
  proto_get: t('read', 'read'),
  render_png: t('read', 'read'),
  motion_filmstrip: t('read', 'read'),
  icon_list: t('read', 'read'),
  icon_get: t('read', 'read'),
  icon_render: t('read', 'read'),
  components_list: t('read', 'read'),
  component_help: t('read', 'read'),
  patterns_list: t('read', 'read'),
  pattern_help: t('read', 'read'),
  asset_list: t('read', 'read'),
  image_templates: t('read', 'read'),
  selection_get: t('read', 'read'),
  journey_get: t('read', 'read'),
  my_permissions: t('read', 'read'),
  design_rules: t('read', 'read'),
  changes_since: t('read', 'read'),
  project_list: t('read', 'read'),
  project_open: t('read', 'read'),
  // runs
  run_start: t('read', 'run'),
  run_end: t('read', 'run'),
  run_status: t('read', 'run'),
  // proposing
  suggest: t('propose', 'propose'),
  comment: t('propose', 'propose'),
  review_add: t('propose', 'propose'),
  // drafting
  rdl_apply: t('draft', 'write'),
  undo: t('draft', 'write'),
  redo: t('draft', 'write'),
  tokens_set_brand: t('draft', 'write'),
  design_language: t('draft', 'write'),
  token_set: t('draft', 'write'),
  motion_preset: t('draft', 'write'),
  version_save: t('draft', 'write'),
  image_edit: t('draft', 'write'),
  image_template: t('draft', 'write'),
  image_placeholder: t('draft', 'write'),
  annotate: t('draft', 'write'),
  wireframe_start: t('draft', 'write'),
  page_create: t('draft', 'write'),
  screen_frames_set: t('draft', 'write'),
  // the queue
  agent_wait: t('jobs', 'queue'),
  job_claim: t('jobs', 'queue'),
  job_finish: t('jobs', 'queue'),
  // the server's own disk
  render_preview: t('read', 'host'),
  asset_upload: t('draft', 'host'),
  export: t('export', 'host'),
  prototype_export: t('export', 'host'),
  icon_export: t('export', 'host'),
  image_export: t('export', 'host'),
});

export const toolPolicy = (tool: string): ToolPolicy | undefined => (Object.hasOwn(AGENT_TOOLS, tool) ? AGENT_TOOLS[tool] : undefined);

/** Why a tool is refused before it runs on a shared server, or null when it may run. */
export function allowlistRefusal(tool: string, scopes: readonly string[]): string | null {
  const policy = toolPolicy(tool);
  if (!policy) return `${tool} is not available to agents.`;
  if (policy.effect === 'host') return `${tool} reads or writes files on the server, so it is off in hosted projects. Use the app's downloads and uploads.`;
  if (!scopes.includes(policy.scope)) return `This token does not have the "${policy.scope}" scope, which ${tool} needs. Ask the person who made it for a token with that scope.`;
  return null;
}
