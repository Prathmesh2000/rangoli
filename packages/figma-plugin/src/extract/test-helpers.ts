import type { FigmaHost, ImageLike, NodeLike, PageLike } from '../host.js';

/** Stands in for `figma.mixed`. The extractor only checks that it is a symbol. */
export const MIXED = Symbol('figma.mixed');

export function mockNode(fields: Record<string, unknown> & { id: string; type: string }): NodeLike {
  // Copies descriptors rather than spreading, so getters that throw fire only when read.
  const node = Object.defineProperties(
    { name: fields.id },
    Object.getOwnPropertyDescriptors(fields),
  ) as unknown as NodeLike;
  for (const child of (fields['children'] as NodeLike[] | undefined) ?? []) {
    Object.defineProperty(child, 'parent', { value: node, configurable: true, enumerable: false });
  }
  return node;
}

export function mockPage(id: string, children: NodeLike[], extra: Record<string, unknown> = {}): PageLike {
  let loaded = false;
  const page = {
    id,
    type: 'PAGE',
    name: `Page ${id}`,
    ...extra,
    loadAsync: async () => {
      loaded = true;
    },
    get children() {
      if (!loaded) throw new Error('page not loaded');
      return children;
    },
  } as unknown as PageLike;
  for (const child of children) {
    Object.defineProperty(child, 'parent', { value: page, configurable: true, enumerable: false });
  }
  return page;
}

export function mockHost(pages: PageLike[], overrides: Partial<FigmaHost> = {}): FigmaHost {
  return {
    fileName: 'Test file',
    fileKey: null,
    editorType: 'figma',
    pages,
    getImageByHash: () => null,
    base64Encode: (bytes) => Buffer.from(bytes).toString('base64'),
    getLocalVariablesAsync: async () => [],
    getLocalVariableCollectionsAsync: async () => [],
    getVariableByIdAsync: async () => null,
    getVariableCollectionByIdAsync: async () => null,
    getLocalPaintStylesAsync: async () => [],
    getLocalTextStylesAsync: async () => [],
    getLocalEffectStylesAsync: async () => [],
    getLocalGridStylesAsync: async () => [],
    yieldToEventLoop: async () => {},
    ...overrides,
  };
}

export function mockImage(bytes: Uint8Array, width = 10, height = 20): ImageLike {
  return {
    getBytesAsync: async () => bytes,
    getSizeAsync: async () => ({ width, height }),
  };
}

export const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
export const SOLID_RED = { type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1, visible: true, blendMode: 'NORMAL' };
