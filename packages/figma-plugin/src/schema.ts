import { z } from 'zod';

import {
  EFFECT_BOOL_FIELDS,
  EFFECT_COLOR_FIELDS,
  EFFECT_NUMBER_FIELDS,
  EFFECT_TOKEN_FIELDS,
  EFFECT_VECTOR_FIELDS,
  GRID_CHILD_NUMBER_FIELDS,
  GRID_CHILD_TOKEN_FIELDS,
  GRID_CONTAINER_NUMBER_FIELDS,
  GRID_CONTAINER_TOKEN_FIELDS,
  IMAGE_FILTER_FIELDS,
  NODE_BOOL_FIELDS,
  NODE_NUMBER_FIELDS,
  NODE_STYLE_ID_FIELDS,
  NODE_TOKEN_FIELDS,
  TEXT_NODE_BOOL_FIELDS,
  TEXT_NODE_TOKEN_FIELDS,
  TEXT_SEGMENT_NUMBER_FIELDS,
  TEXT_SEGMENT_TOKEN_FIELDS,
  TEXT_STYLE_NUMBER_FIELDS,
  TEXT_STYLE_TOKEN_FIELDS,
} from './fields.js';
import {
  BASE64_PATTERN,
  EXPORT_FORMAT,
  HASH_PATTERN,
  ID_PATTERN,
  LIMITS,
  PATH_DATA_PATTERN,
  SAFE_URL_PATTERN,
  SCHEMA_VERSION,
  TOKEN_PATTERN,
  base64DecodedBytes,
  base64LengthFor,
} from './limits.js';

export { EXPORT_FORMAT, LIMITS, SCHEMA_VERSION } from './limits.js';

/**
 * The export format. A flat, pre-order node list rather than a nested tree:
 * the node count is a plain array cap, and parsing has no recursion for a
 * hostile file to exploit.
 *
 * User-named keys (component properties, variant properties, variable modes)
 * are arrays of named entries, never objects, so a layer property called
 * `__proto__` is ordinary data.
 */

function optFields<const K extends readonly string[], S extends z.ZodType>(keys: K, schema: S) {
  return Object.fromEntries(keys.map((key) => [key, schema.optional()])) as {
    [P in K[number]]: z.ZodOptional<S>;
  };
}

const num = z.number();
const int = z.int().min(0);
const id = z.string().max(LIMITS.maxIdLength).regex(ID_PATTERN);
const token = z.string().max(LIMITS.maxTokenLength).regex(TOKEN_PATTERN);
const name = z.string().max(LIMITS.maxNameLength);
const description = z.string().max(LIMITS.maxDescriptionLength);
const hash = z.string().regex(HASH_PATTERN);

const vector = z.strictObject({ x: num, y: num });
const rect = z.strictObject({ x: num, y: num, width: num, height: num });
const transform = z.tuple([z.tuple([num, num, num]), z.tuple([num, num, num])]);
const color = z.strictObject({ r: num, g: num, b: num, a: num.optional() });

const boundVariables = z
  .array(
    z.strictObject({
      field: token,
      /** Set when one field holds several named bindings. */
      key: name.optional(),
      ids: z.array(id).max(LIMITS.maxPaints),
    }),
  )
  .max(LIMITS.maxBoundVariables);

const paintBase = {
  visible: z.boolean().optional(),
  opacity: num.optional(),
  blendMode: token.optional(),
};

const imageFilters = z.strictObject(optFields(IMAGE_FILTER_FIELDS, num));

const paint = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('SOLID'),
    color,
    boundVariables: boundVariables.optional(),
    ...paintBase,
  }),
  z.strictObject({
    type: z.enum(['GRADIENT_LINEAR', 'GRADIENT_RADIAL', 'GRADIENT_ANGULAR', 'GRADIENT_DIAMOND']),
    gradientTransform: transform,
    gradientStops: z
      .array(
        z.strictObject({ position: num, color, boundVariables: boundVariables.optional() }),
      )
      .max(LIMITS.maxGradientStops),
    ...paintBase,
  }),
  z.strictObject({
    type: z.literal('IMAGE'),
    scaleMode: token,
    imageHash: hash.nullable(),
    imageTransform: transform.optional(),
    scalingFactor: num.optional(),
    rotation: num.optional(),
    filters: imageFilters.optional(),
    ...paintBase,
  }),
  z.strictObject({
    type: z.literal('VIDEO'),
    scaleMode: token,
    videoHash: hash.nullable(),
    videoTransform: transform.optional(),
    scalingFactor: num.optional(),
    rotation: num.optional(),
    filters: imageFilters.optional(),
    ...paintBase,
  }),
  z.strictObject({
    type: z.literal('PATTERN'),
    sourceNodeId: id,
    tileType: token,
    scalingFactor: num,
    spacing: vector,
    horizontalAlignment: token,
    ...paintBase,
  }),
  /** Keeps the layer's place in the stack when its type can't be represented. A gap explains it. */
  z.strictObject({ type: z.literal('UNSUPPORTED'), originalType: token, ...paintBase }),
]);
const paints = z.array(paint).max(LIMITS.maxPaints);

const effect = z.strictObject({
  type: token,
  ...optFields(EFFECT_NUMBER_FIELDS, num),
  ...optFields(EFFECT_TOKEN_FIELDS, token),
  ...optFields(EFFECT_BOOL_FIELDS, z.boolean()),
  ...optFields(EFFECT_VECTOR_FIELDS, vector),
  ...optFields(EFFECT_COLOR_FIELDS, color),
  /** True when only the type survived. A gap explains it. */
  unsupported: z.boolean().optional(),
  boundVariables: boundVariables.optional(),
});
const effects = z.array(effect).max(LIMITS.maxEffects);

const layoutGrid = z.strictObject({
  pattern: token,
  alignment: token.optional(),
  gutterSize: num.optional(),
  count: num.optional(),
  sectionSize: num.optional(),
  offset: num.optional(),
  visible: z.boolean().optional(),
  color: color.optional(),
  boundVariables: boundVariables.optional(),
});
const layoutGrids = z.array(layoutGrid).max(LIMITS.maxLayoutGrids);

const fontName = z.strictObject({ family: name, style: name });
const unitValue = z.strictObject({ unit: token, value: num.optional() });
const hyperlink = z
  .strictObject({ type: z.enum(['URL', 'NODE']), value: z.string().max(LIMITS.maxUrlLength) })
  .refine((link) => link.type === 'NODE' || SAFE_URL_PATTERN.test(link.value), {
    message: 'hyperlink scheme not allowed',
  });

const textSegment = z.strictObject({
  start: int,
  end: int,
  ...optFields(TEXT_SEGMENT_NUMBER_FIELDS, num),
  ...optFields(TEXT_SEGMENT_TOKEN_FIELDS, token),
  fontName: fontName.optional(),
  lineHeight: unitValue.optional(),
  letterSpacing: unitValue.optional(),
  textDecorationOffset: unitValue.optional(),
  textDecorationThickness: unitValue.optional(),
  textDecorationColor: color.optional(),
  textDecorationSkipInk: z.boolean().optional(),
  fills: paints.optional(),
  textStyleId: id.optional(),
  fillStyleId: id.optional(),
  listType: token.optional(),
  hyperlink: hyperlink.optional(),
  openTypeFeatures: z
    .array(z.strictObject({ tag: token, enabled: z.boolean() }))
    .max(256)
    .optional(),
  textStyleOverrides: z.array(token).max(64).optional(),
  boundVariables: boundVariables.optional(),
});

const text = z.strictObject({
  characters: z.string().max(LIMITS.maxTextCharacters),
  segments: z.array(textSegment).max(LIMITS.maxTextSegments),
  ...optFields(TEXT_NODE_TOKEN_FIELDS, token),
  ...optFields(TEXT_NODE_BOOL_FIELDS, z.boolean()),
  leadingTrim: token.optional(),
  maxLines: num.optional(),
});

const pathData = z.string().max(LIMITS.maxVectorChars).regex(PATH_DATA_PATTERN);
const vectorPaths = z
  .array(z.strictObject({ windingRule: token, data: pathData }))
  .max(LIMITS.maxVectorPaths);

const vectorNetwork = z.strictObject({
  vertices: z
    .array(
      z.strictObject({
        x: num,
        y: num,
        strokeCap: token.optional(),
        strokeJoin: token.optional(),
        cornerRadius: num.optional(),
        handleMirroring: token.optional(),
      }),
    )
    .max(LIMITS.maxVectorVertices),
  segments: z
    .array(
      z.strictObject({
        start: int,
        end: int,
        tangentStart: vector.optional(),
        tangentEnd: vector.optional(),
      }),
    )
    .max(LIMITS.maxVectorSegments),
  regions: z
    .array(
      z.strictObject({
        windingRule: token,
        loops: z
          .array(z.array(int).max(LIMITS.maxVectorLoopIndices))
          .max(LIMITS.maxVectorRegions),
        fills: paints.optional(),
        fillStyleId: id.optional(),
      }),
    )
    .max(LIMITS.maxVectorRegions)
    .optional(),
});

const nodeVector = z.strictObject({
  vectorPaths: vectorPaths.optional(),
  fillGeometry: vectorPaths.optional(),
  strokeGeometry: vectorPaths.optional(),
  vectorNetwork: vectorNetwork.optional(),
});

const namedString = z.strictObject({ name, value: z.string().max(LIMITS.maxDescriptionLength) });
const preferredValues = z
  .array(z.strictObject({ type: token, key: z.string().max(LIMITS.maxIdLength) }))
  .max(LIMITS.maxPreferredValues);

const propertyValue = z.union([z.boolean(), z.string().max(LIMITS.maxTextCharacters)]);

const component = z.strictObject({
  key: z.string().max(LIMITS.maxIdLength),
  description: description.optional(),
  remote: z.boolean().optional(),
  variantProperties: z.array(namedString).max(LIMITS.maxComponentProperties).optional(),
  propertyDefinitions: z
    .array(
      z.strictObject({
        name,
        type: token,
        defaultValue: propertyValue,
        variantOptions: z.array(name).max(LIMITS.maxVariantOptions).optional(),
        preferredValues: preferredValues.optional(),
        description: description.optional(),
      }),
    )
    .max(LIMITS.maxComponentProperties)
    .optional(),
  defaultVariantId: id.optional(),
});

const instance = z.strictObject({
  /** Null when the main component is missing. A gap records it. */
  mainComponentId: id.nullable(),
  scaleFactor: num.optional(),
  properties: z
    .array(
      z.strictObject({
        name,
        type: token,
        value: propertyValue,
        preferredValues: preferredValues.optional(),
        boundVariables: boundVariables.optional(),
      }),
    )
    .max(LIMITS.maxComponentProperties),
  overrides: z
    .array(
      z.strictObject({ id, fields: z.array(token).max(LIMITS.maxOverriddenFields) }),
    )
    .max(LIMITS.maxInstanceOverrides),
});

export const ExportNodeSchema = z.strictObject({
  id,
  /** Null only on roots. A parent always appears earlier in the array. */
  parentId: id.nullable(),
  pageId: id,
  type: token,
  name,

  ...optFields(NODE_NUMBER_FIELDS, num),
  ...optFields(NODE_TOKEN_FIELDS, token),
  ...optFields(NODE_BOOL_FIELDS, z.boolean()),
  ...optFields(NODE_STYLE_ID_FIELDS, id),
  ...optFields(GRID_CONTAINER_NUMBER_FIELDS, num),
  ...optFields(GRID_CONTAINER_TOKEN_FIELDS, token),
  ...optFields(GRID_CHILD_NUMBER_FIELDS, num),
  ...optFields(GRID_CHILD_TOKEN_FIELDS, token),

  /** Properties Figma reported as mixed; per-side, per-corner or segment data holds the detail. */
  mixed: z.array(token).max(LIMITS.maxMixedFields).optional(),

  relativeTransform: transform.optional(),
  absoluteBoundingBox: rect.optional(),
  absoluteRenderBounds: rect.optional(),
  constraints: z.strictObject({ horizontal: token, vertical: token }).optional(),
  targetAspectRatio: vector.optional(),
  arcData: z
    .strictObject({ startingAngle: num, endingAngle: num, innerRadius: num })
    .optional(),
  dashPattern: z.array(num).max(LIMITS.maxDashes).optional(),
  gridRowSizes: z
    .array(z.strictObject({ type: token, value: num.optional() }))
    .max(LIMITS.maxGridTracks)
    .optional(),
  gridColumnSizes: z
    .array(z.strictObject({ type: token, value: num.optional() }))
    .max(LIMITS.maxGridTracks)
    .optional(),

  fills: paints.optional(),
  strokes: paints.optional(),
  effects: effects.optional(),
  layoutGrids: layoutGrids.optional(),

  boundVariables: boundVariables.optional(),
  explicitVariableModes: z
    .array(z.strictObject({ collectionId: id, modeId: id }))
    .max(LIMITS.maxVariableModes)
    .optional(),
  componentPropertyReferences: z
    .array(z.strictObject({ field: token, property: name }))
    .max(8)
    .optional(),

  text: text.optional(),
  vector: nodeVector.optional(),
  component: component.optional(),
  instance: instance.optional(),
});

const root = z.strictObject({
  nodeId: id,
  pageId: id,
  origin: z.enum(['selected', 'component-definition']),
});

const page = z.strictObject({
  id,
  name,
  /** True when the whole page was chosen rather than individual frames. */
  wholePage: z.boolean(),
  backgrounds: paints.optional(),
});

const catalogComponent = z.strictObject({
  id,
  key: z.string().max(LIMITS.maxIdLength),
  name,
  description: description.optional(),
  remote: z.boolean(),
  /** Null when the component is remote or its page can't be determined. */
  pageId: id.nullable(),
  componentSetId: id.nullable(),
  componentSetKey: z.string().max(LIMITS.maxIdLength).nullable(),
  componentSetName: name.nullable(),
  variantProperties: z.array(namedString).max(LIMITS.maxComponentProperties).optional(),
  /** `captured`: the tree is in `nodes`. `metadata-only`: a gap explains why it isn't. */
  definition: z.enum(['captured', 'metadata-only']),
});

const variableValue = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('boolean'), value: z.boolean() }),
  z.strictObject({ kind: z.literal('number'), value: num }),
  z.strictObject({ kind: z.literal('string'), value: z.string().max(LIMITS.maxTextCharacters) }),
  z.strictObject({ kind: z.literal('color'), value: color }),
  z.strictObject({ kind: z.literal('alias'), id }),
  z.strictObject({ kind: z.literal('unsupported') }),
]);

const variable = z.strictObject({
  id,
  key: z.string().max(LIMITS.maxIdLength),
  name,
  description: description.optional(),
  remote: z.boolean(),
  hiddenFromPublishing: z.boolean().optional(),
  collectionId: id,
  resolvedType: token,
  scopes: z.array(token).max(64),
  codeSyntax: z
    .array(z.strictObject({ platform: token, value: z.string().max(LIMITS.maxNameLength) }))
    .max(8),
  values: z.array(z.strictObject({ modeId: id, value: variableValue })).max(LIMITS.maxVariableModes),
});

const variableCollection = z.strictObject({
  id,
  key: z.string().max(LIMITS.maxIdLength),
  name,
  remote: z.boolean(),
  hiddenFromPublishing: z.boolean().optional(),
  isExtension: z.boolean().optional(),
  defaultModeId: id,
  modes: z.array(z.strictObject({ modeId: id, name })).max(LIMITS.maxVariableModes),
});

const textStyleProps = z.strictObject({
  ...optFields(TEXT_STYLE_NUMBER_FIELDS, num),
  ...optFields(TEXT_STYLE_TOKEN_FIELDS, token),
  fontName: fontName.optional(),
  lineHeight: unitValue.optional(),
  letterSpacing: unitValue.optional(),
});

const style = z.strictObject({
  id,
  key: z.string().max(LIMITS.maxIdLength),
  name,
  description: description.optional(),
  remote: z.boolean().optional(),
  kind: z.enum(['PAINT', 'TEXT', 'EFFECT', 'GRID']),
  paints: paints.optional(),
  text: textStyleProps.optional(),
  effects: effects.optional(),
  layoutGrids: layoutGrids.optional(),
  boundVariables: boundVariables.optional(),
});

const imageBase64 = z
  .string()
  .max(base64LengthFor(LIMITS.maxImageBytes))
  .regex(BASE64_PATTERN);

const image = z.strictObject({
  hash,
  mime: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/octet-stream']),
  width: num.nullable(),
  height: num.nullable(),
  byteLength: int.nullable(),
  /** Null when the bytes were excluded, oversized or unreadable. A gap records which. */
  base64: imageBase64.nullable(),
});

const preview = z.strictObject({
  nodeId: id,
  mime: z.literal('image/png'),
  scale: num,
  byteLength: int,
  base64: z.string().max(base64LengthFor(LIMITS.maxPreviewBytes)).regex(BASE64_PATTERN),
});

export const GapSchema = z.strictObject({
  code: token,
  severity: z.enum(['info', 'warning', 'error']),
  message: z.string().max(LIMITS.maxGapMessageLength),
  nodeId: id.optional(),
  pageId: id.optional(),
  field: z.string().max(LIMITS.maxNameLength).optional(),
});

export const FigmaExportSchema = z
  .strictObject({
    format: z.literal(EXPORT_FORMAT),
    schemaVersion: z.literal(SCHEMA_VERSION),
    exportedAt: z.iso.datetime(),
    source: z.strictObject({
      fileName: name,
      /** Only private plugins can read this; null otherwise. */
      fileKey: z.string().max(LIMITS.maxIdLength).nullable(),
      editorType: token,
      pluginVersion: z.string().max(32),
    }),
    pages: z.array(page).max(LIMITS.maxPages),
    roots: z.array(root).max(LIMITS.maxRoots),
    nodes: z.array(ExportNodeSchema).max(LIMITS.maxNodes),
    components: z.array(catalogComponent).max(LIMITS.maxComponents),
    variables: z.strictObject({
      collections: z.array(variableCollection).max(LIMITS.maxVariableCollections),
      items: z.array(variable).max(LIMITS.maxVariables),
    }),
    styles: z.array(style).max(LIMITS.maxStyles),
    fonts: z.array(fontName).max(LIMITS.maxFonts),
    images: z.array(image).max(LIMITS.maxImages),
    previews: z.array(preview).max(LIMITS.maxRoots),
    gaps: z.array(GapSchema).max(LIMITS.maxGaps),
    /** Complete counts, even when `gaps` hit its cap. */
    gapSummary: z
      .array(
        z.strictObject({
          code: token,
          severity: z.enum(['info', 'warning', 'error']),
          count: int,
        }),
      )
      .max(LIMITS.maxGapCodes),
    stats: z.strictObject({
      nodes: int,
      textNodes: int,
      instances: int,
      vectorNodes: int,
      /** False when a cap stopped the walk early. */
      complete: z.boolean(),
    }),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string, path: (string | number)[]) =>
      ctx.addIssue({ code: 'custom', message, path });

    const pageIds = new Set(value.pages.map((p) => p.id));
    const depths = new Map<string, number>();
    const parentless = new Set<string>();

    value.nodes.forEach((node, index) => {
      if (depths.has(node.id)) issue('duplicate node id', ['nodes', index, 'id']);
      if (!pageIds.has(node.pageId)) issue('unknown page', ['nodes', index, 'pageId']);

      if (node.parentId === null) {
        parentless.add(node.id);
        depths.set(node.id, 0);
        return;
      }
      // Requiring parent-before-child rules out cycles in one pass.
      const parentDepth = depths.get(node.parentId);
      if (parentDepth === undefined) {
        issue('parent must appear before child', ['nodes', index, 'parentId']);
        depths.set(node.id, 0);
        return;
      }
      if (parentDepth + 1 > LIMITS.maxDepth) issue('tree too deep', ['nodes', index, 'parentId']);
      depths.set(node.id, parentDepth + 1);
    });

    const rootIds = new Set<string>();
    value.roots.forEach((r, index) => {
      if (rootIds.has(r.nodeId)) issue('duplicate root', ['roots', index, 'nodeId']);
      rootIds.add(r.nodeId);
      if (!parentless.has(r.nodeId)) issue('root is not a parentless node', ['roots', index, 'nodeId']);
      if (!pageIds.has(r.pageId)) issue('unknown page', ['roots', index, 'pageId']);
    });
    for (const nodeId of parentless) {
      if (!rootIds.has(nodeId)) issue('parentless node is not a root', ['nodes']);
    }

    const componentIds = new Set(value.components.map((c) => c.id));
    value.nodes.forEach((node, index) => {
      const main = node.instance?.mainComponentId;
      if (main && !componentIds.has(main)) {
        issue('instance references unknown component', ['nodes', index, 'instance']);
      }
    });

    const seenHashes = new Set<string>();
    let imageBytes = 0;
    value.images.forEach((img, index) => {
      if (seenHashes.has(img.hash)) issue('duplicate image', ['images', index, 'hash']);
      seenHashes.add(img.hash);
      if (img.base64 !== null) imageBytes += base64DecodedBytes(img.base64);
    });
    if (imageBytes > LIMITS.maxTotalImageBytes) issue('images too large', ['images']);

    const previewBytes = value.previews.reduce((sum, p) => sum + base64DecodedBytes(p.base64), 0);
    if (previewBytes > LIMITS.maxTotalPreviewBytes) issue('previews too large', ['previews']);
  });

export type FigmaExport = z.infer<typeof FigmaExportSchema>;
export type ExportNode = z.infer<typeof ExportNodeSchema>;
export type ExportGap = z.infer<typeof GapSchema>;
export type ExportPaint = FigmaExport['nodes'][number]['fills'] extends (infer P)[] | undefined
  ? P
  : never;
export type ExportEffect = z.infer<typeof effect>;
export type ExportLayoutGrid = z.infer<typeof layoutGrid>;
export type ExportBoundVariables = z.infer<typeof boundVariables>;
export type ExportColor = z.infer<typeof color>;
export type ExportText = z.infer<typeof text>;
export type ExportTextSegment = z.infer<typeof textSegment>;
export type ExportVector = z.infer<typeof nodeVector>;
export type ExportVectorPaths = z.infer<typeof vectorPaths>;
export type ExportComponent = z.infer<typeof component>;
export type ExportInstance = z.infer<typeof instance>;
export type ExportCatalogComponent = z.infer<typeof catalogComponent>;
export type ExportVariable = z.infer<typeof variable>;
export type ExportVariableCollection = z.infer<typeof variableCollection>;
export type ExportVariableValue = z.infer<typeof variableValue>;
export type ExportStyle = z.infer<typeof style>;
export type ExportImage = z.infer<typeof image>;
export type ExportPreview = z.infer<typeof preview>;
export type ExportRoot = z.infer<typeof root>;
export type ExportPage = z.infer<typeof page>;

export type ParseResult =
  | { ok: true; data: FigmaExport }
  | { ok: false; error: string; issues: { path: string; message: string }[] };

/**
 * The single entry point for untrusted export text. Rejects oversized input
 * before JSON.parse. The size check is on UTF-16 length, a lower bound on the
 * byte size, so transports must also enforce a byte limit.
 */
export function parseFigmaExport(json: string): ParseResult {
  if (json.length > LIMITS.maxExportBytes) {
    return { ok: false, error: 'Export is larger than the size limit.', issues: [] };
  }
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return { ok: false, error: 'Export is not valid JSON.', issues: [] };
  }
  const result = FigmaExportSchema.safeParse(value);
  if (result.success) return { ok: true, data: result.data };
  return {
    ok: false,
    error: 'Export failed schema validation.',
    issues: result.error.issues.slice(0, 50).map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  };
}
