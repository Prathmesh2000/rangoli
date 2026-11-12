/**
 * Figma main thread. The only file that touches the `figma` global: it binds
 * the host and relays messages. All extraction lives in `extract/`.
 */

import { ExportCancelled, buildExport } from './extract/export.js';
import type {
  CollectionLike,
  ExportHooks,
  FigmaHost,
  ImageLike,
  NodeLike,
  PageLike,
  StyleLike,
  VariableLike,
} from './host.js';
import { MAX_LISTED_FRAMES, type FrameSummary, type MainToUi, type UiToMain } from './protocol.js';

function post(message: MainToUi): void {
  figma.ui.postMessage(message);
}

// Figma's docs say setTimeout isn't "directly" available in the sandbox, so don't depend on it.
const yieldToEventLoop = (): Promise<void> =>
  typeof setTimeout === 'function'
    ? new Promise((resolve) => setTimeout(resolve, 0))
    : Promise.resolve();

/** The extractor reads nodes as loose records, which Figma's class-like types don't convert to directly. */
const loose = <T>(value: unknown): T => value as T;

const host: FigmaHost = {
  fileName: figma.root.name,
  fileKey: figma.fileKey ?? null,
  editorType: figma.editorType,
  pages: loose<readonly PageLike[]>(figma.root.children),
  getImageByHash: (hash) => loose<ImageLike | null>(figma.getImageByHash(hash)),
  base64Encode: (bytes) => figma.base64Encode(bytes),
  getLocalVariablesAsync: () => loose<Promise<readonly VariableLike[]>>(figma.variables.getLocalVariablesAsync()),
  getLocalVariableCollectionsAsync: () =>
    loose<Promise<readonly CollectionLike[]>>(figma.variables.getLocalVariableCollectionsAsync()),
  getVariableByIdAsync: (id) => loose<Promise<VariableLike | null>>(figma.variables.getVariableByIdAsync(id)),
  getVariableCollectionByIdAsync: (id) =>
    loose<Promise<CollectionLike | null>>(figma.variables.getVariableCollectionByIdAsync(id)),
  getLocalPaintStylesAsync: () => loose<Promise<readonly StyleLike[]>>(figma.getLocalPaintStylesAsync()),
  getLocalTextStylesAsync: () => loose<Promise<readonly StyleLike[]>>(figma.getLocalTextStylesAsync()),
  getLocalEffectStylesAsync: () => loose<Promise<readonly StyleLike[]>>(figma.getLocalEffectStylesAsync()),
  getLocalGridStylesAsync: () => loose<Promise<readonly StyleLike[]>>(figma.getLocalGridStylesAsync()),
  yieldToEventLoop,
};

let cancelRequested = false;
let exporting = false;

async function listFrames(pageId: string): Promise<void> {
  const page = host.pages.find((candidate) => candidate.id === pageId);
  if (!page) {
    post({ type: 'frames-error', pageId, message: 'This page no longer exists.' });
    return;
  }
  try {
    await page.loadAsync();
    const frames: FrameSummary[] = page.children
      .slice(0, MAX_LISTED_FRAMES)
      .map((node: NodeLike) => ({ id: node.id, name: node.name, type: node.type }));
    post({ type: 'frames', pageId, frames, total: page.children.length });
  } catch (error) {
    post({ type: 'frames-error', pageId, message: String(error) });
  }
}

async function runExport(message: Extract<UiToMain, { type: 'export' }>): Promise<void> {
  if (exporting) return;
  exporting = true;
  cancelRequested = false;

  const hooks: ExportHooks = {
    onProgress: (phase, done, total) => post({ type: 'progress', phase, done, total }),
    isCancelled: () => cancelRequested,
  };
  try {
    const data = await buildExport(host, message.selection, message.options, hooks);
    post({ type: 'export-result', data });
  } catch (error) {
    if (error instanceof ExportCancelled) post({ type: 'export-cancelled' });
    else post({ type: 'export-error', message: error instanceof Error ? error.message : String(error) });
  } finally {
    exporting = false;
  }
}

figma.showUI(__html__, { width: 360, height: 600, themeColors: true });

post({
  type: 'init',
  fileName: host.fileName,
  pages: host.pages.map((page) => ({ id: page.id, name: page.name })),
  currentPageId: figma.currentPage.id,
});

figma.ui.onmessage = (raw: unknown) => {
  const message = raw as UiToMain;
  switch (message.type) {
    case 'list-frames':
      void listFrames(message.pageId);
      break;
    case 'export':
      void runExport(message);
      break;
    case 'cancel':
      cancelRequested = true;
      break;
    case 'close':
      figma.closePlugin();
      break;
  }
};
