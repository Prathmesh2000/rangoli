/**
 * The extractor's only view of Figma. `code.ts` binds this to the `figma`
 * global; tests bind it to plain mock objects.
 */

/** A scene node, read defensively because properties vary by type and may throw. */
export type NodeLike = { readonly id: string; readonly type: string; readonly name: string } & Record<
  string,
  unknown
>;

export interface PageLike extends NodeLike {
  loadAsync(): Promise<void>;
  readonly children: readonly NodeLike[];
}

export interface ImageLike {
  getBytesAsync(): Promise<Uint8Array>;
  getSizeAsync(): Promise<{ width: number; height: number }>;
}

export type VariableLike = Record<string, unknown> & { readonly id: string };
export type CollectionLike = Record<string, unknown> & { readonly id: string };
export type StyleLike = Record<string, unknown> & { readonly id: string };

export interface FigmaHost {
  readonly fileName: string;
  readonly fileKey: string | null;
  readonly editorType: string;
  readonly pages: readonly PageLike[];

  getImageByHash(hash: string): ImageLike | null;
  base64Encode(bytes: Uint8Array): string;

  getLocalVariablesAsync(): Promise<readonly VariableLike[]>;
  getLocalVariableCollectionsAsync(): Promise<readonly CollectionLike[]>;
  getVariableByIdAsync(id: string): Promise<VariableLike | null>;
  getVariableCollectionByIdAsync(id: string): Promise<CollectionLike | null>;

  getLocalPaintStylesAsync(): Promise<readonly StyleLike[]>;
  getLocalTextStylesAsync(): Promise<readonly StyleLike[]>;
  getLocalEffectStylesAsync(): Promise<readonly StyleLike[]>;
  getLocalGridStylesAsync(): Promise<readonly StyleLike[]>;

  /** Gives Figma a chance to paint and to deliver a cancel message. */
  yieldToEventLoop(): Promise<void>;
}

export interface ExportSelection {
  /** `nodeIds: null` takes every top-level layer on the page. */
  pages: { pageId: string; nodeIds: string[] | null }[];
}

export interface ExportOptions {
  includeImages: boolean;
  /** 1x PNGs of each chosen frame, the reference for pixel comparison. */
  includePreviews: boolean;
}

export type ExportPhase = 'layers' | 'components' | 'variables' | 'styles' | 'images' | 'previews';

export interface ExportHooks {
  onProgress?(phase: ExportPhase, done: number, total: number | null): void;
  isCancelled?(): boolean;
}
