import type { ComponentDef, RNode, Style, Layout, Sizing } from './model.js';
import { RangoliDocument } from './document.js';
import { defaultTokens, type DefaultTokenOptions } from './tokens.js';
import { defaultMotion } from './motion.js';
import { defaultIcons } from './icons.js';
import { libraryComponents } from './library.js';

/**
 * Implementation-neutral component library (see library.ts). Adapters map these to real code components.
 */
export function defaultComponents(): Record<string, ComponentDef> {
  return libraryComponents();
}

/**
 * Upgrade a document's components: built-in definitions follow the library unless the user marked
 * them custom; user-made components are kept.
 */
export function withLibrary(saved: Record<string, ComponentDef> | undefined): Record<string, ComponentDef> {
  const lib = libraryComponents();
  const out: Record<string, ComponentDef> = { ...(saved ?? {}) };
  for (const [id, def] of Object.entries(lib)) if (!saved?.[id]?.custom) out[id] = def;
  return out;
}

/** Resolve the effective layout/size/style of an instance: component base → matching variant rules → node overrides. */
export function resolveInstance(node: RNode, comp: ComponentDef): { layout?: Layout; size?: Sizing; style: Style; variant: Record<string, string> } {
  const variant = { ...comp.defaults, ...(node.variant ?? {}) };
  let layout: Layout | undefined;
  let size: Sizing | undefined;
  let style: Style = {};
  for (const rule of comp.styles) {
    const matches = Object.entries(rule.when).every(([k, v]) => variant[k] === v);
    if (!matches) continue;
    if (rule.layout) layout = { ...(layout ?? { mode: rule.layout.mode }), ...rule.layout };
    if (rule.size) size = { ...(size ?? {}), ...rule.size };
    style = { ...style, ...rule.style, font: { ...(style.font ?? {}), ...(rule.style.font ?? {}) } };
  }
  if (node.layout) layout = { ...(layout ?? { mode: node.layout.mode }), ...node.layout };
  if (node.size) size = { ...(size ?? {}), ...node.size };
  if (node.style) style = { ...style, ...node.style };
  return { layout, size, style, variant };
}

/** New document with default tokens and the full component library. */
export function createDocument(name = 'Untitled', tokenOpts: DefaultTokenOptions = {}): RangoliDocument {
  const doc = RangoliDocument.empty(name);
  doc.data.tokens = defaultTokens(tokenOpts);
  doc.data.components = defaultComponents();
  doc.data.motion = defaultMotion();
  doc.data.icons = defaultIcons();
  return doc;
}
