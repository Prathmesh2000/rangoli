import { EXPORT_FORMAT, LIMITS, SCHEMA_VERSION } from '../limits.js';
import type { ExportHooks, ExportOptions, ExportSelection, FigmaHost, NodeLike, PageLike } from '../host.js';
import type {
  ExportCatalogComponent,
  ExportPage,
  ExportRoot,
  FigmaExport,
} from '../schema.js';
import {
  collectImages,
  collectPreviews,
  collectStyles,
  collectVariables,
  findPage,
  mapCatalogComponent,
} from './catalog.js';
import { ExtractContext, describe, isId, isRecord } from './context.js';
import { mapNode } from './node.js';
import { mapPaints } from './paint.js';

export const PLUGIN_VERSION = '0.1.0';

export class ExportCancelled extends Error {
  constructor() {
    super('Export cancelled');
    this.name = 'ExportCancelled';
  }
}

/** Keeps the walk responsive without yielding on every layer. */
const YIELD_EVERY = 250;

type RootEntry = ExportRoot & { node: NodeLike };

class Walker {
  private sinceYield = 0;

  constructor(
    readonly ctx: ExtractContext,
    readonly host: FigmaHost,
    readonly hooks: ExportHooks,
  ) {}

  checkCancelled(): void {
    if (this.hooks.isCancelled?.()) throw new ExportCancelled();
  }

  async pause(): Promise<void> {
    await this.host.yieldToEventLoop();
    this.checkCancelled();
  }

  /** Iterative pre-order, so deep trees can't overflow the sandbox stack. */
  async walk(root: NodeLike, pageId: string): Promise<boolean> {
    const { ctx } = this;
    if (ctx.walked.has(root.id)) return false;

    const stack: { node: NodeLike; parent: NodeLike | null; depth: number }[] = [
      { node: root, parent: null, depth: 0 },
    ];
    while (stack.length > 0) {
      if (ctx.nodes.length >= LIMITS.maxNodes) {
        ctx.complete = false;
        ctx.gap(
          'node-limit-reached',
          'error',
          `Stopped at the ${LIMITS.maxNodes} layer limit; remaining layers are not in this export. Choose fewer frames.`,
          { nodeId: root.id, pageId },
        );
        return true;
      }

      const { node, parent, depth } = stack.pop()!;
      if (!isId(node.id)) {
        ctx.gap('invalid-node-id', 'error', 'A layer had an unexpected id and was left out.', { pageId });
        continue;
      }
      if (ctx.walked.has(node.id)) continue;
      ctx.walked.add(node.id);

      ctx.nodes.push(await mapNode(ctx, node, parent ? parent.id : null, parent, pageId));

      const children = ctx.read(node, 'children', node.id);
      if (Array.isArray(children) && children.length > 0) {
        if (depth >= LIMITS.maxDepth) {
          ctx.complete = false;
          ctx.gap('depth-limit-reached', 'error', `${children.length} child layers past the depth limit were left out.`, {
            nodeId: node.id,
          });
        } else {
          for (let i = children.length - 1; i >= 0; i -= 1) {
            stack.push({ node: children[i] as NodeLike, parent: node, depth: depth + 1 });
          }
        }
      }

      this.sinceYield += 1;
      if (this.sinceYield >= YIELD_EVERY) {
        this.sinceYield = 0;
        this.hooks.onProgress?.('layers', ctx.nodes.length, null);
        await this.pause();
      }
    }
    return true;
  }
}

/**
 * Pulls in local main components the selection doesn't contain, so instances
 * resolve to editable definitions. Walking one can reveal more instances, so
 * this loops until nothing new appears.
 */
async function walkComponentDefinitions(
  walker: Walker,
  roots: RootEntry[],
  pagesById: Map<string, PageLike>,
  addPage: (page: NodeLike, wholePage: boolean) => void,
): Promise<ExportCatalogComponent[]> {
  const { ctx } = walker;
  const catalog = new Map<string, ExportCatalogComponent>();

  for (;;) {
    const pending = [...ctx.componentNodes.values()].filter((node) => !catalog.has(node.id));
    if (pending.length === 0) break;

    for (const component of pending) {
      walker.checkCancelled();

      if (ctx.read(component, 'remote', component.id) === true) {
        ctx.gap(
          'remote-component-definition',
          'info',
          'Library component: its main definition is not exported; instances keep their rendered layers.',
          { nodeId: component.id },
        );
        catalog.set(component.id, mapCatalogComponent(ctx, component, 'metadata-only'));
        continue;
      }

      const parent = ctx.read(component, 'parent', component.id);
      const owner =
        isRecord(parent) && parent['type'] === 'COMPONENT_SET' ? (parent as NodeLike) : component;

      let captured = ctx.walked.has(component.id);
      if (!captured) {
        const page = findPage(ctx, component);
        if (!page || !isId(page.id)) {
          ctx.gap('component-definition-unavailable', 'warning', 'Component is not on any page; only its metadata was kept.', {
            nodeId: component.id,
          });
        } else {
          try {
            await (pagesById.get(page.id) ?? (page as PageLike)).loadAsync();
            addPage(page, false);
            if (roots.length >= LIMITS.maxRoots) {
              ctx.gap('root-limit-reached', 'error', 'Too many top-level layers; this component definition was left out.', {
                nodeId: component.id,
              });
            } else if (await walker.walk(owner, page.id)) {
              roots.push({ nodeId: owner.id, pageId: page.id, origin: 'component-definition', node: owner });
            }
            captured = ctx.walked.has(component.id);
          } catch (error) {
            if (error instanceof ExportCancelled) throw error;
            ctx.gap('component-definition-unavailable', 'warning', `Component definition could not be read: ${describe(error)}`, {
              nodeId: component.id,
            });
          }
        }
      }
      catalog.set(component.id, mapCatalogComponent(ctx, component, captured ? 'captured' : 'metadata-only'));
    }
  }

  return [...catalog.values()];
}

export async function buildExport(
  host: FigmaHost,
  selection: ExportSelection,
  options: ExportOptions,
  hooks: ExportHooks = {},
  now: () => Date = () => new Date(),
): Promise<FigmaExport> {
  const ctx = new ExtractContext();
  const walker = new Walker(ctx, host, hooks);

  const pagesById = new Map<string, PageLike>(host.pages.map((page) => [page.id, page]));
  const pages = new Map<string, ExportPage>();
  const addPage = (page: NodeLike, wholePage: boolean) => {
    const existing = pages.get(page.id);
    if (existing) {
      existing.wholePage ||= wholePage;
      return;
    }
    const backgrounds = mapPaints(ctx, ctx.read(page, 'backgrounds', page.id), undefined);
    pages.set(page.id, {
      id: page.id,
      name: ctx.name(page.name),
      wholePage,
      ...(backgrounds && backgrounds.length > 0 && { backgrounds }),
    });
  };

  const roots: RootEntry[] = [];
  const addRoot = async (node: NodeLike, pageId: string) => {
    if (roots.length >= LIMITS.maxRoots) {
      ctx.complete = false;
      ctx.gap('root-limit-reached', 'error', `Stopped at ${LIMITS.maxRoots} top-level layers.`, {
        nodeId: node.id,
        pageId,
      });
      return;
    }
    if (await walker.walk(node, pageId)) {
      roots.push({ nodeId: node.id, pageId, origin: 'selected', node });
    }
  };

  for (const chosen of selection.pages) {
    walker.checkCancelled();
    const page = pagesById.get(chosen.pageId);
    if (!page) {
      ctx.gap('selection-not-found', 'error', 'A chosen page no longer exists in this file.', {
        field: chosen.pageId,
      });
      continue;
    }

    try {
      await page.loadAsync();
    } catch (error) {
      ctx.gap('page-load-failed', 'error', `Page could not be loaded: ${describe(error)}`, { pageId: page.id });
      continue;
    }

    addPage(page, chosen.nodeIds === null);
    const topLevel = page.children;

    if (chosen.nodeIds === null) {
      for (const node of topLevel) await addRoot(node, page.id);
      continue;
    }
    const byId = new Map(topLevel.map((node) => [node.id, node]));
    for (const nodeId of chosen.nodeIds) {
      const node = byId.get(nodeId);
      if (node) await addRoot(node, page.id);
      else {
        ctx.gap('selection-not-found', 'error', 'A chosen frame no longer exists on its page.', {
          pageId: page.id,
          field: nodeId,
        });
      }
    }
  }

  hooks.onProgress?.('components', 0, ctx.componentNodes.size);
  const components = (await walkComponentDefinitions(walker, roots, pagesById, addPage)).slice(
    0,
    LIMITS.maxComponents,
  );
  if (ctx.componentNodes.size > LIMITS.maxComponents) {
    ctx.gap('components-truncated', 'error', `Only the first ${LIMITS.maxComponents} components were kept.`);
  }

  // A truncated catalog must not leave instances pointing at nothing.
  const catalogIds = new Set(components.map((component) => component.id));
  for (const node of ctx.nodes) {
    if (node.instance?.mainComponentId && !catalogIds.has(node.instance.mainComponentId)) {
      node.instance.mainComponentId = null;
    }
  }

  hooks.onProgress?.('variables', 0, null);
  await walker.pause();
  const variables = await collectVariables(ctx, host);

  hooks.onProgress?.('styles', 0, null);
  await walker.pause();
  const styles = await collectStyles(ctx, host);

  const images = await collectImages(ctx, host, options.includeImages, async (done, total) => {
    hooks.onProgress?.('images', done, total);
    await walker.pause();
  });

  const selectedRoots = roots.filter((root) => root.origin === 'selected');
  let previews: FigmaExport['previews'] = [];
  if (options.includePreviews) {
    previews = await collectPreviews(ctx, host, selectedRoots, async (done, total) => {
      hooks.onProgress?.('previews', done, total);
      await walker.pause();
    });
  } else if (selectedRoots.length > 0) {
    ctx.gap('previews-excluded', 'info', 'Frame previews were left out at the user\'s choice; pixel comparison is unavailable.');
  }

  if (host.fileKey === null) {
    ctx.gap('file-key-unavailable', 'info', 'Figma only exposes the file key to private plugins; the import token identifies the project.');
  }

  let textNodes = 0;
  let instances = 0;
  let vectorNodes = 0;
  for (const node of ctx.nodes) {
    if (node.text) textNodes += 1;
    if (node.instance) instances += 1;
    if (node.vector) vectorNodes += 1;
  }

  return {
    format: EXPORT_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now().toISOString(),
    source: {
      fileName: ctx.name(host.fileName),
      fileKey: host.fileKey,
      editorType: host.editorType,
      pluginVersion: PLUGIN_VERSION,
    },
    pages: [...pages.values()],
    roots: roots.map(({ nodeId, pageId, origin }) => ({ nodeId, pageId, origin })),
    nodes: ctx.nodes,
    components,
    variables,
    styles,
    fonts: [...ctx.fonts.values()],
    images,
    previews,
    gaps: ctx.gaps,
    gapSummary: [...ctx.gapCounts.entries()].map(([code, value]) => ({
      code,
      severity: value.severity,
      count: value.count,
    })),
    stats: { nodes: ctx.nodes.length, textNodes, instances, vectorNodes, complete: ctx.complete },
  };
}
