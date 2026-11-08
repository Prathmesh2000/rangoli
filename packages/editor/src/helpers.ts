import { TokenResolver, isTokenRef, serializeRdl, type Len, type Paint, type RangoliDocument, type RNode } from '@rangoli/engine';

export const indent = (s: string, by = '  ') => s.split('\n').map((l) => by + l).join('\n');

/** Remove #ids from RDL heads so the block can be re-created as new nodes (duplicate/paste). */
export const stripIds = (s: string) => s.replace(/^(\s*@?[^\s#"]+)#[0-9a-z]+/gm, '$1');

export function duplicateScript(doc: RangoliDocument, id: string): string {
  const block = stripIds(serializeRdl(doc, { roots: [id] }));
  return `insert #${id} after\n${indent(block)}`;
}

export interface Opt {
  value: string;
  label: string;
  swatch?: string;
}

export function tokenOptions(doc: RangoliDocument, mode: string) {
  const r = new TokenResolver(doc.data.tokens);
  const step = (group: string) =>
    r.group(group).map((t) => {
      const key = t.path.slice(group.length + 1);
      return { value: key, label: `${key} · ${r.resolve(t.path)}px` };
    });
  const semantic: Opt[] = [];
  const ramps: Opt[] = [];
  for (const t of r.group('color')) {
    const v = r.resolve(t.path, mode);
    if (typeof v !== 'string' || !v.startsWith('#')) continue;
    const short = r.shortName(t.path, 'color');
    (/\.\d+$/.test(t.path) || t.path === 'color.white' ? ramps : semantic).push({ value: short, label: short, swatch: v });
  }
  return {
    space: step('space'),
    radius: step('radius'),
    textStyles: r.group('textStyle').map((t) => {
      const v = r.resolve(t.path) as { fontSize?: number; fontWeight?: number };
      const key = t.path.slice('textStyle.'.length);
      return { value: key, label: `${key} · ${v.fontSize ?? ''}/${v.fontWeight ?? ''}` };
    }),
    shadows: r.group('shadow').map((t) => ({ value: t.path.slice('shadow.'.length), label: t.path.slice('shadow.'.length) })),
    colors: [...semantic, ...ramps],
    resolver: r,
  };
}

/** Current value of a Len as the RDL step name or "<n>px". */
export function lenValue(v: Len | undefined, group: string): string {
  if (v === undefined) return '';
  if (isTokenRef(v)) return v.token.startsWith(`${group}.`) ? v.token.slice(group.length + 1) : v.token;
  return `${v}px`;
}

export function paintValue(p: Paint | undefined, r: TokenResolver): string {
  if (!p) return '';
  if (isTokenRef(p)) return r.shortName(p.token, 'color');
  if ('hex' in p) return p.hex;
  return 'gradient';
}

export function resolvePaintHex(p: Paint | undefined, r: TokenResolver, mode: string): string | undefined {
  if (!p) return undefined;
  if (isTokenRef(p)) {
    const v = r.resolve(p.token, mode);
    return typeof v === 'string' ? v : undefined;
  }
  return 'hex' in p ? p.hex : undefined;
}

export const TYPE_GLYPH: Record<RNode['type'], string> = {
  frame: '▢',
  text: 'T',
  vector: '◇',
  image: '▨',
  instance: '◈',
  group: '⊞',
};
