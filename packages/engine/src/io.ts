/**
 * Read/write the git-friendly `*.rangoli/` directory format (SPEC §3).
 * Stable key order + 2-space JSON so diffs stay small and readable.
 */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { RangoliDocument } from './document.js';
import { withLibrary } from './components.js';
import type { ComponentDef, DocumentData, Manifest, Page, TokenTree } from './model.js';
import { defaultMotion, type MotionDef } from './motion.js';
import type { PrototypeData, Timeline } from './prototype.js';
import { defaultIcons, type IconSet } from './icons.js';
import type { AssetMeta } from './images.js';

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

export async function saveDocument(doc: RangoliDocument, dir: string): Promise<void> {
  const d = doc.data;
  await mkdir(join(dir, 'pages'), { recursive: true });
  await mkdir(join(dir, 'assets'), { recursive: true });
  await writeFile(join(dir, 'manifest.json'), json(d.manifest));
  await writeFile(join(dir, 'tokens.json'), json(d.tokens));
  await writeFile(join(dir, 'components.json'), json(d.components));
  await writeFile(join(dir, 'motion.json'), json(d.motion ?? {}));
  await writeFile(join(dir, 'icons.json'), json(d.icons ?? {}));
  await writeFile(join(dir, 'assets.json'), json(d.assets ?? {}));
  await writeFile(join(dir, 'prototype.json'), json({ ...(d.prototype ?? { interactions: {} }), timelines: d.timelines ?? {} }));
  const keep = new Set<string>();
  for (const page of Object.values(d.pages)) {
    const file = `${page.id}.json`;
    keep.add(file);
    // sort nodes by id for stable diffs
    const nodes = Object.fromEntries(Object.entries(page.nodes).sort(([a], [b]) => a.length - b.length || a.localeCompare(b)));
    await writeFile(join(dir, 'pages', file), json({ ...page, nodes }));
  }
  for (const f of await readdir(join(dir, 'pages'))) if (f.endsWith('.json') && !keep.has(f)) await rm(join(dir, 'pages', f));
}

export async function loadDocument(dir: string): Promise<RangoliDocument> {
  if (!existsSync(join(dir, 'manifest.json'))) throw new Error(`Not a Rangoli document (no manifest.json): ${dir}`);
  const read = async <T>(f: string, fallback: T): Promise<T> => (existsSync(join(dir, f)) ? (JSON.parse(await readFile(join(dir, f), 'utf8')) as T) : fallback);
  const manifest = await read<Manifest>('manifest.json', undefined as unknown as Manifest);
  if (manifest.format !== 'rangoli@1') throw new Error(`Unsupported format ${manifest.format}`);
  const tokens = await read<TokenTree>('tokens.json', {});
  const components = withLibrary(await read<Record<string, ComponentDef>>('components.json', {}));
  const pages: Record<string, Page> = {};
  for (const p of manifest.pages) pages[p.id] = await read<Page>(join('pages', `${p.id}.json`), { id: p.id, name: p.name, children: [], nodes: {} });
  // documents created before motion existed get the default component motion
  const motion = existsSync(join(dir, 'motion.json')) ? await read<Record<string, MotionDef>>('motion.json', {}) : defaultMotion();
  const proto = await read<PrototypeData & { timelines?: Record<string, Timeline> }>('prototype.json', { interactions: {} });
  const { timelines, ...prototype } = proto;
  // documents created before icons existed get the starter set
  const icons = existsSync(join(dir, 'icons.json')) ? await read<Record<string, IconSet>>('icons.json', {}) : defaultIcons();
  const data: DocumentData = { manifest, tokens, components, pages, motion, prototype: { ...prototype, interactions: prototype.interactions ?? {} }, timelines: timelines ?? {}, icons, assets: await read<Record<string, AssetMeta>>('assets.json', {}) };
  return new RangoliDocument(data);
}
