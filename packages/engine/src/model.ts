/**
 * Rangoli core model — implementation-neutral, Figma-shaped, CSS-renderable.
 * See docs/SPEC.md §4.
 */

export type NodeType = 'frame' | 'text' | 'vector' | 'image' | 'instance' | 'group';

/** Reference to a design token by its dotted path, e.g. "color.text.secondary". */
export interface TokenRef {
  token: string;
}

/** A length: raw px number or a token reference. */
export type Len = number | TokenRef;

export type Dim = { kind: 'fixed'; v: Len } | { kind: 'hug' } | { kind: 'fill' };

export type LayoutMode = 'none' | 'row' | 'col' | 'grid';
export type Justify = 'start' | 'center' | 'end' | 'between' | 'around';
export type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';

/** Padding: [top, right, bottom, left]. */
export type Padding = [Len, Len, Len, Len];

export interface Layout {
  mode: LayoutMode;
  gap?: Len;
  padding?: Padding;
  justify?: Justify;
  align?: Align;
  wrap?: boolean;
  /** grid: column count or CSS template */
  columns?: number | string;
  rows?: string;
}

export interface Sizing {
  w?: Dim;
  h?: Dim;
  minW?: Len;
  maxW?: Len;
  minH?: Len;
  maxH?: Len;
}

export interface Position {
  x: number;
  y: number;
}

export type Paint = TokenRef | { hex: string } | { gradient: { type: 'linear' | 'radial'; angle?: number; stops: { at: number; color: TokenRef | { hex: string } }[] } };

export interface Stroke {
  paint: Paint;
  width?: number;
  align?: 'inside' | 'center' | 'outside';
}

export interface Shadow {
  x: number;
  y: number;
  blur: number;
  spread?: number;
  color: Paint;
  inset?: boolean;
}

export interface Font {
  family: string;
  size: Len;
  weight: number;
  lineHeight: number | string;
  letterSpacing: number | string;
}

export interface Style {
  fill?: Paint[];
  stroke?: Stroke;
  radius?: Len | [Len, Len, Len, Len];
  shadow?: TokenRef | Shadow[];
  opacity?: number;
  blur?: number;
  blend?: string;
  clip?: boolean;
  /** Typography: reference to a textStyle token */
  textStyle?: TokenRef;
  color?: Paint;
  font?: Partial<Font>;
  textAlign?: 'left' | 'center' | 'right';
  truncate?: boolean;
  mono?: boolean;
}

export interface VectorData {
  /** viewBox width/height */
  vw: number;
  vh: number;
  /** SVG path data strings */
  paths: { d: string; fill?: Paint | 'none'; stroke?: Paint; strokeWidth?: number; cap?: 'round' | 'butt' | 'square'; join?: 'round' | 'miter' | 'bevel' }[];
}

export interface ImageRef {
  asset: string;
  fit?: 'cover' | 'contain' | 'fill';
  alt?: string;
}

export interface RNode {
  id: string;
  type: NodeType;
  name: string;
  role?: string;
  parent?: string;
  children?: string[];
  layout?: Layout;
  size?: Sizing;
  position?: Position;
  style?: Style;
  text?: string;
  vector?: VectorData;
  /** icon reference "set/name" (vector nodes) */
  icon?: string;
  image?: ImageRef;
  /** For instances: component id */
  component?: string;
  variant?: Record<string, string>;
  props?: Record<string, string | number | boolean>;
  hidden?: boolean;
  locked?: boolean;
  figmaId?: string;
}

export interface Page {
  id: string;
  name: string;
  /** top-level node ids */
  children: string[];
  nodes: Record<string, RNode>;
}

export interface ComponentDef {
  id: string;
  name: string;
  /** variant axes, e.g. { variant: ['primary','secondary'], size: ['sm','md'] } */
  axes: Record<string, string[]>;
  defaults: Record<string, string>;
  /** text prop name used for quoted label text in RDL (e.g. "label") */
  labelProp?: string;
  /** Base style per variant combination key "variant=primary,size=sm" (partial match allowed) */
  styles: { when: Record<string, string>; style: Style; layout?: Layout; size?: Sizing }[];
  /** semantic HTML tag hint for neutral rendering */
  tag?: string;
  /** role hint */
  role?: string;
}

export interface Manifest {
  format: 'rangoli@1';
  name: string;
  pages: { id: string; name: string }[];
  activeAdapter?: string;
}

export interface DocumentData {
  manifest: Manifest;
  tokens: TokenTree;
  pages: Record<string, Page>;
  components: Record<string, ComponentDef>;
  /** motion definitions keyed by target ("@Button", "@Button[variant=primary]", "#n7") */
  motion?: Record<string, MotionDef>;
  /** clickable prototype: start screen + interactions per node */
  prototype?: PrototypeData;
  /** multi-step animations, keyed by name */
  timelines?: Record<string, Timeline>;
  /** icon sets (shape-language source), keyed by set name */
  icons?: Record<string, IconSet>;
}

import type { IconSet } from './icons.js';
import type { MotionDef } from './motion.js';
import type { PrototypeData, Timeline } from './prototype.js';

/** W3C DTCG-style token tree. Leaf: { $value, $type?, $description? } */
export interface TokenLeaf {
  $value: unknown;
  $type?: string;
  $description?: string;
  $extensions?: { rangoli?: { modes?: Record<string, unknown> } };
}
export interface TokenTree {
  [key: string]: TokenTree | TokenLeaf;
}

export function isTokenRef(v: unknown): v is TokenRef {
  return typeof v === 'object' && v !== null && 'token' in v && typeof (v as TokenRef).token === 'string';
}

export function isTokenLeaf(v: unknown): v is TokenLeaf {
  return typeof v === 'object' && v !== null && '$value' in v;
}
