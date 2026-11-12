import type { ExportSelection } from '../host.js';

/** What the user has ticked, independent of the DOM. */
export class SelectionModel {
  /** Pages taken whole, including layers not shown in the list. */
  private readonly whole = new Set<string>();
  private readonly partial = new Map<string, Set<string>>();
  private readonly known = new Map<string, string[]>();

  setKnownFrames(pageId: string, frameIds: string[]): void {
    this.known.set(pageId, frameIds);
  }

  setPage(pageId: string, checked: boolean): void {
    this.partial.delete(pageId);
    if (checked) this.whole.add(pageId);
    else this.whole.delete(pageId);
  }

  pageState(pageId: string): 'all' | 'some' | 'none' {
    if (this.whole.has(pageId)) return 'all';
    return (this.partial.get(pageId)?.size ?? 0) > 0 ? 'some' : 'none';
  }

  isFrameChecked(pageId: string, frameId: string): boolean {
    return this.whole.has(pageId) || (this.partial.get(pageId)?.has(frameId) ?? false);
  }

  setFrame(pageId: string, frameId: string, checked: boolean): void {
    let frames = this.partial.get(pageId);
    if (this.whole.has(pageId)) {
      // Unticking one frame of a whole page turns it into an explicit list.
      this.whole.delete(pageId);
      frames = new Set(this.known.get(pageId) ?? []);
      this.partial.set(pageId, frames);
    } else if (!frames) {
      frames = new Set();
      this.partial.set(pageId, frames);
    }
    if (checked) frames.add(frameId);
    else frames.delete(frameId);
    if (frames.size === 0) this.partial.delete(pageId);
  }

  isEmpty(): boolean {
    return this.whole.size === 0 && this.partial.size === 0;
  }

  /** In document order, regardless of the order of ticks. */
  toSelection(pageOrder: readonly string[]): ExportSelection {
    const pages: ExportSelection['pages'] = [];
    for (const pageId of pageOrder) {
      if (this.whole.has(pageId)) {
        pages.push({ pageId, nodeIds: null });
        continue;
      }
      const frames = this.partial.get(pageId);
      if (!frames || frames.size === 0) continue;
      const order = this.known.get(pageId) ?? [];
      const nodeIds = order.filter((id) => frames.has(id));
      for (const id of frames) if (!nodeIds.includes(id)) nodeIds.push(id);
      pages.push({ pageId, nodeIds });
    }
    return { pages };
  }
}
