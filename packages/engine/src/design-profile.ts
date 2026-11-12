/**
 * The design profile (PRD §12): what a project actually uses, computed from a snapshot with no AI.
 * The same document always gives the same profile, in the same order. Layer names and token paths
 * come from the design, so anything showing them to an agent must mark them as untrusted.
 */
import { findIcon } from './icons.js';
import { isTokenRef, type DocumentData, type Dim, type Layout, type Len, type Page, type RNode, type Style } from './model.js';
import { listScreens, screenDepsScanner, type ScreenRef } from './snapshot-hash.js';
import { TokenResolver } from './tokens.js';

export const DESIGN_PROFILE_VERSION = 'design-profile@1';

const TOP_LAYOUTS = 25;

export interface TokenUse {
  path: string;
  type?: string;
  /** references written directly on layers */
  directUses: number;
  /** screens that render from this token, directly or through a component */
  screens: string[];
}

export interface ComponentUse {
  id: string;
  name: string;
  instances: number;
  screens: string[];
  /** axis, then value, then number of instances */
  variants: Record<string, Record<string, number>>;
}

export interface CountedLabel {
  label: string;
  count: number;
}

export interface LayoutProfile {
  modes: Record<string, number>;
  /** most common auto-layout setups */
  patterns: CountedLabel[];
  screenSizes: CountedLabel[];
}

export interface ScreenProfile {
  id: string;
  page: string;
  root: string;
  device?: string;
  name: string;
  size: string;
  layers: number;
  instances: number;
  components: string[];
}

export type NamingStyle = 'Title Case' | 'Sentence case' | 'lower case' | 'kebab-case' | 'snake_case' | 'camelCase' | 'default' | 'other';

export interface NamingProfile {
  screens: Partial<Record<NamingStyle, number>>;
  layers: Partial<Record<NamingStyle, number>>;
  /** most common style among named layers, or undefined when everything has a default name */
  dominant?: NamingStyle;
  /** layers still called "Frame 12", "Group", "Rectangle 3" */
  defaultNamedLayers: number;
}

export type ExceptionKind =
  | 'raw-color'
  | 'raw-spacing'
  | 'raw-radius'
  | 'raw-font-size'
  | 'css-override'
  | 'missing-token'
  | 'missing-component'
  | 'missing-icon'
  | 'missing-asset'
  | 'unknown-variant';

export interface ProfileException {
  kind: ExceptionKind;
  screen: string;
  node: string;
  detail: string;
}

export interface DesignProfile {
  version: typeof DESIGN_PROFILE_VERSION;
  summary: {
    screens: number;
    layers: number;
    instances: number;
    tokensUsed: number;
    componentsUsed: number;
    exceptions: Partial<Record<ExceptionKind, number>>;
  };
  tokens: TokenUse[];
  components: ComponentUse[];
  layouts: LayoutProfile;
  screens: ScreenProfile[];
  naming: NamingProfile;
  exceptions: ProfileException[];
}

const DEFAULT_NAME = /^(frame|group|rectangle|ellipse|line|vector|text|image|instance|component|layer|polygon|star|section)( \d+)?$/i;

export function namingStyle(name: string): NamingStyle {
  const trimmed = name.trim();
  if (DEFAULT_NAME.test(trimmed)) return 'default';
  if (/^[a-z0-9]+(-[a-z0-9]+)+$/.test(trimmed)) return 'kebab-case';
  if (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(trimmed)) return 'snake_case';
  if (/^[a-z]+[a-z0-9]*[A-Z][A-Za-z0-9]*$/.test(trimmed)) return 'camelCase';
  const words = trimmed.split(/\s+/).filter((word) => /[A-Za-z]/.test(word));
  if (!words.length) return 'other';
  if (words.every((word) => /^[A-Z]/.test(word))) return 'Title Case';
  if (/^[A-Z]/.test(words[0]!) && words.slice(1).every((word) => /^[a-z]/.test(word))) return 'Sentence case';
  if (words.every((word) => /^[a-z]/.test(word))) return 'lower case';
  return 'other';
}

const byPlace = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function bump<K>(counts: Map<K, number>, key: K, by = 1): void {
  counts.set(key, (counts.get(key) ?? 0) + by);
}

function sortedRecord<V>(entries: Iterable<[string, V]>): Record<string, V> {
  return Object.fromEntries([...entries].sort(([a], [b]) => byPlace(a, b)));
}

function topLabels(counts: Map<string, number>, limit = Infinity): CountedLabel[] {
  return [...counts]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || byPlace(a.label, b.label))
    .slice(0, limit);
}

const lenLabel = (len: Len | undefined): string | undefined => (len === undefined ? undefined : typeof len === 'number' ? String(len) : len.token);

function layoutPattern(layout: Layout): string {
  const padding = layout.padding?.map(lenLabel).join(' ');
  return [
    layout.mode,
    layout.gap !== undefined && `gap ${lenLabel(layout.gap)}`,
    padding && `padding ${padding}`,
    layout.justify && `justify ${layout.justify}`,
    layout.align && `align ${layout.align}`,
    layout.wrap && 'wrap',
    layout.columns !== undefined && `columns ${layout.columns}`,
  ]
    .filter(Boolean)
    .join(', ');
}

function dimLabel(dim: Dim | undefined): string {
  if (!dim) return 'auto';
  return dim.kind === 'fixed' ? String(lenLabel(dim.v)) : dim.kind;
}

/** Number of TokenRefs anywhere in a value, by path. */
function countTokenRefs(value: unknown, counts: Map<string, number>): void {
  if (Array.isArray(value)) {
    for (const item of value) countTokenRefs(item, counts);
  } else if (typeof value === 'object' && value !== null) {
    if (isTokenRef(value)) bump(counts, value.token);
    for (const inner of Object.values(value)) countTokenRefs(inner, counts);
  }
}

function hexPaths(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item) => hexPaths(item, path, out));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'hex' && typeof inner === 'string') out.push(`${path} ${inner}`);
      else hexPaths(inner, path === '' ? key : path, out);
    }
  }
}

const isRawLength = (len: Len | undefined): len is number => typeof len === 'number' && len !== 0;

function assetIdsOf(style: Style | undefined): string[] {
  const out: string[] = [];
  for (const paint of style?.fill ?? []) if ('image' in paint && paint.image.asset) out.push(paint.image.asset);
  return out;
}

function nodeExceptions(node: RNode, data: DocumentData, resolver: TokenResolver, add: (kind: ExceptionKind, detail: string) => void): void {
  const style = node.style;
  if (style) {
    const hex: string[] = [];
    hexPaths({ fill: style.fill, stroke: style.stroke?.paint, color: style.color, shadow: style.shadow }, '', hex);
    for (const detail of hex) add('raw-color', detail);
    const radii = Array.isArray(style.radius) ? style.radius : [style.radius];
    for (const radius of radii) if (isRawLength(radius)) add('raw-radius', `radius ${radius}`);
    if (isRawLength(style.font?.size)) add('raw-font-size', `size ${style.font.size}`);
    if (style.css) add('css-override', style.css);
  }

  const layout = node.layout;
  if (isRawLength(layout?.gap)) add('raw-spacing', `gap ${layout.gap}`);
  for (const side of layout?.padding ?? []) if (isRawLength(side)) add('raw-spacing', `padding ${side}`);

  const refs = new Map<string, number>();
  countTokenRefs(node, refs);
  for (const path of refs.keys()) if (!resolver.has(path)) add('missing-token', path);

  if (node.icon && !findIcon(data.icons, node.icon)) add('missing-icon', node.icon);
  const assets = [...assetIdsOf(style), ...(node.image?.asset ? [node.image.asset] : [])];
  for (const asset of assets) if (!data.assets || !Object.hasOwn(data.assets, asset)) add('missing-asset', asset);

  if (node.component) {
    if (!Object.hasOwn(data.components, node.component)) {
      add('missing-component', node.component);
    } else {
      const axes = data.components[node.component]!.axes;
      for (const [axis, value] of Object.entries(node.variant ?? {})) {
        if (!Object.hasOwn(axes, axis) || !axes[axis]!.includes(value)) add('unknown-variant', `${axis}=${value}`);
      }
    }
  }
}

function subtree(page: Page, root: string): RNode[] {
  const out: RNode[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id) || !Object.hasOwn(page.nodes, id)) return;
    seen.add(id);
    const node = page.nodes[id]!;
    out.push(node);
    node.children?.forEach(visit);
  };
  visit(root);
  return out;
}

export function computeDesignProfile(data: DocumentData, options: { screens?: ScreenRef[] } = {}): DesignProfile {
  const resolver = new TokenResolver(data.tokens);
  const scan = screenDepsScanner(data);
  const screens = options.screens ?? listScreens(data);

  const tokenDirect = new Map<string, number>();
  const tokenScreens = new Map<string, Set<string>>();
  const componentCounts = new Map<string, number>();
  const componentScreens = new Map<string, Set<string>>();
  const variantCounts = new Map<string, Map<string, Map<string, number>>>();
  const modes = new Map<string, number>();
  const patterns = new Map<string, number>();
  const sizes = new Map<string, number>();
  const screenNames = new Map<NamingStyle, number>();
  const layerNames = new Map<NamingStyle, number>();
  const exceptions: ProfileException[] = [];
  const screenProfiles: ScreenProfile[] = [];
  let layers = 0;
  let instances = 0;

  const addTo = (index: Map<string, Set<string>>, key: string, screen: string) => {
    let set = index.get(key);
    if (!set) index.set(key, (set = new Set()));
    set.add(screen);
  };

  for (const screen of screens) {
    const page = Object.hasOwn(data.pages, screen.page) ? data.pages[screen.page] : undefined;
    if (!page || !Object.hasOwn(page.nodes, screen.root)) continue;
    const deps = scan(screen);
    const root = page.nodes[screen.root]!;
    const nodes = subtree(page, screen.root);

    for (const path of deps.tokens) if (resolver.has(path)) addTo(tokenScreens, path, screen.id);
    for (const id of deps.components) if (Object.hasOwn(data.components, id)) addTo(componentScreens, id, screen.id);

    let screenInstances = 0;
    for (const node of nodes) {
      countTokenRefs(node, tokenDirect);
      bump(modes, node.layout?.mode ?? 'none');
      if (node.layout && node.layout.mode !== 'none') bump(patterns, layoutPattern(node.layout));
      if (node !== root) bump(layerNames, namingStyle(node.name));
      if (node.component && Object.hasOwn(data.components, node.component)) {
        screenInstances++;
        bump(componentCounts, node.component);
        let axes = variantCounts.get(node.component);
        if (!axes) variantCounts.set(node.component, (axes = new Map()));
        for (const [axis, value] of Object.entries(node.variant ?? {})) {
          let values = axes.get(axis);
          if (!values) axes.set(axis, (values = new Map()));
          bump(values, value);
        }
      }
      nodeExceptions(node, data, resolver, (kind, detail) => exceptions.push({ kind, screen: screen.id, node: node.id, detail }));
    }

    const size = `${dimLabel(root.size?.w)} x ${dimLabel(root.size?.h)}`;
    bump(sizes, size);
    bump(screenNames, namingStyle(root.name));
    layers += nodes.length;
    instances += screenInstances;
    screenProfiles.push({
      id: screen.id,
      page: screen.page,
      root: screen.root,
      ...(screen.device ? { device: screen.device } : {}),
      name: root.name,
      size,
      layers: nodes.length,
      instances: screenInstances,
      components: deps.components.filter((id) => Object.hasOwn(data.components, id)),
    });
  }

  const tokens: TokenUse[] = [...tokenScreens]
    .map(([path, used]) => {
      const type = resolver.flat.get(path)?.type;
      return { path, ...(type ? { type } : {}), directUses: tokenDirect.get(path) ?? 0, screens: [...used].sort() };
    })
    .sort((a, b) => b.screens.length - a.screens.length || b.directUses - a.directUses || byPlace(a.path, b.path));

  const components: ComponentUse[] = [...componentScreens]
    .map(([id, used]) => ({
      id,
      name: data.components[id]!.name,
      instances: componentCounts.get(id) ?? 0,
      screens: [...used].sort(),
      variants: sortedRecord(
        [...(variantCounts.get(id) ?? new Map<string, Map<string, number>>())].map(([axis, values]): [string, Record<string, number>] => [axis, sortedRecord(values)]),
      ),
    }))
    .sort((a, b) => b.instances - a.instances || byPlace(a.id, b.id));

  exceptions.sort((a, b) => byPlace(a.screen, b.screen) || byPlace(a.node, b.node) || byPlace(a.kind, b.kind) || byPlace(a.detail, b.detail));
  const exceptionCounts = new Map<ExceptionKind, number>();
  for (const exception of exceptions) bump(exceptionCounts, exception.kind);

  const named = [...layerNames].filter(([style]) => style !== 'default').sort(([a, x], [b, y]) => y - x || byPlace(a, b));

  return {
    version: DESIGN_PROFILE_VERSION,
    summary: {
      screens: screenProfiles.length,
      layers,
      instances,
      tokensUsed: tokens.length,
      componentsUsed: components.length,
      exceptions: sortedRecord(exceptionCounts),
    },
    tokens,
    components,
    layouts: { modes: sortedRecord(modes), patterns: topLabels(patterns, TOP_LAYOUTS), screenSizes: topLabels(sizes) },
    screens: screenProfiles,
    naming: {
      screens: sortedRecord(screenNames),
      layers: sortedRecord(layerNames),
      ...(named[0] ? { dominant: named[0][0] } : {}),
      defaultNamedLayers: layerNames.get('default') ?? 0,
    },
    exceptions,
  };
}
