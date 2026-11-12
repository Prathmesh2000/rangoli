import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createDocument } from './components.js';
import type { ComponentDef, DocumentData, Page, RNode, TokenTree } from './model.js';
import { applyRdl } from './rdl.js';
import { CANON_VERSION, canonicalize, hashCanonical, hashLibrary, hashNodes, hashScreen, hashSnapshot, listScreens, screenDepsScanner, sha256Hex } from './snapshot-hash.js';

function randomSource(seed: number) {
  let state = seed >>> 0;
  return (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor(((state >>> 8) / 0x1000000) * limit);
  };
}

/** Rebuilds a value with every object's keys in a random order. */
function shuffleKeys<T>(value: T, random: (limit: number) => number): T {
  if (Array.isArray(value)) return value.map((item) => shuffleKeys(item, random)) as T;
  if (typeof value !== 'object' || value === null) return value;
  const entries = Object.entries(value);
  for (let i = entries.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [entries[i], entries[j]] = [entries[j]!, entries[i]!];
  }
  return Object.fromEntries(entries.map(([key, inner]) => [key, shuffleKeys(inner, random)])) as T;
}

const color = (value: string, dark?: string) => ({ $value: value, $type: 'color', ...(dark ? { $extensions: { rangoli: { modes: { dark } } } } : {}) });

function frame(id: string, children: string[] = [], extra: Partial<RNode> = {}): RNode {
  return { id, type: 'frame', name: id, children, ...extra };
}

function makeDoc(): DocumentData {
  const nodes: Record<string, RNode> = {
    direct: frame('direct', [], { style: { fill: [{ token: 'color.brand' }] } }),
    aliased: frame('aliased', [], { style: { color: { token: 'color.alias' } } }),
    viaComp: frame('viaComp', ['btn']),
    btn: { id: 'btn', type: 'instance', name: 'Button', parent: 'viaComp', component: 'Btn', variant: { tone: 'solid' } },
    viaCss: frame('viaCss', [], { style: { css: 'outline:1px solid var(--color-outline)' } }),
    viaIcon: { id: 'viaIcon', type: 'vector', name: 'Glyph', icon: 'set1/star' },
    viaAsset: frame('viaAsset', [], { image: { asset: 'img1' } }),
    plain: frame('plain', [], { text: 'nothing here' }),
    moving: frame('moving', ['childA', 'childB']),
    childA: frame('childA', [], { parent: 'moving', position: { x: 1, y: 2 } }),
    childB: frame('childB', [], { parent: 'moving' }),
  };
  const children = ['direct', 'aliased', 'viaComp', 'viaCss', 'viaIcon', 'viaAsset', 'plain', 'moving'];
  const tokens = {
    color: {
      brand: color('#112233', '#445566'),
      alias: { $value: '{color.base}', $type: 'color' },
      base: color('#010203'),
      comp: color('#aa0000'),
      outline: color('#00aa00'),
      iconTint: color('#0000aa'),
      unused: color('#999999'),
      bg: { canvas: color('#ffffff') },
      text: { primary: color('#000000') },
    },
    textStyle: { body: { $value: { fontSize: 14 }, $type: 'typography' } },
  } as unknown as TokenTree;
  const components: Record<string, ComponentDef> = {
    Btn: { id: 'Btn', name: 'Button', axes: { tone: ['solid'] }, defaults: { tone: 'solid' }, styles: [{ when: {}, style: { fill: [{ token: 'color.comp' }] } }] },
  };
  return {
    manifest: { format: 'rangoli@1', name: 'Doc', pages: [{ id: 'p1', name: 'One' }] },
    tokens,
    pages: { p1: { id: 'p1', name: 'One', children, nodes } },
    components,
    motion: {},
    icons: { set1: { name: 'set1', grid: 24, stroke: 2, cap: 'round', join: 'round', icons: { star: { name: 'star', src: 'circle 12 12 8 c=iconTint' } } } },
    assets: { img1: { id: 'img1', name: 'Hero', file: 'abc.png', mime: 'image/png', w: 10, h: 10, bytes: 100, source: 'upload' } },
  };
}

const hashesOf = (data: DocumentData, options = {}) => Object.fromEntries(hashSnapshot(data, options).screens.map((s) => [s.root, s.hash]));

function changedRoots(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys({ ...before, ...after }).filter((root) => before[root] !== after[root]).sort();
}

function changesOf(edit: (data: DocumentData) => void): string[] {
  const data = makeDoc();
  const before = hashesOf(data);
  edit(data);
  return changedRoots(before, hashesOf(data));
}

const setToken = (data: DocumentData, path: string, value: unknown) => {
  let at = data.tokens as unknown as Record<string, Record<string, unknown>>;
  const parts = path.split('.');
  for (const part of parts.slice(0, -1)) at = at[part] as unknown as Record<string, Record<string, unknown>>;
  at[parts[parts.length - 1]!]!.$value = value;
};

describe('sha256Hex', () => {
  it('matches published vectors', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  });

  it('matches node:crypto around block boundaries and on multibyte text', () => {
    const oracle = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    const lengths = [1, 54, 55, 56, 57, 63, 64, 65, 118, 119, 120, 127, 128, 129, 1000, 4096];
    for (const length of lengths) expect(sha256Hex('x'.repeat(length))).toBe(oracle('x'.repeat(length)));
    const random = randomSource(42);
    const alphabet = ['a', 'Z', '0', ' ', '\n', 'é', 'ñ', 'क', 'ಕ', '🪔', '漢'];
    for (let run = 0; run < 300; run++) {
      const text = Array.from({ length: random(200) }, () => alphabet[random(alphabet.length)]!).join('');
      expect(sha256Hex(text)).toBe(oracle(text));
    }
  });
});

describe('canonicalize', () => {
  it('sorts keys at every depth', () => {
    expect(canonicalize({ b: 1, a: { d: [{ z: 1, y: 2 }], c: 2 } })).toBe('{"a":{"c":2,"d":[{"y":2,"z":1}]},"b":1}');
  });

  it('keeps array order', () => {
    expect(canonicalize([2, 1])).not.toBe(canonicalize([1, 2]));
  });

  it('normalizes numbers', () => {
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(0.1 + 0.2)).toBe('0.3');
    expect(canonicalize(1.0)).toBe('1');
    expect(canonicalize(-1.5)).toBe('-1.5');
    expect(canonicalize(1e21)).toBe('1e+21');
  });

  it('is unchanged by rounding a value that is already normalized', () => {
    const random = randomSource(5);
    for (let run = 0; run < 500; run++) {
      const n = (random(2_000_000) - 1_000_000) / (1 + random(999));
      const text = canonicalize(n);
      expect(canonicalize(Number(text))).toBe(text);
    }
  });

  it('drops undefined fields and writes null for undefined array items', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalize([undefined])).toBe('[null]');
  });

  it('handles a __proto__ key as ordinary data', () => {
    const value = JSON.parse('{"__proto__":{"x":1},"a":2}') as unknown;
    expect(canonicalize(value)).toBe('{"__proto__":{"x":1},"a":2}');
  });

  it.each([[Number.NaN], [Number.POSITIVE_INFINITY], [() => 1], [Symbol('x')], [10n], [new Date(0)], [new Map()]])('rejects %s', (value) => {
    expect(() => canonicalize(value)).toThrow(TypeError);
  });

  it('rejects a value containing itself, but allows a shared value', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalize(loop)).toThrow(TypeError);
    const shared = { a: 1 };
    expect(canonicalize([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });
});

describe('hashCanonical', () => {
  it('gives the same content under different domains different hashes', () => {
    expect(hashCanonical('a', 1)).not.toBe(hashCanonical('b', 1));
  });

  it('binds the canon version', () => {
    expect(CANON_VERSION).toBe('rangoli-canon@1');
    expect(hashCanonical('node', { a: 1 })).toBe(sha256Hex('rangoli-canon@1\nnode\n{"a":1}'));
  });

  it('accepts a pluggable hasher', () => {
    const hasher = vi.fn((text: string) => `h(${text.length})`);
    expect(hashCanonical('x', 1, hasher)).toMatch(/^h\(/);
    const result = hashSnapshot(makeDoc(), { hasher });
    expect(result.contentHash).toMatch(/^h\(/);
    expect(result.screens[0]!.hash).toMatch(/^h\(/);
  });
});

describe('key order never affects a hash', () => {
  it('holds for random reorderings of a whole document', () => {
    const data = makeDoc();
    const expected = hashSnapshot(data);
    const random = randomSource(11);
    for (let run = 0; run < 25; run++) expect(hashSnapshot(shuffleKeys(data, random))).toEqual(expected);
  });

  it('holds for random JSON values', () => {
    const random = randomSource(77);
    const value = (depth: number): unknown => {
      const kind = random(depth > 3 ? 4 : 6);
      if (kind === 0) return random(1000) / 8;
      if (kind === 1) return `s${random(50)}`;
      if (kind === 2) return random(2) === 0;
      if (kind === 3) return null;
      if (kind === 4) return Array.from({ length: random(4) }, () => value(depth + 1));
      return Object.fromEntries(Array.from({ length: random(5) }, (_, i) => [`k${i}`, value(depth + 1)]));
    };
    for (let run = 0; run < 300; run++) {
      const v = value(0);
      expect(canonicalize(shuffleKeys(v, random))).toBe(canonicalize(v));
    }
  });
});

describe('a token edit changes exactly the screens that use it', () => {
  const screensUsing: [string, string[]][] = [
    ['color.brand', ['direct']],
    ['color.base', ['aliased']],
    ['color.alias', ['aliased']],
    ['color.comp', ['viaComp']],
    ['color.outline', ['viaCss']],
    ['color.iconTint', ['viaIcon']],
    ['color.unused', []],
  ];

  it.each(screensUsing)('%s reaches %j', (path, expected) => {
    expect(changesOf((data) => setToken(data, path, '#123abc'))).toEqual(expected);
  });

  it('counts the shell tokens as used by every screen', () => {
    const all = listScreens(makeDoc()).map((s) => s.root).sort();
    expect(changesOf((data) => setToken(data, 'color.bg.canvas', '#fefefe'))).toEqual(all);
    expect(changesOf((data) => setToken(data, 'textStyle.body', { fontSize: 15 }))).toEqual(all);
  });

  it('sees a change in one mode only', () => {
    expect(
      changesOf((data) => {
        (data.tokens as any).color.brand.$extensions.rangoli.modes.dark = '#000001';
      }),
    ).toEqual(['direct']);
  });

  it('sees a mode added further down an alias chain', () => {
    expect(
      changesOf((data) => {
        (data.tokens as any).color.base.$extensions = { rangoli: { modes: { dark: '#fafafa' } } };
      }),
    ).toEqual(['aliased']);
  });

  it('ignores a retargeted alias that resolves to the same value', () => {
    expect(
      changesOf((data) => {
        (data.tokens as any).color.other = color('#010203');
        (data.tokens as any).color.alias.$value = '{color.other}';
      }),
    ).toEqual([]);
  });

  it('ignores descriptions', () => {
    expect(
      changesOf((data) => {
        (data.tokens as any).color.brand.$description = 'Brand colour';
      }),
    ).toEqual([]);
  });

  it('is untouched by an unrelated new token or new mode', () => {
    expect(
      changesOf((data) => {
        (data.tokens as any).color.fresh = color('#111111', '#222222');
        (data.tokens as any).color.other = { $value: '#333333', $type: 'color', $extensions: { rangoli: { modes: { sepia: '#444444' } } } };
      }),
    ).toEqual([]);
  });

  it('sees a referenced token appear when it was missing', () => {
    const data = makeDoc();
    data.pages.p1!.nodes.plain!.style = { fill: [{ token: 'color.late' }] };
    const before = hashesOf(data);
    (data.tokens as any).color.late = color('#abcdef');
    expect(changedRoots(before, hashesOf(data))).toEqual(['plain']);
  });

  it('survives an alias cycle without throwing, and still sees it change', () => {
    const data = makeDoc();
    (data.tokens as any).color.alias.$value = '{color.alias}';
    const before = hashesOf(data);
    (data.tokens as any).color.alias.$value = '{color.base}';
    expect(changedRoots(before, hashesOf(data))).toEqual(['aliased']);
  });

  it('holds across random documents and random token edits', () => {
    const random = randomSource(2024);
    for (let run = 0; run < 40; run++) {
      const count = 3 + random(10);
      const paths = Array.from({ length: count }, (_, i) => `t${i}`);
      const tokens: Record<string, unknown> = { color: { bg: { canvas: color('#fff') }, text: { primary: color('#000') } }, textStyle: { body: { $value: { fontSize: 14 }, $type: 'typography' } } };
      const group: Record<string, unknown> = {};
      const aliasOf = new Map<string, string>();
      paths.forEach((path, i) => {
        if (i > 0 && random(3) === 0) {
          const target = paths[random(i)]!;
          aliasOf.set(path, target);
          group[path] = { $value: `{g.${target}}`, $type: 'color' };
        } else {
          group[path] = color(`#${String(100000 + i)}`);
        }
      });
      tokens.g = group;

      const components: Record<string, ComponentDef> = {};
      paths.forEach((path, i) => {
        if (random(2) === 0) components[`C${i}`] = { id: `C${i}`, name: `C${i}`, axes: {}, defaults: {}, styles: [{ when: {}, style: { color: { token: `g.${path}` } } }] };
      });
      const componentIds = Object.keys(components);

      const nodes: Record<string, RNode> = {};
      const children: string[] = [];
      const uses = new Map<string, Set<string>>();
      const use = (root: string, path: string) => {
        let chain: string | undefined = path;
        let set = uses.get(root);
        if (!set) uses.set(root, (set = new Set()));
        while (chain) {
          set.add(chain);
          chain = aliasOf.get(chain);
        }
      };
      for (let s = 0; s < 3 + random(8); s++) {
        const root = `s${s}`;
        const kids: string[] = [];
        uses.set(root, new Set());
        for (let n = 0; n < random(5); n++) {
          const id = `${root}n${n}`;
          kids.push(id);
          if (componentIds.length && random(3) === 0) {
            const comp = componentIds[random(componentIds.length)]!;
            nodes[id] = { id, type: 'instance', name: id, parent: root, component: comp };
            use(root, (components[comp]!.styles[0]!.style.color as { token: string }).token.slice(2));
          } else {
            const path = paths[random(paths.length)]!;
            nodes[id] = { id, type: 'frame', name: id, parent: root, style: { fill: [{ token: `g.${path}` }] } };
            use(root, path);
          }
        }
        nodes[root] = { id: root, type: 'frame', name: root, children: kids };
        children.push(root);
      }

      const data: DocumentData = {
        manifest: { format: 'rangoli@1', name: 'R', pages: [{ id: 'p', name: 'P' }] },
        tokens: tokens as unknown as TokenTree,
        pages: { p: { id: 'p', name: 'P', children, nodes } },
        components,
      };

      const before = hashesOf(data);
      const concrete = paths.filter((path) => !aliasOf.has(path));
      const edited = concrete[random(concrete.length)]!;
      const mutated = structuredClone(data);
      ((mutated.tokens as any).g[edited] as { $value: string }).$value = '#abcdef';
      const expected = [...uses].filter(([, set]) => set.has(edited)).map(([root]) => root).sort();
      expect(changedRoots(before, hashesOf(mutated))).toEqual(expected);
    }
  });
});

describe('the rest of the closure', () => {
  it('sees a component definition change', () => {
    expect(
      changesOf((data) => {
        data.components.Btn!.styles.push({ when: { tone: 'solid' }, style: { opacity: 0.5 } });
      }),
    ).toEqual(['viaComp']);
  });

  it('ignores a component description', () => {
    expect(
      changesOf((data) => {
        data.components.Btn!.description = 'A button';
      }),
    ).toEqual([]);
  });

  it('follows nested components through templates', () => {
    const data = makeDoc();
    data.components.Wrap = {
      id: 'Wrap',
      name: 'Wrap',
      axes: {},
      defaults: {},
      styles: [],
      template: { root: 'r', nodes: { r: { id: 'r', type: 'instance', name: 'inner', component: 'Btn' } } },
    };
    data.pages.p1!.nodes.plain!.component = 'Wrap';
    const before = hashesOf(data);
    setToken(data, 'color.comp', '#00ff00');
    expect(changedRoots(before, hashesOf(data))).toEqual(['plain', 'viaComp']);
  });

  it('survives components that include each other', () => {
    const data = makeDoc();
    const inner = (component: string): RNode => ({ id: 'r', type: 'instance', name: 'x', component });
    data.components.A = { id: 'A', name: 'A', axes: {}, defaults: {}, styles: [], template: { root: 'r', nodes: { r: inner('B') } } };
    data.components.B = { id: 'B', name: 'B', axes: {}, defaults: {}, styles: [], template: { root: 'r', nodes: { r: inner('A') } } };
    data.pages.p1!.nodes.plain!.component = 'A';
    expect(() => hashSnapshot(data)).not.toThrow();
  });

  it('sees an icon edit, and leaves other icons out', () => {
    expect(
      changesOf((data) => {
        data.icons!.set1!.icons.star!.src = 'circle 12 12 6 c=iconTint';
      }),
    ).toEqual(['viaIcon']);
    expect(
      changesOf((data) => {
        data.icons!.set1!.icons.moon = { name: 'moon', src: 'circle 1 1 1' };
      }),
    ).toEqual([]);
  });

  it('sees an icon set stroke change', () => {
    expect(
      changesOf((data) => {
        data.icons!.set1!.stroke = 3;
      }),
    ).toEqual(['viaIcon']);
  });

  it('sees the full asset hash and the asset metadata, but not the label', () => {
    const data = makeDoc();
    const before = hashesOf(data, { assetHashes: { img1: 'a'.repeat(64) } });
    expect(changedRoots(before, hashesOf(data, { assetHashes: { img1: 'b'.repeat(64) } }))).toEqual(['viaAsset']);
    expect(
      changesOf((d) => {
        d.assets!.img1!.alt = 'Hero image';
      }),
    ).toEqual(['viaAsset']);
    expect(
      changesOf((d) => {
        d.assets!.img1!.name = 'Renamed';
      }),
    ).toEqual([]);
  });

  it('finds assets used as background paints and as image props', () => {
    const data = makeDoc();
    data.assets!.bg = { ...data.assets!.img1!, id: 'bg', file: 'bg.png' };
    data.pages.p1!.nodes.plain!.style = { fill: [{ image: { asset: 'bg', fit: 'cover' } }] };
    data.pages.p1!.nodes.direct!.props = { src: 'bg' };
    const before = hashesOf(data);
    data.assets!.bg!.w = 99;
    expect(changedRoots(before, hashesOf(data))).toEqual(['direct', 'plain']);
  });

  it('sees motion on a used component or a node in the screen only', () => {
    const spec = { trigger: 'hover', tracks: [{ prop: 'opacity', to: '0.5' }], duration: 'fast', easing: 'out' };
    expect(
      changesOf((data) => {
        data.motion!['@Btn'] = { target: '@Btn', specs: [spec] } as never;
      }),
    ).toEqual(['viaComp']);
    expect(
      changesOf((data) => {
        data.motion!['#plain'] = { target: '#plain', specs: [spec] } as never;
      }),
    ).toEqual(['plain']);
    expect(
      changesOf((data) => {
        data.motion!['@Other'] = { target: '@Other', specs: [spec] } as never;
      }),
    ).toEqual([]);
  });

  it('follows tokens named by motion', () => {
    const data = makeDoc();
    (data.tokens as any).motion = { duration: { fast: { $value: 120, $type: 'duration' } } };
    data.motion!['@Btn'] = { target: '@Btn', specs: [{ trigger: 'hover', tracks: [], duration: 'fast', easing: 'none' }] } as never;
    const before = hashesOf(data);
    (data.tokens as any).motion.duration.fast.$value = 200;
    expect(changedRoots(before, hashesOf(data))).toEqual(['viaComp']);
  });

  it('sees interactions, timelines and prototype variables the screen uses', () => {
    const interaction = { trigger: 'click', action: 'play', timeline: 'tl', variable: 'open', transition: { type: 'instant', duration: 'fast', easing: 'out' } };
    const build = () => {
      const data = makeDoc();
      data.timelines = { tl: { name: 'tl', tracks: [] }, other: { name: 'other', tracks: [] } };
      data.prototype = { interactions: { plain: [interaction as never] }, variables: { open: 'false', unrelated: '1' } };
      return data;
    };
    const base = hashesOf(build());
    const after = (edit: (d: DocumentData) => void) => {
      const data = build();
      edit(data);
      return changedRoots(base, hashesOf(data));
    };
    expect(after((d) => { d.timelines!.tl!.tracks.push({ target: 'x', at: 0, spec: { trigger: 'enter', tracks: [], duration: '100ms', easing: 'out' } }); })).toEqual(['plain']);
    expect(after((d) => { d.timelines!.other!.tracks.push({ target: 'x', at: 0, spec: { trigger: 'enter', tracks: [], duration: '100ms', easing: 'out' } }); })).toEqual([]);
    expect(after((d) => { d.prototype!.variables!.open = 'true'; })).toEqual(['plain']);
    expect(after((d) => { d.prototype!.variables!.unrelated = '2'; })).toEqual([]);
    expect(after((d) => { d.prototype!.interactions.plain![0]!.trigger = 'hover'; })).toEqual(['plain']);
  });

  it('reports each dependency for storage in snapshot_screens.deps', () => {
    const screen = hashSnapshot(makeDoc()).screens.find((s) => s.root === 'viaComp')!;
    expect(Object.keys(screen.deps.components)).toEqual(['Btn']);
    expect(Object.keys(screen.deps.tokens)).toContain('color.comp');
    expect(Object.keys(screen.deps.tokens)).not.toContain('color.brand');
  });

  it('adds the tokens a built-in component uses through its stylesheet', () => {
    const data = makeDoc();
    data.tokens = { ...(data.tokens as object), color: { ...(data.tokens as any).color, text: { primary: color('#000000'), secondary: color('#555555') } } } as TokenTree;
    data.pages.p1!.nodes.plain!.component = 'Input';
    data.components.Input = { id: 'Input', name: 'Input', axes: {}, defaults: {}, styles: [] };
    const deps = screenDepsScanner(data)({ id: 's', page: 'p1', root: 'plain' });
    expect(deps.tokens).toContain('color.text.secondary');
  });
});

describe('node hashes', () => {
  const page = (): Page => {
    const data = makeDoc();
    return data.pages.p1!;
  };

  it('covers own fields and ordered children', () => {
    const before = hashNodes(page(), 'moving').get('moving');
    const reordered = page();
    reordered.nodes.moving!.children = ['childB', 'childA'];
    expect(hashNodes(reordered, 'moving').get('moving')).not.toBe(before);
    const moved = page();
    moved.nodes.childA!.position = { x: 9, y: 9 };
    expect(hashNodes(moved, 'moving').get('moving')).not.toBe(before);
  });

  it('leaves a sibling hash alone when another child changes', () => {
    const before = hashNodes(page(), 'moving');
    const edited = page();
    edited.nodes.childA!.position = { x: 9, y: 9 };
    const after = hashNodes(edited, 'moving');
    expect(after.get('childB')).toBe(before.get('childB'));
    expect(after.get('childA')).not.toBe(before.get('childA'));
  });

  it('does not depend on the parent pointer, lock state or Figma id', () => {
    const before = hashNodes(page(), 'childA').get('childA');
    const edited = page();
    edited.nodes.childA!.parent = 'somewhere';
    edited.nodes.childA!.locked = true;
    edited.nodes.childA!.figmaId = '1:2';
    expect(hashNodes(edited, 'childA').get('childA')).toBe(before);
  });

  it('survives a cycle and a dangling child', () => {
    const cyclic = page();
    cyclic.nodes.childA!.children = ['moving', 'gone'];
    expect(() => hashNodes(cyclic, 'moving')).not.toThrow();
  });
});

describe('snapshot results', () => {
  it('produces 64-character hex hashes', () => {
    const result = hashSnapshot(makeDoc());
    for (const hash of [result.contentHash, result.libraryHash, ...result.screens.map((s) => s.hash)]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.canonVersion).toBe(CANON_VERSION);
  });

  it('hashes one screen the same alone as within a snapshot', () => {
    const data = makeDoc();
    const screen = listScreens(data)[0]!;
    expect(hashScreen(data, screen).hash).toBe(hashSnapshot(data).screens[0]!.hash);
  });

  it('accepts screens from screen_frames, with a device', () => {
    const [screen] = hashSnapshot(makeDoc(), { screens: [{ id: 'home', page: 'p1', root: 'plain', device: 'phone' }] }).screens;
    expect(screen).toMatchObject({ id: 'home', device: 'phone', root: 'plain' });
  });

  it('refuses a screen that does not exist', () => {
    expect(() => hashScreen(makeDoc(), { id: 'x', page: 'p1', root: 'nope' })).toThrow(/not found/);
    expect(() => hashScreen(makeDoc(), { id: 'x', page: 'nope', root: 'plain' })).toThrow(/not found/);
    expect(() => hashScreen(makeDoc(), { id: 'x', page: '__proto__', root: 'plain' })).toThrow(/not found/);
  });

  it('moves the library hash with any library change', () => {
    const base = hashLibrary(makeDoc());
    const edited = (edit: (d: DocumentData) => void) => {
      const data = makeDoc();
      edit(data);
      return hashLibrary(data);
    };
    expect(edited((d) => setToken(d, 'color.unused', '#000'))).not.toBe(base);
    expect(edited((d) => { d.components.Btn!.name = 'Knob'; })).not.toBe(base);
    expect(edited((d) => { d.icons!.set1!.stroke = 9; })).not.toBe(base);
    expect(edited((d) => { d.motion!.x = { target: 'x', specs: [] }; })).not.toBe(base);
    expect(edited((d) => { d.pages.p1!.nodes.plain!.text = 'changed'; })).toBe(base);
  });

  it('moves the content hash with any screen or library change', () => {
    const base = hashSnapshot(makeDoc()).contentHash;
    const data = makeDoc();
    data.pages.p1!.nodes.plain!.text = 'changed';
    expect(hashSnapshot(data).contentHash).not.toBe(base);
    const library = makeDoc();
    setToken(library, 'color.unused', '#000');
    expect(hashSnapshot(library).contentHash).not.toBe(base);
  });

  it('pins the canonical form, so stored hashes keep verifying', () => {
    expect(hashCanonical('golden', { b: [1, 0.5, 'é'], a: null })).toBe('f9c76cc8c7cd55c1c2b5896490008bf3425abb96ae6788738ec65d93dd473d4d');
    expect(hashSnapshot(makeDoc()).contentHash).toBe('9973037b00a926214303053f96ab5ac5fc123259ff1874eaaf8e81536c8bb7a7');
  });
});

describe('with the real component library and token set', () => {
  function realDoc() {
    const doc = createDocument();
    applyRdl(doc, 'Card col gap3 p4 fill:surface\n  @Button variant=primary "Go"');
    applyRdl(doc, 'Plain col\n  Text body "Hello"');
    return doc;
  }

  it('finds two top-level screens', () => {
    expect(listScreens(realDoc().data)).toHaveLength(2);
  });

  it('marks only the Button screen when the primary colour ramp changes', () => {
    const doc = realDoc();
    const before = hashSnapshot(doc.data).screens.map((s) => s.hash);
    const tokens = structuredClone(doc.data.tokens) as any;
    tokens.color.primary['600'].$value = '#ff00ff';
    doc.apply([{ op: 'setTokens', tokens }]);
    const after = hashSnapshot(doc.data).screens.map((s) => s.hash);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('hashes a real document deterministically', () => {
    expect(hashSnapshot(realDoc().data).screens.map((s) => s.hash)).toEqual(hashSnapshot(realDoc().data).screens.map((s) => s.hash));
  });
});
