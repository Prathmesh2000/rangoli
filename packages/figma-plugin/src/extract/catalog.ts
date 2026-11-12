import { LIMITS } from '../limits.js';
import type { CollectionLike, FigmaHost, NodeLike, StyleLike, VariableLike } from '../host.js';
import type {
  ExportCatalogComponent,
  ExportImage,
  ExportPreview,
  ExportRoot,
  ExportStyle,
  ExportVariable,
  ExportVariableCollection,
  ExportVariableValue,
} from '../schema.js';
import { ExtractContext, describe, isFiniteNumber, isId, isRecord, isToken, shortKey } from './context.js';
import { mapBoundVariables, mapColor, mapEffects, mapLayoutGrids, mapPaints } from './paint.js';
import { mapTextStyleProps } from './text.js';

/** Climbs to the owning page. Returns null for remote components, which have none here. */
export function findPage(ctx: ExtractContext, node: NodeLike): NodeLike | null {
  let current: unknown = node;
  for (let i = 0; i <= LIMITS.maxDepth + 1 && isRecord(current); i += 1) {
    if (current['type'] === 'PAGE') return current as NodeLike;
    current = ctx.read(current, 'parent');
  }
  return null;
}

export function mapCatalogComponent(
  ctx: ExtractContext,
  node: NodeLike,
  definition: ExportCatalogComponent['definition'],
): ExportCatalogComponent {
  const nodeId = node.id;
  const parent = ctx.read(node, 'parent', nodeId);
  const set = isRecord(parent) && parent['type'] === 'COMPONENT_SET' ? parent : null;
  const page = findPage(ctx, node);
  const description = ctx.description(ctx.read(node, 'description', nodeId), nodeId);

  const variantValue = ctx.read(node, 'variantProperties', nodeId);
  const variantProperties: { name: string; value: string }[] = [];
  if (isRecord(variantValue)) {
    for (const name of Object.keys(variantValue).slice(0, LIMITS.maxComponentProperties)) {
      const value = variantValue[name];
      if (typeof value === 'string') {
        variantProperties.push({
          name: name.slice(0, LIMITS.maxNameLength),
          value: value.slice(0, LIMITS.maxDescriptionLength),
        });
      }
    }
  }

  return {
    id: nodeId,
    key: shortKey(ctx.read(node, 'key', nodeId)),
    name: ctx.name(node.name, nodeId),
    ...(description !== undefined && { description }),
    remote: ctx.read(node, 'remote', nodeId) === true,
    pageId: page && isId(page.id) ? page.id : null,
    componentSetId: set && isId(set['id']) ? set['id'] : null,
    componentSetKey: set ? shortKey(ctx.read(set, 'key')) : null,
    componentSetName: set ? ctx.name(ctx.read(set, 'name')) : null,
    ...(variantProperties.length > 0 && { variantProperties }),
    definition,
  };
}

function mapVariableValue(ctx: ExtractContext, value: unknown, variableId: string): ExportVariableValue {
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (isFiniteNumber(value)) return { kind: 'number', value };
  if (typeof value === 'string') return { kind: 'string', value: value.slice(0, LIMITS.maxTextCharacters) };
  if (isRecord(value)) {
    if (value['type'] === 'VARIABLE_ALIAS' && isId(value['id'])) {
      ctx.variableIds.add(value['id']);
      return { kind: 'alias', id: value['id'] };
    }
    const color = mapColor(ctx, value, undefined);
    if (color) return { kind: 'color', value: color };
  }
  ctx.gap('variable-value-unsupported', 'warning', 'A variable value type is not captured.', {
    field: variableId,
  });
  return { kind: 'unsupported' };
}

function mapVariable(ctx: ExtractContext, variable: VariableLike): ExportVariable | null {
  const id = variable.id;
  const collectionId = ctx.read(variable, 'variableCollectionId');
  if (!isId(id) || !isId(collectionId)) {
    ctx.gap('variable-unreadable', 'warning', 'A variable had an unexpected form; left out.');
    return null;
  }
  const description = ctx.description(ctx.read(variable, 'description'));
  const resolvedType = ctx.read(variable, 'resolvedType');
  const scopes = ctx.read(variable, 'scopes');
  const codeSyntax = ctx.read(variable, 'codeSyntax');
  const valuesByMode = ctx.read(variable, 'valuesByMode');
  const hidden = ctx.read(variable, 'hiddenFromPublishing');

  const values: ExportVariable['values'] = [];
  if (isRecord(valuesByMode)) {
    for (const modeId of Object.keys(valuesByMode).slice(0, LIMITS.maxVariableModes)) {
      if (isId(modeId)) values.push({ modeId, value: mapVariableValue(ctx, valuesByMode[modeId], id) });
    }
  }

  const syntax: ExportVariable['codeSyntax'] = [];
  if (isRecord(codeSyntax)) {
    for (const platform of Object.keys(codeSyntax)) {
      const value = codeSyntax[platform];
      if (isToken(platform) && typeof value === 'string') {
        syntax.push({ platform, value: value.slice(0, LIMITS.maxNameLength) });
      }
    }
  }

  return {
    id,
    key: shortKey(ctx.read(variable, 'key')),
    name: ctx.name(ctx.read(variable, 'name')),
    ...(description !== undefined && { description }),
    remote: ctx.read(variable, 'remote') === true,
    ...(typeof hidden === 'boolean' && { hiddenFromPublishing: hidden }),
    collectionId,
    resolvedType: isToken(resolvedType) ? resolvedType : 'UNKNOWN',
    scopes: Array.isArray(scopes) ? (scopes as unknown[]).filter(isToken).slice(0, 64) : [],
    codeSyntax: syntax.slice(0, 8),
    values,
  };
}

function mapCollection(ctx: ExtractContext, collection: CollectionLike): ExportVariableCollection | null {
  const id = collection.id;
  const defaultModeId = ctx.read(collection, 'defaultModeId');
  if (!isId(id) || !isId(defaultModeId)) {
    ctx.gap('variable-collection-unreadable', 'warning', 'A variable collection had an unexpected form; left out.');
    return null;
  }
  const modes = ctx.read(collection, 'modes');
  const hidden = ctx.read(collection, 'hiddenFromPublishing');
  const isExtension = ctx.read(collection, 'isExtension');
  return {
    id,
    key: shortKey(ctx.read(collection, 'key')),
    name: ctx.name(ctx.read(collection, 'name')),
    remote: ctx.read(collection, 'remote') === true,
    ...(typeof hidden === 'boolean' && { hiddenFromPublishing: hidden }),
    ...(typeof isExtension === 'boolean' && { isExtension }),
    defaultModeId,
    modes: Array.isArray(modes)
      ? (modes as unknown[])
          .filter(isRecord)
          .slice(0, LIMITS.maxVariableModes)
          .flatMap((m) =>
            isId(m['modeId']) ? [{ modeId: m['modeId'], name: ctx.name(m['name']) }] : [],
          )
      : [],
  };
}

export async function collectVariables(
  ctx: ExtractContext,
  host: FigmaHost,
): Promise<{ collections: ExportVariableCollection[]; items: ExportVariable[] }> {
  const collections = new Map<string, ExportVariableCollection>();
  const items = new Map<string, ExportVariable>();

  const addCollection = (c: CollectionLike) => {
    const mapped = mapCollection(ctx, c);
    if (mapped) collections.set(mapped.id, mapped);
  };
  const addVariable = (v: VariableLike) => {
    const mapped = mapVariable(ctx, v);
    if (mapped) items.set(mapped.id, mapped);
  };

  try {
    const [localCollections, localVariables] = await Promise.all([
      host.getLocalVariableCollectionsAsync(),
      host.getLocalVariablesAsync(),
    ]);
    ctx
      .cap(localCollections, LIMITS.maxVariableCollections, 'variable-collections-truncated', 'Variable collections')
      .forEach(addCollection);
    ctx.cap(localVariables, LIMITS.maxVariables, 'variables-truncated', 'Variables').forEach(addVariable);
  } catch (error) {
    ctx.gap('variables-unavailable', 'error', `Local variables could not be read: ${describe(error)}`);
  }

  // Bound library variables, and aliases that reach outside the file.
  const queue = [...ctx.variableIds];
  const attempted = new Set<string>();
  while (queue.length > 0 && items.size < LIMITS.maxVariables) {
    const id = queue.pop()!;
    if (items.has(id) || attempted.has(id)) continue;
    attempted.add(id);
    try {
      const variable = await host.getVariableByIdAsync(id);
      if (!variable) {
        ctx.gap('variable-unavailable', 'warning', 'A variable used in the design could not be found.', { field: id });
        continue;
      }
      addVariable(variable);
      const collectionId = ctx.read(variable, 'variableCollectionId');
      if (isId(collectionId) && !collections.has(collectionId)) {
        const collection = await host.getVariableCollectionByIdAsync(collectionId);
        if (collection) addCollection(collection);
      }
      for (const known of ctx.variableIds) {
        if (!items.has(known) && !attempted.has(known)) queue.push(known);
      }
    } catch (error) {
      ctx.gap('variable-unavailable', 'warning', `A used variable could not be read: ${describe(error)}`, { field: id });
    }
  }

  return { collections: [...collections.values()], items: [...items.values()] };
}

function mapStyle(ctx: ExtractContext, style: StyleLike, kind: ExportStyle['kind']): ExportStyle | null {
  const id = style.id;
  if (!isId(id)) return null;
  const description = ctx.description(ctx.read(style, 'description'));
  const remote = ctx.read(style, 'remote');
  const out: ExportStyle = {
    id,
    key: shortKey(ctx.read(style, 'key')),
    name: ctx.name(ctx.read(style, 'name')),
    kind,
    ...(description !== undefined && { description }),
    ...(typeof remote === 'boolean' && { remote }),
  };
  if (kind === 'PAINT') {
    const paints = mapPaints(ctx, ctx.read(style, 'paints'), undefined);
    if (paints) out.paints = paints;
  } else if (kind === 'TEXT') {
    const text = mapTextStyleProps(ctx, style);
    if (text) out.text = text;
  } else if (kind === 'EFFECT') {
    const effects = mapEffects(ctx, ctx.read(style, 'effects'), undefined);
    if (effects) out.effects = effects;
  } else {
    const grids = mapLayoutGrids(ctx, ctx.read(style, 'layoutGrids'), undefined);
    if (grids) out.layoutGrids = grids;
  }
  const bound = mapBoundVariables(ctx, ctx.read(style, 'boundVariables'));
  if (bound) out.boundVariables = bound;
  return out;
}

export async function collectStyles(ctx: ExtractContext, host: FigmaHost): Promise<ExportStyle[]> {
  const sources: readonly [ExportStyle['kind'], () => Promise<readonly StyleLike[]>][] = [
    ['PAINT', () => host.getLocalPaintStylesAsync()],
    ['TEXT', () => host.getLocalTextStylesAsync()],
    ['EFFECT', () => host.getLocalEffectStylesAsync()],
    ['GRID', () => host.getLocalGridStylesAsync()],
  ];

  const out: ExportStyle[] = [];
  const localIds = new Set<string>();
  for (const [kind, load] of sources) {
    try {
      for (const style of await load()) {
        localIds.add(style.id);
        if (out.length >= LIMITS.maxStyles) {
          ctx.gap('styles-truncated', 'warning', `Only the first ${LIMITS.maxStyles} styles were kept.`);
          break;
        }
        const mapped = mapStyle(ctx, style, kind);
        if (mapped) out.push(mapped);
      }
    } catch (error) {
      ctx.gap('styles-unavailable', 'warning', `${kind} styles could not be read: ${describe(error)}`);
    }
  }

  for (const id of ctx.styleIds) {
    if (!localIds.has(id)) {
      ctx.gap('library-style-reference', 'info', 'A style from a library is referenced by id only.', { field: id });
    }
  }
  return out;
}

const MAGIC: readonly [ExportImage['mime'], readonly number[]][] = [
  ['image/png', [0x89, 0x50, 0x4e, 0x47]],
  ['image/jpeg', [0xff, 0xd8, 0xff]],
  ['image/gif', [0x47, 0x49, 0x46, 0x38]],
  ['image/webp', [0x52, 0x49, 0x46, 0x46]],
];

export function sniffImageMime(bytes: Uint8Array): ExportImage['mime'] {
  for (const [mime, signature] of MAGIC) {
    if (signature.every((byte, index) => bytes[index] === byte)) return mime;
  }
  return 'application/octet-stream';
}

export async function collectImages(
  ctx: ExtractContext,
  host: FigmaHost,
  includeBytes: boolean,
  onStep: (done: number, total: number) => Promise<void>,
): Promise<ExportImage[]> {
  const hashes = [
    ...ctx.cap([...ctx.imageHashes], LIMITS.maxImages, 'images-truncated', 'Images'),
  ];
  if (!includeBytes && hashes.length > 0) {
    ctx.gap('images-excluded', 'warning', `${hashes.length} images were left out at the user's choice; only their sizes are kept.`);
  }

  let budget = LIMITS.maxTotalImageBytes;
  const out: ExportImage[] = [];
  for (const [index, hash] of hashes.entries()) {
    await onStep(index, hashes.length);
    const entry: ExportImage = {
      hash,
      mime: 'application/octet-stream',
      width: null,
      height: null,
      byteLength: null,
      base64: null,
    };
    out.push(entry);

    const image = host.getImageByHash(hash);
    if (!image) {
      ctx.gap('image-unavailable', 'warning', 'An image referenced by a fill is not in this file.', { field: hash });
      continue;
    }
    try {
      const size = await image.getSizeAsync();
      if (isFiniteNumber(size.width) && isFiniteNumber(size.height)) {
        entry.width = size.width;
        entry.height = size.height;
      }
    } catch (error) {
      ctx.gap('image-size-unavailable', 'info', `Image size unavailable: ${describe(error)}`, { field: hash });
    }
    if (!includeBytes) continue;

    let bytes: Uint8Array;
    try {
      bytes = await image.getBytesAsync();
    } catch (error) {
      ctx.gap('image-unavailable', 'warning', `Image could not be read: ${describe(error)}`, { field: hash });
      continue;
    }
    entry.byteLength = bytes.byteLength;
    entry.mime = sniffImageMime(bytes);
    if (bytes.byteLength > LIMITS.maxImageBytes) {
      ctx.gap('image-too-large', 'warning', `Image is ${bytes.byteLength} bytes, over the per-image limit.`, { field: hash });
      continue;
    }
    if (bytes.byteLength > budget) {
      ctx.gap('image-budget-exceeded', 'warning', 'The export reached its total image size limit.', { field: hash });
      continue;
    }
    budget -= bytes.byteLength;
    entry.base64 = host.base64Encode(bytes);
  }
  return out;
}

export async function collectPreviews(
  ctx: ExtractContext,
  host: FigmaHost,
  roots: readonly (ExportRoot & { node: NodeLike })[],
  onStep: (done: number, total: number) => Promise<void>,
): Promise<ExportPreview[]> {
  let budget = LIMITS.maxTotalPreviewBytes;
  const out: ExportPreview[] = [];
  for (const [index, root] of roots.entries()) {
    await onStep(index, roots.length);
    const nodeId = root.nodeId;
    const exporter = root.node['exportAsync'];
    if (typeof exporter !== 'function') {
      ctx.gap('preview-unavailable', 'info', 'This layer cannot be rendered to a preview.', { nodeId });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await (exporter as (s: unknown) => Promise<Uint8Array>).call(root.node, {
        format: 'PNG',
        constraint: { type: 'SCALE', value: 1 },
      });
    } catch (error) {
      ctx.gap('preview-unavailable', 'warning', `Preview failed: ${describe(error)}`, { nodeId });
      continue;
    }
    if (bytes.byteLength > LIMITS.maxPreviewBytes) {
      ctx.gap('preview-too-large', 'warning', 'Preview is over the per-image limit; pixel comparison is unavailable for this frame.', { nodeId });
      continue;
    }
    if (bytes.byteLength > budget) {
      ctx.gap('preview-budget-exceeded', 'warning', 'The export reached its total preview size limit.', { nodeId });
      continue;
    }
    budget -= bytes.byteLength;
    out.push({
      nodeId,
      mime: 'image/png',
      scale: 1,
      byteLength: bytes.byteLength,
      base64: host.base64Encode(bytes),
    });
  }
  return out;
}
