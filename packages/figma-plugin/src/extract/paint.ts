import {
  EFFECT_BOOL_FIELDS,
  EFFECT_COLOR_FIELDS,
  EFFECT_NUMBER_FIELDS,
  EFFECT_TOKEN_FIELDS,
  EFFECT_VECTOR_FIELDS,
  IMAGE_FILTER_FIELDS,
} from '../fields.js';
import { HASH_PATTERN, LIMITS } from '../limits.js';
import type {
  ExportBoundVariables,
  ExportColor,
  ExportEffect,
  ExportLayoutGrid,
  ExportPaint,
} from '../schema.js';
import { ExtractContext, isFiniteNumber, isId, isRecord, isToken, pick } from './context.js';

type Transform = [[number, number, number], [number, number, number]];
const GRADIENTS = new Set([
  'GRADIENT_LINEAR',
  'GRADIENT_RADIAL',
  'GRADIENT_ANGULAR',
  'GRADIENT_DIAMOND',
]);

export function mapColor(
  ctx: ExtractContext,
  value: unknown,
  nodeId: string | undefined,
): ExportColor | undefined {
  if (!isRecord(value)) return undefined;
  const { r, g, b, a } = value;
  if (!isFiniteNumber(r) || !isFiniteNumber(g) || !isFiniteNumber(b)) return undefined;
  if (value['sourceColor'] !== undefined) {
    ctx.gap(
      'color-space-approximated',
      'info',
      'Colour authored in another colour space was captured as sRGB.',
      { ...(nodeId !== undefined && { nodeId }) },
    );
  }
  return isFiniteNumber(a) ? { r, g, b, a } : { r, g, b };
}

export function mapTransform(value: unknown): Transform | undefined {
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const flat: unknown[] = value.flat();
  if (flat.length !== 6 || !flat.every(isFiniteNumber)) return undefined;
  const n = flat as number[];
  return [
    [n[0]!, n[1]!, n[2]!],
    [n[3]!, n[4]!, n[5]!],
  ];
}

export function mapVector(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value) || !isFiniteNumber(value['x']) || !isFiniteNumber(value['y'])) return undefined;
  return { x: value['x'], y: value['y'] };
}

function aliasId(ctx: ExtractContext, value: unknown): string | undefined {
  if (!isRecord(value) || value['type'] !== 'VARIABLE_ALIAS' || !isId(value['id'])) return undefined;
  ctx.variableIds.add(value['id']);
  return value['id'];
}

/** Flattens Figma's boundVariables shapes: alias, alias[] or { name: alias }. */
export function mapBoundVariables(
  ctx: ExtractContext,
  value: unknown,
): ExportBoundVariables | undefined {
  if (!isRecord(value)) return undefined;
  const out: ExportBoundVariables = [];
  for (const field of Object.keys(value)) {
    if (!isToken(field)) continue;
    const bound = value[field];
    const direct = aliasId(ctx, bound);
    if (direct !== undefined) {
      out.push({ field, ids: [direct] });
    } else if (Array.isArray(bound)) {
      const ids = bound
        .map((item) => aliasId(ctx, item))
        .filter((id): id is string => id !== undefined)
        .slice(0, LIMITS.maxPaints);
      if (ids.length > 0) out.push({ field, ids });
    } else if (isRecord(bound)) {
      for (const key of Object.keys(bound)) {
        const id = aliasId(ctx, bound[key]);
        if (id !== undefined) out.push({ field, key: key.slice(0, LIMITS.maxNameLength), ids: [id] });
      }
    }
    if (out.length >= LIMITS.maxBoundVariables) break;
  }
  return out.length > 0 ? out : undefined;
}

function paintBase(paint: Record<string, unknown>) {
  const base: { visible?: boolean; opacity?: number; blendMode?: string } = {};
  if (typeof paint['visible'] === 'boolean') base.visible = paint['visible'];
  if (isFiniteNumber(paint['opacity'])) base.opacity = paint['opacity'];
  if (isToken(paint['blendMode'])) base.blendMode = paint['blendMode'];
  return base;
}

function mapFilters(value: unknown) {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const key of IMAGE_FILTER_FIELDS) {
    const v = value[key];
    if (isFiniteNumber(v)) out[key] = v;
  }
  return out;
}

function hashOrNull(ctx: ExtractContext, value: unknown, nodeId: string | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && HASH_PATTERN.test(value)) return value;
  ctx.gap('invalid-media-hash', 'warning', 'A media hash had an unexpected form; left out.', {
    ...(nodeId !== undefined && { nodeId }),
  });
  return null;
}

function unsupported(
  ctx: ExtractContext,
  paint: Record<string, unknown>,
  nodeId: string | undefined,
): ExportPaint {
  const originalType = isToken(paint['type']) ? paint['type'] : 'UNKNOWN';
  ctx.gap('unsupported-paint', 'warning', `Paint type ${originalType} is not captured.`, {
    ...(nodeId !== undefined && { nodeId }),
  });
  return { type: 'UNSUPPORTED', originalType, ...paintBase(paint) };
}

function mapPaint(
  ctx: ExtractContext,
  paint: Record<string, unknown>,
  nodeId: string | undefined,
): ExportPaint {
  const type = paint['type'];
  const base = paintBase(paint);

  if (type === 'SOLID') {
    const color = mapColor(ctx, paint['color'], nodeId);
    if (!color) return unsupported(ctx, paint, nodeId);
    const bound = mapBoundVariables(ctx, paint['boundVariables']);
    return { type, color, ...base, ...(bound && { boundVariables: bound }) };
  }

  if (typeof type === 'string' && GRADIENTS.has(type)) {
    const gradientTransform = mapTransform(paint['gradientTransform']);
    const rawStops = paint['gradientStops'];
    if (!gradientTransform || !Array.isArray(rawStops)) return unsupported(ctx, paint, nodeId);
    const gradientStops = ctx
      .cap(rawStops as unknown[], LIMITS.maxGradientStops, 'gradient-stops-truncated', 'Gradient stops', nodeId)
      .flatMap((stop) => {
        if (!isRecord(stop) || !isFiniteNumber(stop['position'])) return [];
        const color = mapColor(ctx, stop['color'], nodeId);
        if (!color) return [];
        const bound = mapBoundVariables(ctx, stop['boundVariables']);
        return [{ position: stop['position'], color, ...(bound && { boundVariables: bound }) }];
      });
    return {
      type: type as Extract<ExportPaint, { gradientStops: unknown }>['type'],
      gradientTransform,
      gradientStops,
      ...base,
    };
  }

  if (type === 'IMAGE' || type === 'VIDEO') {
    const scaleMode = isToken(paint['scaleMode']) ? paint['scaleMode'] : 'FILL';
    const media = {
      scaleMode,
      ...(isFiniteNumber(paint['scalingFactor']) && { scalingFactor: paint['scalingFactor'] }),
      ...(isFiniteNumber(paint['rotation']) && { rotation: paint['rotation'] }),
      ...(isRecord(paint['filters']) && { filters: mapFilters(paint['filters'])! }),
      ...base,
    };
    if (type === 'IMAGE') {
      const imageHash = hashOrNull(ctx, paint['imageHash'], nodeId);
      if (imageHash !== null) ctx.imageHashes.add(imageHash);
      else ctx.gap('image-hash-missing', 'warning', 'An image fill has no image data.', {
        ...(nodeId !== undefined && { nodeId }),
      });
      const imageTransform = mapTransform(paint['imageTransform']);
      return { type, imageHash, ...(imageTransform && { imageTransform }), ...media };
    }
    ctx.gap('video-not-exported', 'warning', 'Video fills keep their settings but not the video.', {
      ...(nodeId !== undefined && { nodeId }),
    });
    const videoTransform = mapTransform(paint['videoTransform']);
    return {
      type,
      videoHash: hashOrNull(ctx, paint['videoHash'], nodeId),
      ...(videoTransform && { videoTransform }),
      ...media,
    };
  }

  if (type === 'PATTERN') {
    const spacing = mapVector(paint['spacing']);
    if (
      isId(paint['sourceNodeId']) &&
      isToken(paint['tileType']) &&
      isFiniteNumber(paint['scalingFactor']) &&
      spacing &&
      isToken(paint['horizontalAlignment'])
    ) {
      return {
        type,
        sourceNodeId: paint['sourceNodeId'],
        tileType: paint['tileType'],
        scalingFactor: paint['scalingFactor'],
        spacing,
        horizontalAlignment: paint['horizontalAlignment'],
        ...base,
      };
    }
  }

  return unsupported(ctx, paint, nodeId);
}

/** Returns undefined for non-arrays, including `figma.mixed`. */
export function mapPaints(
  ctx: ExtractContext,
  value: unknown,
  nodeId: string | undefined,
): ExportPaint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return ctx
    .cap(value as unknown[], LIMITS.maxPaints, 'paints-truncated', 'Paints', nodeId)
    .filter(isRecord)
    .map((paint) => mapPaint(ctx, paint, nodeId));
}

export function mapEffects(
  ctx: ExtractContext,
  value: unknown,
  nodeId: string | undefined,
): ExportEffect[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return ctx
    .cap(value as unknown[], LIMITS.maxEffects, 'effects-truncated', 'Effects', nodeId)
    .filter(isRecord)
    .map((effect) => {
      const type = isToken(effect['type']) ? effect['type'] : 'UNKNOWN';
      if (type === 'SHADER' || type === 'UNKNOWN') {
        ctx.gap('unsupported-effect', 'warning', `Effect type ${type} is not captured.`, {
          ...(nodeId !== undefined && { nodeId }),
        });
        return { type, unsupported: true };
      }
      const out: Record<string, unknown> = { type };
      const ignoredMixed: string[] = [];
      pick(ctx, effect, out, EFFECT_NUMBER_FIELDS, 'number', ignoredMixed, nodeId);
      pick(ctx, effect, out, EFFECT_TOKEN_FIELDS, 'token', ignoredMixed, nodeId);
      pick(ctx, effect, out, EFFECT_BOOL_FIELDS, 'bool', ignoredMixed, nodeId);
      for (const key of EFFECT_VECTOR_FIELDS) {
        const vector = mapVector(effect[key]);
        if (vector) out[key] = vector;
      }
      for (const key of EFFECT_COLOR_FIELDS) {
        const color = mapColor(ctx, effect[key], nodeId);
        if (color) out[key] = color;
      }
      const bound = mapBoundVariables(ctx, effect['boundVariables']);
      if (bound) out['boundVariables'] = bound;
      return out as ExportEffect;
    });
}

export function mapLayoutGrids(
  ctx: ExtractContext,
  value: unknown,
  nodeId: string | undefined,
): ExportLayoutGrid[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return ctx
    .cap(value as unknown[], LIMITS.maxLayoutGrids, 'layout-grids-truncated', 'Layout grids', nodeId)
    .filter(isRecord)
    .flatMap((grid) => {
      if (!isToken(grid['pattern'])) return [];
      const out: ExportLayoutGrid = { pattern: grid['pattern'] };
      if (isToken(grid['alignment'])) out.alignment = grid['alignment'];
      if (isFiniteNumber(grid['gutterSize'])) out.gutterSize = grid['gutterSize'];
      if (isFiniteNumber(grid['count'])) out.count = grid['count'];
      if (isFiniteNumber(grid['sectionSize'])) out.sectionSize = grid['sectionSize'];
      if (isFiniteNumber(grid['offset'])) out.offset = grid['offset'];
      if (typeof grid['visible'] === 'boolean') out.visible = grid['visible'];
      const color = mapColor(ctx, grid['color'], nodeId);
      if (color) out.color = color;
      const bound = mapBoundVariables(ctx, grid['boundVariables']);
      if (bound) out.boundVariables = bound;
      return [out];
    });
}
