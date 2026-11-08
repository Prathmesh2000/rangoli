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
  for (const [id, def] of Object.entries(lib)) {
    const mine = saved?.[id];
    if (mine?.custom) continue;
    out[id] = mine ? withUserRules(def, mine) : def;
  }
  return out;
}

/** Newest library definition + the user's restyles/added variants from a component block. */
export function withUserRules(base: ComponentDef, mine: ComponentDef): ComponentDef {
  const rules = mine.styles.filter((r) => r.user);
  if (!rules.length) return base;
  const axes = structuredClone(base.axes);
  for (const [k, vals] of Object.entries(mine.axes)) for (const v of vals) if (!(axes[k] ??= []).includes(v)) axes[k]!.push(v);
  return { ...base, axes, styles: [...base.styles, ...structuredClone(rules)] };
}

/**
 * Expand a building-block instance into real layers: template copy (ids via idOf; the root keeps the
 * instance id) with slot props filled in and component rules + instance overrides on the root.
 */
export function expandTemplate(n: RNode, comp: ComponentDef, idOf: (tid: string) => string): { root: RNode; nodes: Record<string, RNode> } {
  const t = comp.template!;
  const id = (tid: string) => (tid === t.root ? n.id : idOf(tid));
  const nodes: Record<string, RNode> = {};
  for (const [tid, tn] of Object.entries(t.nodes)) {
    const c = structuredClone(tn);
    c.id = id(tid);
    if (c.parent) c.parent = id(c.parent);
    if (c.children) c.children = c.children.map(id);
    nodes[c.id] = c;
  }
  for (const [name, slot] of Object.entries(comp.slots ?? {})) {
    const v = n.props?.[name];
    const target = nodes[id(slot.node)];
    if (v === undefined || !target) continue;
    if (v === false || v === 'none') { target.hidden = true; continue; }
    if (slot.kind === 'text') target.text = String(v);
    else if (slot.kind === 'icon') target.icon = String(v);
    else if (slot.kind === 'image') target.image = { ...(target.image ?? { asset: '' }), asset: String(v) };
  }
  const root = nodes[n.id]!;
  const rules = resolveInstance({ ...n, layout: undefined, size: undefined, style: undefined }, comp);
  const merge = <T extends object>(...parts: (T | undefined)[]) => (parts.some(Boolean) ? (Object.assign({}, ...parts.filter(Boolean)) as T) : undefined);
  const layout = merge<Layout>(root.layout, rules.layout, n.layout);
  const size = merge<Sizing>(root.size, rules.size, n.size);
  const style = merge<Style>(root.style, rules.style, n.style);
  if (layout) root.layout = layout;
  if (size) root.size = size;
  if (style) root.style = style;
  root.name = n.name;
  if (n.parent) root.parent = n.parent;
  if (n.role) root.role = n.role;
  if (n.position) root.position = n.position;
  if (n.absolute) root.absolute = true;
  if (n.hidden) root.hidden = true;
  return { root, nodes };
}

/** Layer name → slot/prop name: "Plan title" → "plan-title" */
export const slotName = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layer';

/** Resolve the effective layout/size/style of an instance: component base → matching variant rules → node overrides. */
export function resolveInstance(node: RNode, comp: ComponentDef): { layout?: Layout; size?: Sizing; style: Style; variant: Record<string, string> } {
  const variant = { ...comp.defaults, ...(node.variant ?? {}) };
  let layout: Layout | undefined;
  let size: Sizing | undefined;
  let style: Style = {};
  for (const rule of comp.styles) {
    const matches = Object.entries(rule.when).every(([k, v]) => variant[k] === v);
    if (!matches) continue;
    if (rule.layout) layout = { ...(layout ?? { mode: rule.layout.mode ?? 'row' }), ...rule.layout } as Layout;
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
