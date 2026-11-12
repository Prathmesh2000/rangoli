/**
 * Export format identity and size caps. Kept free of Zod so the Figma main
 * thread can honour the caps without bundling the validator.
 *
 * The extractor truncates to these caps and records a gap; the schema rejects
 * anything over them. The two must agree, which is why both read this file.
 */

export const EXPORT_FORMAT = 'rangoli.figma-export';
export const SCHEMA_VERSION = 1;

const MiB = 1024 * 1024;

export const LIMITS = {
  /** Upper bound on the serialized JSON, checked before parsing. */
  maxExportBytes: 256 * MiB,
  /** Below the server's 2 MB request body cap. */
  chunkBytes: 1.5 * MiB,

  maxPages: 500,
  maxRoots: 5_000,
  maxNodes: 200_000,
  maxDepth: 256,

  maxIdLength: 1_024,
  maxTokenLength: 64,
  maxNameLength: 1_024,
  maxDescriptionLength: 20_000,
  maxUrlLength: 4_096,

  maxTextCharacters: 200_000,
  maxTextSegments: 20_000,

  maxPaints: 256,
  maxGradientStops: 256,
  maxEffects: 64,
  maxLayoutGrids: 64,
  maxDashes: 64,
  maxGridTracks: 1_024,
  maxBoundVariables: 256,
  maxVariableModes: 256,
  maxMixedFields: 64,

  maxVectorPaths: 4_096,
  maxVectorVertices: 100_000,
  maxVectorSegments: 200_000,
  maxVectorRegions: 10_000,
  maxVectorLoopIndices: 200_000,
  /** Combined path data per node. */
  maxVectorChars: 2_000_000,

  maxComponentProperties: 512,
  maxVariantOptions: 1_024,
  maxPreferredValues: 1_024,
  maxInstanceOverrides: 20_000,
  maxOverriddenFields: 128,

  maxComponents: 50_000,
  maxVariables: 50_000,
  maxVariableCollections: 5_000,
  maxStyles: 20_000,
  maxFonts: 5_000,

  maxImages: 20_000,
  maxImageBytes: 8 * MiB,
  maxTotalImageBytes: 96 * MiB,
  maxPreviewBytes: 8 * MiB,
  maxTotalPreviewBytes: 48 * MiB,

  maxGaps: 10_000,
  maxGapCodes: 256,
  maxGapMessageLength: 1_000,
} as const;

/** Figma ids: `1:2`, `I1:2;3:4`, `S:abc,12:3`, `VariableID:hash/1:2`. */
export const ID_PATTERN = /^[A-Za-z0-9:;,/_-]+$/;
/** Enum-like values. Deliberately not an enum, so a new Figma value doesn't fail a whole export. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
export const HASH_PATTERN = /^[A-Za-z0-9]{1,128}$/;
/** SVG path grammar only, so captured path data can't carry markup. */
export const PATH_DATA_PATTERN = /^[0-9eE.,\s+\-MmLlHhVvCcSsQqTtAaZz]*$/;
export const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
export const SAFE_URL_PATTERN = /^(https?:|mailto:|tel:)/i;

export function base64LengthFor(bytes: number): number {
  return Math.ceil(bytes / 3) * 4;
}

/** Decoded size of a base64 string. Totals are summed in bytes, since encoded lengths round up per item. */
export function base64DecodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
