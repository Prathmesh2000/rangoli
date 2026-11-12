import {
  TEXT_NODE_BOOL_FIELDS,
  TEXT_NODE_TOKEN_FIELDS,
  TEXT_SEGMENT_CORE_FIELDS,
  TEXT_SEGMENT_FIELDS,
  TEXT_SEGMENT_NUMBER_FIELDS,
  TEXT_SEGMENT_TOKEN_FIELDS,
  TEXT_STYLE_NUMBER_FIELDS,
  TEXT_STYLE_TOKEN_FIELDS,
} from '../fields.js';
import { LIMITS, SAFE_URL_PATTERN } from '../limits.js';
import type { ExportStyle, ExportText, ExportTextSegment } from '../schema.js';
import {
  ExtractContext,
  describe,
  isFiniteNumber,
  isId,
  isRecord,
  isToken,
  pick,
} from './context.js';
import { mapBoundVariables, mapColor, mapPaints } from './paint.js';

type Segment = Record<string, unknown> & { start?: unknown; end?: unknown };
type SegmentReader = (fields: readonly string[]) => Segment[];

export function isTextNode(node: Record<string, unknown>): boolean {
  return typeof node['getStyledTextSegments'] === 'function';
}

function mapUnitValue(value: unknown): { unit: string; value?: number } | undefined {
  if (!isRecord(value) || !isToken(value['unit'])) return undefined;
  return isFiniteNumber(value['value'])
    ? { unit: value['unit'], value: value['value'] }
    : { unit: value['unit'] };
}

function mapFontName(value: unknown): { family: string; style: string } | undefined {
  if (!isRecord(value)) return undefined;
  const { family, style } = value;
  if (typeof family !== 'string' || typeof style !== 'string') return undefined;
  return {
    family: family.slice(0, LIMITS.maxNameLength),
    style: style.slice(0, LIMITS.maxNameLength),
  };
}

function mapSegment(
  ctx: ExtractContext,
  segment: Segment,
  length: number,
  nodeId: string,
): ExportTextSegment | undefined {
  if (!isFiniteNumber(segment.start) || !isFiniteNumber(segment.end)) return undefined;
  const start = Math.max(0, Math.trunc(segment.start));
  const end = Math.min(length, Math.trunc(segment.end));
  if (end <= start) return undefined;

  const out: Record<string, unknown> = { start, end };
  const ignoredMixed: string[] = [];
  pick(ctx, segment, out, TEXT_SEGMENT_NUMBER_FIELDS, 'number', ignoredMixed, nodeId);
  pick(ctx, segment, out, TEXT_SEGMENT_TOKEN_FIELDS, 'token', ignoredMixed, nodeId);

  const fontName = mapFontName(segment['fontName']);
  if (fontName) {
    out['fontName'] = fontName;
    ctx.noteFont(fontName.family, fontName.style);
  }
  for (const key of ['lineHeight', 'letterSpacing', 'textDecorationOffset', 'textDecorationThickness']) {
    const unitValue = mapUnitValue(segment[key]);
    if (unitValue) out[key] = unitValue;
  }

  const decorationColor = segment['textDecorationColor'];
  if (isRecord(decorationColor) && isRecord(decorationColor['value'])) {
    const paint = decorationColor['value'];
    const color = mapColor(ctx, paint['color'], nodeId);
    if (color) out['textDecorationColor'] = color;
  }
  if (typeof segment['textDecorationSkipInk'] === 'boolean') {
    out['textDecorationSkipInk'] = segment['textDecorationSkipInk'];
  }

  const fills = mapPaints(ctx, segment['fills'], nodeId);
  if (fills) out['fills'] = fills;

  for (const key of ['textStyleId', 'fillStyleId']) {
    const id = segment[key];
    if (isId(id)) {
      out[key] = id;
      ctx.styleIds.add(id);
    }
  }

  const list = segment['listOptions'];
  if (isRecord(list) && isToken(list['type'])) out['listType'] = list['type'];

  const hyperlink = mapHyperlink(ctx, segment['hyperlink'], nodeId);
  if (hyperlink) out['hyperlink'] = hyperlink;

  const features = segment['openTypeFeatures'];
  if (isRecord(features)) {
    const list: { tag: string; enabled: boolean }[] = [];
    for (const tag of Object.keys(features)) {
      const enabled = features[tag];
      if (isToken(tag) && typeof enabled === 'boolean') list.push({ tag, enabled });
    }
    if (list.length > 0) out['openTypeFeatures'] = list.slice(0, 256);
  }

  const overrides = segment['textStyleOverrides'];
  if (Array.isArray(overrides)) out['textStyleOverrides'] = overrides.filter(isToken).slice(0, 64);

  const bound = mapBoundVariables(ctx, segment['boundVariables']);
  if (bound) out['boundVariables'] = bound;

  return out as ExportTextSegment;
}

function mapHyperlink(
  ctx: ExtractContext,
  value: unknown,
  nodeId: string,
): { type: 'URL' | 'NODE'; value: string } | undefined {
  if (!isRecord(value) || typeof value['value'] !== 'string') return undefined;
  const type = value['type'];
  if (type === 'NODE') return { type, value: value['value'].slice(0, LIMITS.maxUrlLength) };
  if (type !== 'URL') return undefined;
  if (!SAFE_URL_PATTERN.test(value['value']) || value['value'].length > LIMITS.maxUrlLength) {
    ctx.gap('hyperlink-dropped', 'warning', 'A link with an unsafe scheme or length was left out.', {
      nodeId,
    });
    return undefined;
  }
  return { type, value: value['value'] };
}

function readSegments(ctx: ExtractContext, reader: SegmentReader, nodeId: string): Segment[] {
  try {
    return reader(TEXT_SEGMENT_FIELDS);
  } catch (error) {
    ctx.gap(
      'text-segment-fields-reduced',
      'warning',
      `Some text style fields were unavailable: ${describe(error)}`,
      { nodeId },
    );
  }
  try {
    return reader(TEXT_SEGMENT_CORE_FIELDS);
  } catch (error) {
    ctx.gap(
      'text-segments-unavailable',
      'error',
      `Mixed text styles could not be read: ${describe(error)}`,
      { nodeId },
    );
    return [];
  }
}

export function mapText(ctx: ExtractContext, node: Record<string, unknown>, nodeId: string): ExportText {
  const raw = ctx.read(node, 'characters', nodeId);
  let characters = typeof raw === 'string' ? raw : '';
  if (characters.length > LIMITS.maxTextCharacters) {
    ctx.gap(
      'text-truncated',
      'error',
      `Text cut from ${characters.length} to ${LIMITS.maxTextCharacters} characters.`,
      { nodeId },
    );
    characters = characters.slice(0, LIMITS.maxTextCharacters);
  }

  const reader = node['getStyledTextSegments'] as (f: readonly string[]) => Segment[];
  const segments = ctx
    .cap(
      readSegments(ctx, (fields) => reader.call(node, fields), nodeId),
      LIMITS.maxTextSegments,
      'text-segments-truncated',
      'Text style segments',
      nodeId,
    )
    .flatMap((segment) => {
      const mapped = mapSegment(ctx, segment, characters.length, nodeId);
      return mapped ? [mapped] : [];
    });

  const out: Record<string, unknown> = { characters, segments };
  const ignoredMixed: string[] = [];
  pick(ctx, node, out, TEXT_NODE_TOKEN_FIELDS, 'token', ignoredMixed, nodeId);
  pick(ctx, node, out, TEXT_NODE_BOOL_FIELDS, 'bool', ignoredMixed, nodeId);
  pick(ctx, node, out, ['leadingTrim'], 'token', ignoredMixed, nodeId);
  pick(ctx, node, out, ['maxLines'], 'number', ignoredMixed, nodeId);

  if (out['hasMissingFont'] === true) {
    const fonts = segments
      .map((segment) => (segment.fontName ? `${segment.fontName.family} ${segment.fontName.style}` : ''))
      .filter((label, index, all) => label !== '' && all.indexOf(label) === index)
      .slice(0, 8);
    ctx.gap('missing-font', 'warning', `Font not available in this file: ${fonts.join(', ') || 'unknown'}.`, {
      nodeId,
    });
  }

  return out as ExportText;
}

export function mapTextStyleProps(ctx: ExtractContext, style: Record<string, unknown>): ExportStyle['text'] {
  const out: Record<string, unknown> = {};
  const ignoredMixed: string[] = [];
  pick(ctx, style, out, TEXT_STYLE_NUMBER_FIELDS, 'number', ignoredMixed);
  pick(ctx, style, out, TEXT_STYLE_TOKEN_FIELDS, 'token', ignoredMixed);
  const fontName = mapFontName(ctx.read(style, 'fontName'));
  if (fontName) {
    out['fontName'] = fontName;
    ctx.noteFont(fontName.family, fontName.style);
  }
  for (const key of ['lineHeight', 'letterSpacing']) {
    const unitValue = mapUnitValue(ctx.read(style, key));
    if (unitValue) out[key] = unitValue;
  }
  return out as ExportStyle['text'];
}
