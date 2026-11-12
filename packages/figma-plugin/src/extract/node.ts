import {
  GRID_CHILD_NUMBER_FIELDS,
  GRID_CHILD_TOKEN_FIELDS,
  GRID_CONTAINER_NUMBER_FIELDS,
  GRID_CONTAINER_TOKEN_FIELDS,
  MODELED_NODE_TYPES,
  NODE_BOOL_FIELDS,
  NODE_NUMBER_FIELDS,
  NODE_STYLE_ID_FIELDS,
  NODE_TOKEN_FIELDS,
  VECTOR_NODE_TYPES,
} from '../fields.js';
import { LIMITS } from '../limits.js';
import type { NodeLike } from '../host.js';
import type { ExportComponent, ExportInstance, ExportNode } from '../schema.js';
import {
  ExtractContext,
  describe,
  isFiniteNumber,
  isId,
  isRecord,
  isToken,
  pick,
  shortKey,
} from './context.js';
import { mapBoundVariables, mapEffects, mapLayoutGrids, mapPaints, mapTransform, mapVector } from './paint.js';
import { isTextNode, mapText } from './text.js';
import { mapNodeVector } from './vector.js';

/** Node properties the format doesn't model. Present values raise a gap instead of vanishing. */
const NOT_CAPTURED: readonly { key: string; code: string; label: string }[] = [
  { key: 'reactions', code: 'prototype-not-captured', label: 'Prototype interactions' },
  { key: 'annotations', code: 'annotations-not-captured', label: 'Dev Mode annotations' },
  { key: 'exportSettings', code: 'export-settings-not-captured', label: 'Export settings' },
  { key: 'guides', code: 'guides-not-captured', label: 'Layout guides' },
];

function mapRect(value: unknown) {
  if (!isRecord(value)) return undefined;
  const { x, y, width, height } = value;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return undefined;
  }
  return { x, y, width, height };
}

function mapNamedStrings(ctx: ExtractContext, value: unknown) {
  if (!isRecord(value)) return undefined;
  const names = Object.keys(value);
  return ctx
    .cap(names, LIMITS.maxComponentProperties, 'variant-properties-truncated', 'Variant properties')
    .flatMap((name) => {
      const text = value[name];
      return typeof text === 'string'
        ? [{ name: name.slice(0, LIMITS.maxNameLength), value: text.slice(0, LIMITS.maxDescriptionLength) }]
        : [];
    });
}

function mapPreferred(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return (value as unknown[])
    .filter(isRecord)
    .slice(0, LIMITS.maxPreferredValues)
    .flatMap((v) =>
      isToken(v['type']) && typeof v['key'] === 'string'
        ? [{ type: v['type'], key: shortKey(v['key']) }]
        : [],
    );
}

function propertyValue(value: unknown): string | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.slice(0, LIMITS.maxTextCharacters);
  return undefined;
}

function mapPropertyDefinitions(ctx: ExtractContext, value: unknown, nodeId: string) {
  if (!isRecord(value)) return undefined;
  const names = Object.keys(value);
  return ctx
    .cap(names, LIMITS.maxComponentProperties, 'component-properties-truncated', 'Component properties', nodeId)
    .flatMap((name) => {
      const def = value[name];
      if (!isRecord(def) || !isToken(def['type'])) return [];
      const defaultValue = propertyValue(def['defaultValue']);
      if (defaultValue === undefined) {
        ctx.gap('component-property-unreadable', 'warning', 'A component property default was left out.', {
          nodeId,
          field: name,
        });
        return [];
      }
      const variantOptions = Array.isArray(def['variantOptions'])
        ? (def['variantOptions'] as unknown[])
            .filter((o): o is string => typeof o === 'string')
            .slice(0, LIMITS.maxVariantOptions)
            .map((o) => o.slice(0, LIMITS.maxNameLength))
        : undefined;
      const preferredValues = mapPreferred(def['preferredValues']);
      const description = ctx.description(def['description'], nodeId);
      return [
        {
          name: name.slice(0, LIMITS.maxNameLength),
          type: def['type'],
          defaultValue,
          ...(variantOptions && { variantOptions }),
          ...(preferredValues && { preferredValues }),
          ...(description !== undefined && { description }),
        },
      ];
    });
}

function mapComponent(ctx: ExtractContext, node: NodeLike): ExportComponent {
  const nodeId = node.id;
  const out: ExportComponent = { key: shortKey(ctx.read(node, 'key', nodeId)) };
  const description = ctx.description(ctx.read(node, 'description', nodeId), nodeId);
  if (description !== undefined) out.description = description;
  const remote = ctx.read(node, 'remote', nodeId);
  if (typeof remote === 'boolean') out.remote = remote;

  if (node.type === 'COMPONENT') {
    const variantProperties = mapNamedStrings(ctx, ctx.read(node, 'variantProperties', nodeId));
    if (variantProperties) out.variantProperties = variantProperties;
  }

  // Figma throws if definitions are read on a variant; they live on the set.
  const parent = ctx.read(node, 'parent', nodeId);
  const isVariant = isRecord(parent) && parent['type'] === 'COMPONENT_SET';
  if (!isVariant) {
    const definitions = mapPropertyDefinitions(ctx, ctx.read(node, 'componentPropertyDefinitions', nodeId), nodeId);
    if (definitions) out.propertyDefinitions = definitions;
  }

  if (node.type === 'COMPONENT_SET') {
    const defaultVariant = ctx.read(node, 'defaultVariant', nodeId);
    if (isRecord(defaultVariant) && isId(defaultVariant['id'])) out.defaultVariantId = defaultVariant['id'];
  }
  return out;
}

async function mapInstance(ctx: ExtractContext, node: NodeLike): Promise<ExportInstance> {
  const nodeId = node.id;
  let mainComponentId: string | null = null;
  try {
    const main = await (node['getMainComponentAsync'] as () => Promise<NodeLike | null>).call(node);
    if (main && isId(main.id)) {
      mainComponentId = main.id;
      if (!ctx.componentNodes.has(main.id)) ctx.componentNodes.set(main.id, main);
    } else {
      ctx.gap('main-component-missing', 'warning', 'Instance has no main component.', { nodeId });
    }
  } catch (error) {
    ctx.gap('main-component-missing', 'warning', `Main component unavailable: ${describe(error)}`, { nodeId });
  }

  const out: ExportInstance = { mainComponentId, properties: [], overrides: [] };
  const scaleFactor = ctx.read(node, 'scaleFactor', nodeId);
  if (isFiniteNumber(scaleFactor)) out.scaleFactor = scaleFactor;

  const properties = ctx.read(node, 'componentProperties', nodeId);
  if (isRecord(properties)) {
    const names = ctx.cap(
      Object.keys(properties),
      LIMITS.maxComponentProperties,
      'component-properties-truncated',
      'Component properties',
      nodeId,
    );
    for (const name of names) {
      const property = properties[name];
      if (!isRecord(property) || !isToken(property['type'])) continue;
      const value = propertyValue(property['value']);
      if (value === undefined) {
        ctx.gap('component-property-unreadable', 'warning', 'An instance property value was left out.', {
          nodeId,
          field: name,
        });
        continue;
      }
      const preferredValues = mapPreferred(property['preferredValues']);
      const bound = mapBoundVariables(ctx, property['boundVariables']);
      out.properties.push({
        name: name.slice(0, LIMITS.maxNameLength),
        type: property['type'],
        value,
        ...(preferredValues && { preferredValues }),
        ...(bound && { boundVariables: bound }),
      });
    }
  }

  const overrides = ctx.read(node, 'overrides', nodeId);
  if (Array.isArray(overrides)) {
    out.overrides = ctx
      .cap(overrides as unknown[], LIMITS.maxInstanceOverrides, 'overrides-truncated', 'Instance overrides', nodeId)
      .filter(isRecord)
      .flatMap((override) => {
        if (!isId(override['id']) || !Array.isArray(override['overriddenFields'])) return [];
        return [
          {
            id: override['id'],
            fields: (override['overriddenFields'] as unknown[])
              .filter(isToken)
              .slice(0, LIMITS.maxOverriddenFields),
          },
        ];
      });
  }
  return out;
}

function mapModes(value: unknown) {
  if (!isRecord(value)) return undefined;
  const modes: { collectionId: string; modeId: string }[] = [];
  for (const collectionId of Object.keys(value)) {
    const modeId = value[collectionId];
    if (isId(collectionId) && isId(modeId)) modes.push({ collectionId, modeId });
  }
  return modes.length > 0 ? modes.slice(0, LIMITS.maxVariableModes) : undefined;
}

function mapPropertyReferences(value: unknown) {
  if (!isRecord(value)) return undefined;
  const refs: { field: string; property: string }[] = [];
  for (const field of Object.keys(value)) {
    const property = value[field];
    if (isToken(field) && typeof property === 'string') {
      refs.push({ field, property: property.slice(0, LIMITS.maxNameLength) });
    }
  }
  return refs.length > 0 ? refs.slice(0, 8) : undefined;
}

export async function mapNode(
  ctx: ExtractContext,
  node: NodeLike,
  parentId: string | null,
  parent: Record<string, unknown> | null,
  pageId: string,
): Promise<ExportNode> {
  const nodeId = node.id;
  const out: Record<string, unknown> = {
    id: nodeId,
    parentId,
    pageId,
    type: isToken(node.type) ? node.type : 'UNKNOWN',
    name: ctx.name(node.name, nodeId),
  };
  const mixed: string[] = [];
  const copy = (keys: readonly string[], kind: Parameters<typeof pick>[4]) =>
    pick(ctx, node, out, keys, kind, mixed, nodeId);

  copy(NODE_NUMBER_FIELDS, 'number');
  copy(NODE_TOKEN_FIELDS, 'token');
  copy(NODE_BOOL_FIELDS, 'bool');
  copy(NODE_STYLE_ID_FIELDS, 'id');
  for (const key of NODE_STYLE_ID_FIELDS) {
    const id = out[key];
    if (typeof id === 'string') ctx.styleIds.add(id);
  }

  // Grid properties are only read where they apply.
  if (out['layoutMode'] === 'GRID') {
    copy(GRID_CONTAINER_NUMBER_FIELDS, 'number');
    copy(GRID_CONTAINER_TOKEN_FIELDS, 'token');
    for (const key of ['gridRowSizes', 'gridColumnSizes']) {
      const tracks = ctx.read(node, key, nodeId);
      if (!Array.isArray(tracks)) continue;
      out[key] = ctx
        .cap(tracks as unknown[], LIMITS.maxGridTracks, 'grid-tracks-truncated', 'Grid tracks', nodeId)
        .filter(isRecord)
        .flatMap((t) =>
          isToken(t['type'])
            ? [{ type: t['type'], ...(isFiniteNumber(t['value']) && { value: t['value'] }) }]
            : [],
        );
    }
  }
  if (parent && ctx.read(parent, 'layoutMode') === 'GRID') {
    copy(GRID_CHILD_NUMBER_FIELDS, 'number');
    copy(GRID_CHILD_TOKEN_FIELDS, 'token');
  }

  const relativeTransform = mapTransform(ctx.read(node, 'relativeTransform', nodeId));
  if (relativeTransform) out['relativeTransform'] = relativeTransform;
  const bounds = mapRect(ctx.read(node, 'absoluteBoundingBox', nodeId));
  if (bounds) out['absoluteBoundingBox'] = bounds;
  const renderBounds = mapRect(ctx.read(node, 'absoluteRenderBounds', nodeId));
  if (renderBounds) out['absoluteRenderBounds'] = renderBounds;

  const constraints = ctx.read(node, 'constraints', nodeId);
  if (isRecord(constraints) && isToken(constraints['horizontal']) && isToken(constraints['vertical'])) {
    out['constraints'] = { horizontal: constraints['horizontal'], vertical: constraints['vertical'] };
  }

  const aspect = mapVector(ctx.read(node, 'targetAspectRatio', nodeId));
  if (aspect) out['targetAspectRatio'] = aspect;

  const arc = ctx.read(node, 'arcData', nodeId);
  if (isRecord(arc) && isFiniteNumber(arc['startingAngle']) && isFiniteNumber(arc['endingAngle']) && isFiniteNumber(arc['innerRadius'])) {
    out['arcData'] = {
      startingAngle: arc['startingAngle'],
      endingAngle: arc['endingAngle'],
      innerRadius: arc['innerRadius'],
    };
  }

  const dash = ctx.read(node, 'dashPattern', nodeId);
  if (Array.isArray(dash) && dash.length > 0) {
    out['dashPattern'] = (dash as unknown[]).filter(isFiniteNumber).slice(0, LIMITS.maxDashes);
  }

  const readPaints = (key: 'fills' | 'strokes') => {
    const value = ctx.read(node, key, nodeId);
    if (typeof value === 'symbol') mixed.push(key);
    const paints = mapPaints(ctx, value, nodeId);
    if (paints && paints.length > 0) out[key] = paints;
  };
  readPaints('fills');
  readPaints('strokes');

  const effects = mapEffects(ctx, ctx.read(node, 'effects', nodeId), nodeId);
  if (effects && effects.length > 0) out['effects'] = effects;
  const grids = mapLayoutGrids(ctx, ctx.read(node, 'layoutGrids', nodeId), nodeId);
  if (grids && grids.length > 0) out['layoutGrids'] = grids;

  const bound = mapBoundVariables(ctx, ctx.read(node, 'boundVariables', nodeId));
  if (bound) out['boundVariables'] = bound;
  const modes = mapModes(ctx.read(node, 'explicitVariableModes', nodeId));
  if (modes) out['explicitVariableModes'] = modes;
  const references = mapPropertyReferences(ctx.read(node, 'componentPropertyReferences', nodeId));
  if (references) out['componentPropertyReferences'] = references;

  if (isTextNode(node)) out['text'] = mapText(ctx, node, nodeId);
  if (VECTOR_NODE_TYPES.has(node.type)) out['vector'] = mapNodeVector(ctx, node, nodeId);

  if (node.type === 'COMPONENT' || node.type === 'COMPONENT_SET') {
    out['component'] = mapComponent(ctx, node);
    if (node.type === 'COMPONENT' && !ctx.componentNodes.has(nodeId)) {
      ctx.componentNodes.set(nodeId, node);
    }
  }
  if (node.type === 'INSTANCE' && typeof node['getMainComponentAsync'] === 'function') {
    out['instance'] = await mapInstance(ctx, node);
  }

  if (!MODELED_NODE_TYPES.has(node.type)) {
    ctx.gap(
      'unsupported-node-type',
      'warning',
      `${String(out['type'])} layers keep position and size only.`,
      { nodeId },
    );
  }

  for (const { key, code, label } of NOT_CAPTURED) {
    const value = ctx.read(node, key, nodeId);
    if (Array.isArray(value) && value.length > 0) {
      ctx.gap(code, 'info', `${label} are not part of the export.`, { nodeId, field: key });
    }
  }

  if (mixed.length > 0) out['mixed'] = mixed.slice(0, LIMITS.maxMixedFields);
  return out as ExportNode;
}
