import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { computeDesignProfile, DESIGN_PROFILE_VERSION, namingStyle, type DesignProfile } from './design-profile.js';
import type { ComponentDef, DocumentData, RNode, TokenTree } from './model.js';
import { applyRdl } from './rdl.js';

const color = (value: string) => ({ $value: value, $type: 'color' });
const space = (value: number) => ({ $value: value, $type: 'dimension' });

function makeDoc(): DocumentData {
  const nodes: Record<string, RNode> = {
    home: { id: 'home', type: 'frame', name: 'Home', children: ['hdr', 'cta', 'cta2'], size: { w: { kind: 'fixed', v: 1440 }, h: { kind: 'fixed', v: 900 } }, layout: { mode: 'col', gap: { token: 'space.2' }, padding: [{ token: 'space.2' }, { token: 'space.2' }, { token: 'space.2' }, { token: 'space.2' }] } },
    hdr: { id: 'hdr', type: 'frame', name: 'Frame 12', parent: 'home', style: { fill: [{ token: 'color.surface' }], radius: 7 }, layout: { mode: 'row', gap: 13 } },
    cta: { id: 'cta', type: 'instance', name: 'Primary action', parent: 'home', component: 'Btn', variant: { tone: 'solid' } },
    cta2: { id: 'cta2', type: 'instance', name: 'Secondary action', parent: 'home', component: 'Btn', variant: { tone: 'ghost' } },
    about: { id: 'about', type: 'frame', name: 'About us', children: ['raw', 'bad', 'off'], size: { w: { kind: 'fixed', v: 1440 }, h: { kind: 'hug' } }, layout: { mode: 'col', gap: { token: 'space.2' }, padding: [{ token: 'space.2' }, { token: 'space.2' }, { token: 'space.2' }, { token: 'space.2' }] } },
    raw: { id: 'raw', type: 'frame', name: 'raw-box', parent: 'about', style: { fill: [{ hex: '#ff0000' }], css: 'filter:blur(1px)', font: { size: 15 } } },
    bad: { id: 'bad', type: 'instance', name: 'ghost_component', parent: 'about', component: 'Nope', style: { color: { token: 'color.gone' } } },
    off: { id: 'off', type: 'instance', name: 'offAxis', parent: 'about', component: 'Btn', variant: { tone: 'purple' }, icon: 'nowhere/nothing', image: { asset: 'lost' } },
  };
  const tokens = {
    color: { surface: color('#fff'), brand: color('#123456'), unused: color('#999') , bg: { canvas: color('#fafafa') }, text: { primary: color('#111') } },
    space: { 2: space(8) },
  } as unknown as TokenTree;
  const components: Record<string, ComponentDef> = {
    Btn: { id: 'Btn', name: 'Button', axes: { tone: ['solid', 'ghost'] }, defaults: { tone: 'solid' }, styles: [{ when: {}, style: { fill: [{ token: 'color.brand' }] } }] },
    Idle: { id: 'Idle', name: 'Never used', axes: {}, defaults: {}, styles: [] },
  };
  return {
    manifest: { format: 'rangoli@1', name: 'Doc', pages: [{ id: 'p1', name: 'One' }] },
    tokens,
    pages: { p1: { id: 'p1', name: 'One', children: ['home', 'about'], nodes } },
    components,
  };
}

describe('namingStyle', () => {
  it.each([
    ['Frame 12', 'default'],
    ['group', 'default'],
    ['Rectangle', 'default'],
    ['Primary Action', 'Title Case'],
    ['Header', 'Title Case'],
    ['Primary action', 'Sentence case'],
    ['primary action', 'lower case'],
    ['primary-action', 'kebab-case'],
    ['primary_action', 'snake_case'],
    ['primaryAction', 'camelCase'],
    ['123 456', 'other'],
  ])('reads "%s" as %s', (name, style) => {
    expect(namingStyle(name)).toBe(style);
  });
});

describe('design profile', () => {
  const profile = computeDesignProfile(makeDoc());

  it('is versioned and summarised', () => {
    expect(profile.version).toBe(DESIGN_PROFILE_VERSION);
    expect(profile.summary).toMatchObject({ screens: 2, layers: 8, instances: 3, tokensUsed: profile.tokens.length, componentsUsed: 1 });
  });

  it('lists only tokens in real use, with the screens using them', () => {
    const paths = profile.tokens.map((t) => t.path);
    expect(paths).not.toContain('color.unused');
    expect(paths).not.toContain('color.gone');
    expect(profile.tokens.find((t) => t.path === 'color.surface')).toEqual({ path: 'color.surface', type: 'color', directUses: 1, screens: ['p1/home'] });
    expect(profile.tokens.find((t) => t.path === 'space.2')).toEqual({ path: 'space.2', type: 'dimension', directUses: 10, screens: ['p1/about', 'p1/home'] });
  });

  it('counts a token used only through a component', () => {
    expect(profile.tokens.find((t) => t.path === 'color.brand')).toMatchObject({ directUses: 0, screens: ['p1/about', 'p1/home'] });
  });

  it('lists components in use with their variants', () => {
    expect(profile.components).toEqual([{ id: 'Btn', name: 'Button', instances: 3, screens: ['p1/about', 'p1/home'], variants: { tone: { ghost: 1, purple: 1, solid: 1 } } }]);
  });

  it('describes layouts', () => {
    expect(profile.layouts.modes).toEqual({ col: 2, none: 5, row: 1 });
    expect(profile.layouts.patterns[0]).toEqual({ label: 'col, gap space.2, padding space.2 space.2 space.2 space.2', count: 2 });
    expect(profile.layouts.patterns).toContainEqual({ label: 'row, gap 13', count: 1 });
    expect(profile.layouts.screenSizes).toEqual([{ label: '1440 x 900', count: 1 }, { label: '1440 x hug', count: 1 }]);
  });

  it('lists the screens', () => {
    expect(profile.screens).toEqual([
      { id: 'p1/home', page: 'p1', root: 'home', name: 'Home', size: '1440 x 900', layers: 4, instances: 2, components: ['Btn'] },
      { id: 'p1/about', page: 'p1', root: 'about', name: 'About us', size: '1440 x hug', layers: 4, instances: 1, components: ['Btn'] },
    ]);
  });

  it('describes naming', () => {
    expect(profile.naming.screens).toEqual({ 'Sentence case': 1, 'Title Case': 1 });
    expect(profile.naming.layers).toEqual({ 'Sentence case': 2, camelCase: 1, default: 1, 'kebab-case': 1, snake_case: 1 });
    expect(profile.naming.dominant).toBe('Sentence case');
    expect(profile.naming.defaultNamedLayers).toBe(1);
  });

  it('records every exception to the system', () => {
    const list = profile.exceptions.map((e) => `${e.node} ${e.kind} ${e.detail}`);
    expect(list).toEqual([
      'bad missing-component Nope',
      'bad missing-token color.gone',
      'off missing-asset lost',
      'off missing-icon nowhere/nothing',
      'off unknown-variant tone=purple',
      'raw css-override filter:blur(1px)',
      'raw raw-color fill #ff0000',
      'raw raw-font-size size 15',
      'hdr raw-radius radius 7',
      'hdr raw-spacing gap 13',
    ]);
    expect(profile.summary.exceptions).toEqual({
      'css-override': 1,
      'missing-asset': 1,
      'missing-component': 1,
      'missing-icon': 1,
      'missing-token': 1,
      'raw-color': 1,
      'raw-font-size': 1,
      'raw-radius': 1,
      'raw-spacing': 1,
      'unknown-variant': 1,
    });
  });

  it('does not flag zero as a raw value', () => {
    const data = makeDoc();
    data.pages.p1!.nodes.home!.layout!.gap = 0;
    data.pages.p1!.nodes.home!.style = { radius: 0 };
    const nodes = computeDesignProfile(data).exceptions.filter((e) => e.node === 'home');
    expect(nodes).toEqual([]);
  });

  it('leaves out layer text', () => {
    const data = makeDoc();
    data.pages.p1!.nodes.hdr!.text = 'Participant: Asha, phone 555';
    expect(JSON.stringify(computeDesignProfile(data))).not.toContain('Asha');
  });

  it('skips a listed screen that no longer exists', () => {
    const result = computeDesignProfile(makeDoc(), { screens: [{ id: 'x', page: 'p1', root: 'gone' }, { id: 'y', page: 'none', root: 'home' }] });
    expect(result.screens).toEqual([]);
  });

  it('handles an empty document', () => {
    const empty = computeDesignProfile(createDocument().data);
    expect(empty.summary).toMatchObject({ screens: 0, layers: 0, tokensUsed: 0, componentsUsed: 0, exceptions: {} });
    expect(empty.naming.dominant).toBeUndefined();
  });

  it('works on a real document', () => {
    const doc = createDocument();
    applyRdl(doc, 'Card col gap3 p4 fill:surface\n  @Button variant=primary "Go"');
    const result: DesignProfile = computeDesignProfile(doc.data);
    expect(result.summary.screens).toBe(1);
    expect(result.components.map((c) => c.id)).toContain('Button');
    expect(result.tokens.map((t) => t.path)).toContain('color.bg.surface');
  });
});

describe('determinism', () => {
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

  it('gives byte-identical output whatever the key order', () => {
    const data = makeDoc();
    const expected = JSON.stringify(computeDesignProfile(data));
    let state = 31337;
    const random = (limit: number) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return (state >>> 8) % limit;
    };
    for (let run = 0; run < 50; run++) expect(JSON.stringify(computeDesignProfile(shuffleKeys(data, random)))).toBe(expected);
  });

  it('does not change the document', () => {
    const data = makeDoc();
    const before = structuredClone(data);
    computeDesignProfile(data);
    expect(data).toEqual(before);
  });
});
