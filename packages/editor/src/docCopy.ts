/**
 * Copy-on-write document copy for applying one committed change in the editor store.
 *
 * The store keeps every document version immutable (compare views and memoized panels hold the old one),
 * so it used to structuredClone the whole document per change: about 25 ms at 5,000 layers, more than the
 * whole frame-patch budget. This copies only what the change's ops can write: the containers they write
 * into (shallow) and the objects they mutate in place (deep). Everything else is shared with the previous
 * version, which no one mutates.
 *
 * What each op writes is read from RangoliDocument.applyOne (eng/document.ts); `touched` is the change's
 * own list, which names every node an op mutates or removes, including parents whose children change.
 */
import type { DocumentData, Op, Page } from '@rangoli/engine';

export function copyForChange(data: DocumentData, ops: readonly Op[], touched: readonly string[]): DocumentData {
  const out: DocumentData = { ...data };
  const defaultPage = data.manifest.pages[0]?.id;
  let pages: DocumentData['pages'] | undefined;
  const copiedPages = new Set<string>();
  const copyPage = (id: string | undefined): void => {
    const key = id ?? defaultPage;
    if (key === undefined || copiedPages.has(key) || !Object.hasOwn(data.pages, key)) return;
    pages ??= out.pages = { ...data.pages };
    const p = data.pages[key]!;
    const copy: Page = { ...p, children: [...p.children], nodes: { ...p.nodes } };
    // every node the change names, and the parents a create or restore inserts into, is copied deeply
    const deep = new Set<string>(touched);
    for (const op of ops) if ((op.op === 'create' || op.op === 'restore' || op.op === 'move') && op.parent) deep.add(op.parent);
    for (const op of ops) if (op.op === 'move' && Object.hasOwn(p.nodes, op.id)) { const from = p.nodes[op.id]!.parent; if (from) deep.add(from); }
    for (const nid of deep) if (Object.hasOwn(p.nodes, nid)) copy.nodes[nid] = structuredClone(p.nodes[nid]!);
    pages[key] = copy;
    copiedPages.add(key);
  };
  for (const op of ops) {
    switch (op.op) {
      case 'create': case 'update': case 'patch': case 'delete': case 'move': case 'restore':
        copyPage(op.page);
        break;
      case 'setTokens': case 'patchTokens':
        if (out.tokens === data.tokens) out.tokens = structuredClone(data.tokens);
        break;
      case 'setComponent': case 'deleteComponent':
        if (out.components === data.components) out.components = { ...data.components };
        break;
      case 'setMotion':
        if (data.motion && out.motion === data.motion) out.motion = { ...data.motion };
        break;
      case 'setInteractions': case 'setProtoStart': case 'setProtoVars':
        if (data.prototype && out.prototype === data.prototype) out.prototype = { ...data.prototype, interactions: { ...data.prototype.interactions } };
        break;
      case 'setTimeline':
        if (data.timelines && out.timelines === data.timelines) out.timelines = { ...data.timelines };
        break;
      case 'setIconSet': case 'setIcon':
        // setIcon writes inside a set: copy the sets map and every set (a handful), so no shared set is mutated
        if (data.icons && out.icons === data.icons) out.icons = Object.fromEntries(Object.entries(data.icons).map(([k, v]) => [k, { ...v, icons: { ...v.icons } }]));
        break;
      case 'setAsset':
        if (data.assets && out.assets === data.assets) out.assets = { ...data.assets };
        break;
      default: {
        // an op this copy does not know: fall back to a full copy rather than risk sharing what it writes
        const never: never = op;
        void never;
        return structuredClone(data);
      }
    }
  }
  return out;
}
