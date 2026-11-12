/**
 * Content hashing for snapshots and approvals (ARCHITECTURE §3, §4).
 *
 * SHA-256 over canonical JSON. A node hash covers its own fields and its ordered child hashes. A
 * screen hash covers the root node hash plus the sorted closure of everything the screen renders
 * from: resolved token values, component definitions, assets, icons, motion and interactions.
 * Token edits therefore change exactly the screens that use the token, including through aliases
 * and components.
 *
 * Everything here is synchronous and free of Node or DOM APIs beyond TextEncoder, so it runs the
 * same on the server, in a worker and in the browser. Pass a `hasher` to use a faster native one.
 */
import { RangoliError } from './document.js';
import { compileIcon, findIcon } from './icons.js';
import { COMPONENT_CSS } from './library.js';
import { isTokenRef, type ComponentDef, type DocumentData, type Page, type RNode, type TokenTree } from './model.js';
import { parseTargetKey, type MotionSpec } from './motion.js';
import { cssVarName, TokenResolver } from './tokens.js';

export const CANON_VERSION = 'rangoli-canon@1';

export type Hasher = (text: string) => string;

// ---------------------------------------------------------------- SHA-256

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/** SHA-256 of the UTF-8 bytes of `text`, as lowercase hex. */
export function sha256Hex(text: string): string {
  const message = new TextEncoder().encode(text);
  const paddedLength = ((message.length + 9 + 63) >> 6) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(message.length / 0x20000000));
  view.setUint32(paddedLength - 4, (message.length << 3) >>> 0);

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let t = 0; t < 16; t++) w[t] = view.getUint32(offset + t * 4);
    for (let t = 16; t < 64; t++) {
      const a = w[t - 15]!;
      const b = w[t - 2]!;
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [number, number, number, number, number, number, number, number];
    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[t]! + w[t]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0]! += a;
    h[1]! += b;
    h[2]! += c;
    h[3]! += d;
    h[4]! += e;
    h[5]! += f;
    h[6]! += g;
    h[7]! += hh;
  }
  return Array.from(h, (v) => v.toString(16).padStart(8, '0')).join('');
}

// ---------------------------------------------------------------- canonical JSON

/** Design values do not carry meaning past six decimals, and float residue must not move a hash. */
function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) throw new TypeError(`Cannot hash the number ${n}`);
  const rounded = Math.abs(n) < 1e9 ? Math.round(n * 1e6) / 1e6 : n;
  return rounded === 0 ? '0' : JSON.stringify(rounded);
}

function canonicalValue(value: unknown, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
      return canonicalNumber(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object':
      break;
    default:
      throw new TypeError(`Cannot hash a value of type ${typeof value}`);
  }
  if (value === null) return 'null';
  if (ancestors.has(value)) throw new TypeError('Cannot hash a value that contains itself');
  ancestors.add(value);
  let out: string;
  if (Array.isArray(value)) {
    out = `[${Array.from(value, (item) => (item === undefined ? 'null' : canonicalValue(item, ancestors))).join(',')}]`;
  } else {
    const proto = Object.getPrototypeOf(value) as object | null;
    if (proto !== Object.prototype && proto !== null) throw new TypeError('Only plain objects and arrays can be hashed');
    const record = value as Record<string, unknown>;
    const parts: string[] = [];
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) parts.push(`${JSON.stringify(key)}:${canonicalValue(record[key], ancestors)}`);
    }
    out = `{${parts.join(',')}}`;
  }
  ancestors.delete(value);
  return out;
}

/** Canonical JSON: sorted keys, normalized numbers, undefined fields dropped. */
export function canonicalize(value: unknown): string {
  return canonicalValue(value, new Set());
}

/** Hash a value under a domain, so that equal content of different kinds never shares a hash. */
export function hashCanonical(domain: string, value: unknown, hasher: Hasher = sha256Hex): string {
  return hasher(`${CANON_VERSION}\n${domain}\n${canonicalize(value)}`);
}

// ---------------------------------------------------------------- screens and dependencies

export interface ScreenRef {
  /** stable id for this screen; defaults to "<page>/<root>" */
  id: string;
  page: string;
  /** top frame of the screen */
  root: string;
  device?: string;
}

/** Every top-level layer on every page, in manifest order. */
export function listScreens(data: DocumentData): ScreenRef[] {
  const out: ScreenRef[] = [];
  for (const { id: page } of data.manifest.pages) {
    for (const root of data.pages[page]?.children ?? []) out.push({ id: `${page}/${root}`, page, root });
  }
  return out;
}

export interface ScreenDeps {
  nodes: string[];
  tokens: string[];
  components: string[];
  assets: string[];
  icons: string[];
  motion: string[];
  interactions: string[];
  timelines: string[];
  variables: string[];
}

/** The page shell paints with these, so every screen renders from them. See render.ts. */
export const BASE_TOKENS: readonly string[] = ['color.bg.canvas', 'color.text.primary', 'textStyle.body'];

const CSS_VAR = /var\(\s*(--[A-Za-z0-9_-]+)/g;
const has = <T>(record: Record<string, T> | undefined, key: string): boolean => record !== undefined && Object.hasOwn(record, key);
const own = <T>(record: Record<string, T> | undefined, key: string): T | undefined => (has(record, key) ? record![key] : undefined);

type DepSets = { [K in keyof ScreenDeps]: Set<string> };

/** Returns a function that finds what one screen depends on. Shares its token index across calls. */
export function screenDepsScanner(data: DocumentData): (screen: ScreenRef) => ScreenDeps {
  const resolver = new TokenResolver(data.tokens);
  const tokenByVar = new Map<string, string>();
  for (const path of resolver.flat.keys()) tokenByVar.set(cssVarName(path), path);

  const iconColors = new Map<string, string[]>();
  const colorsOfIcon = (ref: string): string[] => {
    let colors = iconColors.get(ref);
    if (!colors) {
      colors = [];
      const found = findIcon(data.icons, ref);
      if (found) {
        try {
          for (const shape of compileIcon(found.icon.src).shapes) if (shape.color) colors.push(shape.color);
        } catch {
          // An icon that does not compile has no colours to depend on; its source is still hashed.
        }
      }
      iconColors.set(ref, colors);
    }
    return colors;
  };

  return (screen) => {
    const page = own(data.pages, screen.page);
    if (!page) throw new RangoliError('PAGE_NOT_FOUND', `Page ${screen.page} not found`);
    if (!has(page.nodes, screen.root)) throw new RangoliError('NODE_NOT_FOUND', `Node #${screen.root} not found`);

    const deps: DepSets = {
      nodes: new Set(),
      tokens: new Set(BASE_TOKENS),
      components: new Set(),
      assets: new Set(),
      icons: new Set(),
      motion: new Set(),
      interactions: new Set(),
      timelines: new Set(),
      variables: new Set(),
    };

    const addColor = (name: string) => {
      if (name.startsWith('#') || name === 'transparent') return;
      const path = resolver.find(name, 'color');
      if (path) deps.tokens.add(path);
    };
    const addIfToken = (path: string) => {
      if (resolver.has(path)) deps.tokens.add(path);
    };
    const addCssVars = (css: string) => {
      for (const match of css.matchAll(CSS_VAR)) {
        const path = tokenByVar.get(match[1]!);
        if (path) deps.tokens.add(path);
      }
    };
    const addIcon = (ref: string) => {
      if (deps.icons.has(ref)) return;
      deps.icons.add(ref);
      colorsOfIcon(ref).forEach(addColor);
    };

    const scanValue = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(scanValue);
      } else if (typeof value === 'object' && value !== null) {
        if (isTokenRef(value)) deps.tokens.add(value.token);
        for (const [key, inner] of Object.entries(value)) {
          if (key === 'asset' && typeof inner === 'string') deps.assets.add(inner);
          else if (key === 'css' && typeof inner === 'string') addCssVars(inner);
          else scanValue(inner);
        }
      }
    };

    const addComponent = (id: string) => {
      if (deps.components.has(id)) return;
      deps.components.add(id);
      const def = own(data.components, id);
      if (!def) return;
      scanValue(def.styles);
      const css = own(COMPONENT_CSS, id);
      if (css) addCssVars(css);
      if (def.template) Object.values(def.template.nodes).forEach(scanNode);
    };

    const scanNode = (node: RNode): void => {
      scanValue(node);
      for (const path of node.vector?.paths ?? []) if (typeof path.color === 'string') addColor(path.color);
      if (node.icon) addIcon(node.icon);
      if (node.component) addComponent(node.component);
      const slots = node.component ? own(data.components, node.component)?.slots : undefined;
      for (const [prop, value] of Object.entries(node.props ?? {})) {
        if (typeof value !== 'string' || !value || value === 'none') continue;
        const slot = own(slots, prop);
        if (slot?.kind === 'icon' || /icon/i.test(prop)) addIcon(value);
        else if (slot?.kind === 'image' || has(data.assets, value)) deps.assets.add(value);
      }
    };

    const walk = (id: string): void => {
      if (deps.nodes.has(id)) return;
      const node = own(page.nodes, id);
      if (!node) return;
      deps.nodes.add(id);
      scanNode(node);
      node.children?.forEach(walk);
    };
    walk(screen.root);

    const addTiming = (duration: string, easing: string) => {
      if (!/^\d+ms$/.test(duration)) addIfToken(`motion.duration.${duration}`);
      addIfToken(easing.startsWith('spring:') ? `motion.spring.${easing.slice(7)}` : `motion.easing.${easing}`);
    };
    const addTrackValue = (prop: string, raw: string | undefined) => {
      if (prop === 'ring') addIfToken('color.border.focus');
      if (raw === undefined) return;
      const value = raw.replace(/^-/, '');
      if (/^\d+(\.\d+)?$/.test(value)) return;
      if (prop === 'scale') addIfToken(`motion.scale.${value}`);
      else if (prop === 'x' || prop === 'y' || prop === 'blur') addIfToken(`motion.distance.${value}`);
      else if (prop === 'fill' || prop === 'color' || prop === 'stroke') addColor(value);
      else if (prop === 'shadow' && value !== 'none') {
        const path = resolver.find(value, 'shadow');
        if (path) deps.tokens.add(path);
      }
    };
    const addSpec = (spec: MotionSpec) => {
      addTiming(spec.duration, spec.easing);
      for (const track of spec.tracks) {
        addTrackValue(track.prop, track.from);
        addTrackValue(track.prop, track.to);
      }
    };

    for (const [key, def] of Object.entries(data.motion ?? {})) {
      const { base } = parseTargetKey(key);
      const applies = base.startsWith('#') ? deps.nodes.has(base.slice(1)) : deps.components.has(base.replace(/^@/, ''));
      if (!applies) continue;
      deps.motion.add(key);
      def.specs.forEach(addSpec);
    }

    const proto = data.prototype;
    if (proto) {
      for (const id of deps.nodes) {
        const list = own(proto.interactions, id);
        if (!list) continue;
        deps.interactions.add(id);
        for (const item of list) {
          if (item.transition) addTiming(item.transition.duration, item.transition.easing);
          if (item.timeline) deps.timelines.add(item.timeline);
          if (item.variable) deps.variables.add(item.variable);
          if (item.action === 'set') for (const name of Object.keys(item.variant ?? {})) deps.variables.add(name);
          for (const condition of item.when ?? []) deps.variables.add(condition.name);
        }
      }
    }
    for (const name of deps.timelines) own(data.timelines, name)?.tracks.forEach((track) => addSpec(track.spec));

    return {
      nodes: [...deps.nodes].sort(),
      tokens: [...deps.tokens].sort(),
      components: [...deps.components].sort(),
      assets: [...deps.assets].sort(),
      icons: [...deps.icons].sort(),
      motion: [...deps.motion].sort(),
      interactions: [...deps.interactions].sort(),
      timelines: [...deps.timelines].sort(),
      variables: [...deps.variables].sort(),
    };
  };
}

// ---------------------------------------------------------------- hashing

export interface HashOptions {
  hasher?: Hasher;
  /** full SHA-256 of each asset's bytes, by asset id */
  assetHashes?: Record<string, string>;
  /** the screens to hash (from `screen_frames`); defaults to every top-level layer */
  screens?: ScreenRef[];
}

/** Hash of each dependency, by name. Stored as `snapshot_screens.deps`. */
export type ScreenDepHashes = { [K in Exclude<keyof ScreenDeps, 'nodes'>]: Record<string, string> };

export interface ScreenHash extends ScreenRef {
  hash: string;
  rootHash: string;
  deps: ScreenDepHashes;
}

export interface SnapshotHashes {
  canonVersion: typeof CANON_VERSION;
  contentHash: string;
  libraryHash: string;
  screens: ScreenHash[];
}

/**
 * Merkle hashes of a subtree, by node id. `parent` is excluded so a moved subtree keeps its hash;
 * `locked` and `figmaId` are excluded because they never change what is drawn.
 */
export function hashNodes(page: Page, root: string, hasher: Hasher = sha256Hex): Map<string, string> {
  const hashes = new Map<string, string>();
  const open = new Set<string>();
  const visit = (id: string): string => {
    const known = hashes.get(id);
    if (known) return known;
    const node = own(page.nodes, id);
    if (!node) return hashCanonical('node-missing', id, hasher);
    if (open.has(id)) return hashCanonical('node-cycle', id, hasher);
    open.add(id);
    const { parent: _parent, children, locked: _locked, figmaId: _figmaId, ...fields } = node;
    const hash = hashCanonical('node', { fields, children: (children ?? []).map(visit) }, hasher);
    open.delete(id);
    hashes.set(id, hash);
    return hash;
  };
  visit(root);
  return hashes;
}

const ALIAS = /^\{([^}]+)\}$/;

/** The modes a token's value can vary in: those on it, or on anything it aliases. */
function modesInChain(resolver: TokenResolver, path: string, out: Set<string>, seen: Set<string>): void {
  if (seen.has(path)) return;
  seen.add(path);
  const token = resolver.flat.get(path);
  if (!token) return;
  const visitValue = (value: unknown): void => {
    if (typeof value === 'string') {
      const alias = ALIAS.exec(value);
      if (alias) modesInChain(resolver, alias[1]!, out, seen);
    } else if (Array.isArray(value)) {
      value.forEach(visitValue);
    } else if (typeof value === 'object' && value !== null) {
      Object.values(value).forEach(visitValue);
    }
  };
  visitValue(token.value);
  for (const [mode, value] of Object.entries(token.modes ?? {})) {
    out.add(mode);
    visitValue(value);
  }
}

function resolvedToken(resolver: TokenResolver, path: string): unknown {
  const token = resolver.flat.get(path);
  if (!token) return { missing: true };
  const modes = new Set<string>();
  modesInChain(resolver, path, modes, new Set());
  for (const [theme, { base }] of Object.entries(resolver.themes)) if (modes.has(base)) modes.add(theme);
  try {
    const byMode: Record<string, unknown> = {};
    for (const mode of [...modes].sort()) byMode[mode] = resolver.resolve(path, mode) ?? null;
    return { type: token.type ?? null, value: resolver.resolve(path) ?? null, modes: byMode };
  } catch {
    return { type: token.type ?? null, unresolved: token.value ?? null };
  }
}

function withoutLabel<T extends object>(value: T, label: keyof T): Omit<T, typeof label> {
  const { [label]: _dropped, ...rest } = value;
  return rest;
}

class SnapshotHasher {
  readonly resolver: TokenResolver;
  readonly hasher: Hasher;
  readonly deps: (screen: ScreenRef) => ScreenDeps;
  private readonly memo = new Map<string, string>();

  constructor(readonly data: DocumentData, private readonly options: HashOptions) {
    this.resolver = new TokenResolver(data.tokens);
    this.hasher = options.hasher ?? sha256Hex;
    this.deps = screenDepsScanner(data);
  }

  private once(domain: string, name: string, value: () => unknown): string {
    const key = `${domain}\0${name}`;
    let hash = this.memo.get(key);
    if (!hash) {
      hash = hashCanonical(domain, { name, value: value() ?? null }, this.hasher);
      this.memo.set(key, hash);
    }
    return hash;
  }

  private componentContent(def: ComponentDef | undefined): unknown {
    return def ? withoutLabel(def, 'description') : { missing: true };
  }

  private depHashes(deps: ScreenDeps): ScreenDepHashes {
    const { data } = this;
    const each = (names: string[], fn: (name: string) => string) => Object.fromEntries(names.map((name) => [name, fn(name)]));
    return {
      tokens: each(deps.tokens, (path) => this.once('token', path, () => resolvedToken(this.resolver, path))),
      components: each(deps.components, (id) => this.once('component', id, () => this.componentContent(own(data.components, id)))),
      assets: each(deps.assets, (id) =>
        this.once('asset', id, () => {
          const meta = own(data.assets, id);
          return meta ? { ...withoutLabel(meta, 'name'), sha256: own(this.options.assetHashes, id) ?? null } : { missing: true };
        }),
      ),
      icons: each(deps.icons, (ref) =>
        this.once('icon', ref, () => {
          const found = findIcon(data.icons, ref);
          if (!found) return { missing: true };
          const { grid, stroke, cap, join } = found.set;
          return { grid, stroke, cap, join, src: found.icon.src, iconStroke: found.icon.stroke ?? null };
        }),
      ),
      motion: each(deps.motion, (key) => this.once('motion', key, () => own(data.motion, key))),
      interactions: each(deps.interactions, (id) => this.once('interactions', id, () => own(data.prototype?.interactions, id))),
      timelines: each(deps.timelines, (name) => this.once('timeline', name, () => own(data.timelines, name))),
      variables: each(deps.variables, (name) => this.once('variable', name, () => own(data.prototype?.variables, name))),
    };
  }

  screen(screen: ScreenRef): ScreenHash {
    const deps = this.deps(screen);
    const rootHash = hashNodes(this.data.pages[screen.page]!, screen.root, this.hasher).get(screen.root)!;
    const depHashes = this.depHashes(deps);
    const hash = hashCanonical('screen', { root: rootHash, deps: depHashes }, this.hasher);
    return { ...screen, hash, rootHash, deps: depHashes };
  }

  library(): string {
    const { data, hasher } = this;
    const each = <T>(domain: string, record: Record<string, T> | undefined, content: (value: T) => unknown = (value) => value) =>
      Object.fromEntries(Object.entries(record ?? {}).map(([key, value]) => [key, hashCanonical(domain, content(value), hasher)]));
    return hashCanonical(
      'library',
      {
        tokens: hashCanonical('tokens', data.tokens as TokenTree, hasher),
        components: each('component', data.components),
        icons: each('icon-set', data.icons),
        motion: each('motion', data.motion),
      },
      hasher,
    );
  }
}

export function hashScreen(data: DocumentData, screen: ScreenRef, options: HashOptions = {}): ScreenHash {
  return new SnapshotHasher(data, options).screen(screen);
}

/** The shared library state: every token, component, icon set and motion definition. */
export function hashLibrary(data: DocumentData, options: HashOptions = {}): string {
  return new SnapshotHasher(data, options).library();
}

export function hashSnapshot(data: DocumentData, options: HashOptions = {}): SnapshotHashes {
  const hasher = new SnapshotHasher(data, options);
  const screens = (options.screens ?? listScreens(data)).map((screen) => hasher.screen(screen));
  const libraryHash = hasher.library();
  const contentHash = hashCanonical(
    'content',
    {
      pages: data.manifest.pages,
      library: libraryHash,
      screens: screens.map(({ id, device, hash }) => ({ id, device: device ?? null, hash })),
    },
    hasher.hasher,
  );
  return { canonVersion: CANON_VERSION, contentHash, libraryHash, screens };
}
