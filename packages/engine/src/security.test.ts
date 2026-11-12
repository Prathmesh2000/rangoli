import { afterEach, describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { RangoliDocument } from './document.js';
import { LANGUAGES, languageTokens } from './languages.js';
import type { Paint, RNode, TokenTree } from './model.js';
import { applyRdl, sanitizeCss } from './rdl.js';
import { paintCss, renderCss, renderDocument, renderFragment } from './render.js';
import { isSafeCssValue } from './safety.js';
import { cssVarName, defaultTokens, tokensToCss, tokenTreeError, tokenValueToCss } from './tokens.js';

/** A document as storage hands it back: nothing here went through validation. */
const stored = (mutate: (doc: RangoliDocument) => void): RangoliDocument => {
  const doc = createDocument();
  mutate(doc);
  return new RangoliDocument(doc.toJSON());
};
const frame = (over: Partial<RNode>): RNode => ({ id: 'n1', type: 'frame', name: 'F', children: [], ...over }) as RNode;
const put = (doc: RangoliDocument, node: RNode) => {
  const page = doc.page();
  page.nodes[node.id] = node;
  page.children.push(node.id);
};
const tree = (doc: RangoliDocument) => doc.data.tokens as unknown as Record<string, Record<string, unknown>>;

afterEach(() => {
  // a failed attack must not leak into later tests
  for (const k of ['polluted', 'x', 'style', 'parent']) delete (Object.prototype as unknown as Record<string, unknown>)[k];
});
const clean = () => expect(({} as Record<string, unknown>).polluted ?? ({} as Record<string, unknown>).x).toBeUndefined();

describe('V1: caller-supplied paths and keys', () => {
  for (const path of ['__proto__.polluted', 'constructor.prototype.polluted', 'color.__proto__.polluted', 'color.constructor.prototype.polluted', 'a.prototype.b']) {
    it(`setToken rejects ${path}`, () => {
      const doc = createDocument();
      expect(() => doc.setToken(path, 'yes')).toThrow(/reserved name/);
      clean();
    });
  }

  for (const path of ['', 'a..b', '.a', 'a.', 'a b.c', 'a.$value', '$extensions.rangoli', 'a.</style>']) {
    it(`setToken rejects the invalid path "${path}"`, () => {
      expect(() => createDocument().setToken(path, 'yes')).toThrow(/token path/i);
    });
  }

  it('setToken rejects unsafe mode names', () => {
    const doc = createDocument();
    expect(() => doc.setToken('color.white', '#000000', { mode: '__proto__' })).toThrow(/Invalid mode/);
    expect(() => doc.setToken('color.white', '#000000', { mode: 'x"]{}' })).toThrow(/Invalid mode/);
    clean();
  });

  it('setToken still sets values and modes', () => {
    const doc = createDocument();
    doc.setToken('color.custom.brand', '#123456', { type: 'color' });
    doc.setToken('color.custom.brand', '#654321', { mode: 'dark' });
    const css = tokensToCss(doc.data.tokens);
    expect(css).toContain('--color-custom-brand: #123456;');
    expect(css).toContain('--color-custom-brand: #654321;');
  });

  it('the RDL token command rejects reserved segments', () => {
    const doc = createDocument();
    expect(() => applyRdl(doc, 'token color.__proto__.polluted 1')).toThrow(/reserved name/);
    expect(() => applyRdl(doc, 'token constructor.prototype.polluted 1')).toThrow(/reserved name/);
    expect(() => applyRdl(doc, 'token textStyle.body.__proto__ 1')).toThrow(/reserved name/);
    expect(() => applyRdl(doc, 'token __proto__.polluted 1')).toThrow();
    expect(() => applyRdl(doc, 'token color.white #000000 constructor=#111111')).toThrow(/Invalid mode/);
    clean();
  });

  it('ops cannot address Object.prototype', () => {
    const doc = createDocument();
    expect(() => doc.apply([{ op: 'update', id: '__proto__', patch: { name: 'x' } }])).toThrow(/reserved name/);
    expect(() => doc.apply([{ op: 'move', id: '__proto__', parent: undefined }])).toThrow(/reserved name/);
    expect(() => doc.apply([{ op: 'create', node: frame({ id: 'constructor' }) }])).toThrow(/Invalid node id/);
    expect(() => doc.apply([{ op: 'setMotion', target: '__proto__', def: null }])).toThrow(/reserved name/);
    expect(() => applyRdl(doc, 'set #__proto__ hidden')).toThrow();
    expect(({} as Record<string, unknown>).parent).toBeUndefined();
    expect(({} as Record<string, unknown>).style).toBeUndefined();
    expect(() => doc.node('__proto__')).toThrow(/not found/);
    expect(() => doc.page('constructor')).toThrow(/not found/);
  });

  it('a whole tree cannot smuggle reserved keys', () => {
    const doc = createDocument();
    const tokens = JSON.parse('{"color":{"__proto__":{"polluted":{"$value":"#000000"}}}}') as TokenTree;
    expect(() => doc.apply([{ op: 'setTokens', tokens }])).toThrow(/reserved name/);
    const ext = JSON.parse('{"$extensions":{"rangoli":{"constructor":{}}}}') as TokenTree;
    expect(() => doc.apply([{ op: 'setTokens', tokens: ext }])).toThrow(/reserved name/);
    clean();
  });

  it('a font named after an Object member does not break rendering', () => {
    const doc = createDocument();
    applyRdl(doc, 'Box font:constructor');
    expect(() => renderCss(doc, '', [])).not.toThrow();
  });
});

describe('V2: token values in <style>', () => {
  const breakout = '</style><img src=x onerror=alert(1)>';

  it('rejects breakouts on write', () => {
    const doc = createDocument();
    expect(() => doc.setToken('color.white', breakout)).toThrow(/not a safe CSS value/);
    expect(() => doc.setToken('color.white', '#fff', { mode: 'dark' })).not.toThrow();
    expect(() => doc.setToken('color.white', 'red;}body{display:none')).toThrow(/not a safe CSS value/);
    expect(() => doc.setToken('shadow.md', 'url(http://evil/x)')).toThrow(/not a safe CSS value/);
    expect(() => applyRdl(doc, `token color.white "${breakout}"`)).toThrow(/not a safe CSS value/);
  });

  it('checks values by type', () => {
    const doc = createDocument();
    expect(() => doc.setToken('color.white', 'not a colour')).toThrow(/not a valid color/);
    expect(() => doc.setToken('space.4', '12 34 56')).toThrow(/not a valid dimension/);
    expect(() => doc.setToken('motion.duration.fast', 'soon')).toThrow(/not a valid duration/);
    expect(() => doc.setToken('color.white', '#000000', { mode: 'dark' })).not.toThrow();
  });

  it('keeps legitimate values of every type', () => {
    const doc = createDocument();
    for (const [path, value] of [
      ['color.white', '#fff'], ['color.white', '#11223344'], ['color.white', 'rgb(1 2 3 / 40%)'], ['color.white', 'hsla(10, 20%, 30%, .5)'],
      ['color.white', 'oklch(70% 0.1 200)'], ['color.white', 'color-mix(in srgb, var(--x) 20%, transparent)'], ['color.white', 'transparent'],
      ['color.white', '{color.primary.600}'], ['space.4', '1.5rem'], ['space.4', 'calc(100% - 4px)'], ['space.4', 18], ['space.4', '{space.2}'],
      ['motion.duration.fast', '120ms'], ['motion.duration.fast', '.2s'], ['motion.duration.fast', 120],
      ['shadow.md', '0 1px 2px rgba(16,24,40,.06), 0 1px 3px rgba(16,24,40,.10)'], ['shadow.md', 'inset 0 0 0 1px #000'],
      ['font.family.display', 'Georgia, "Times New Roman", serif'], ['font.family.display', "'Segoe UI', sans-serif"],
    ] as [string, string | number][]) {
      expect(() => doc.setToken(path, value), `${path} = ${value}`).not.toThrow();
    }
  });

  it('accepts font lists with apostrophes, but not breakouts', () => {
    const doc = createDocument();
    const withFamily = (list: string[]) => ({ ...doc.data.tokens, font: { family: { display: { $type: 'fontFamily', $value: list } } } }) as unknown as TokenTree;
    expect(tokenTreeError(withFamily(['Baskerville\'s', 'Source Serif 4', 'serif']), doc.data.tokens)).toBeUndefined();
    expect(tokenTreeError(withFamily(['"</style>']), doc.data.tokens)).toMatch(/not a valid font name/);
  });

  it('every default and language token set is valid', () => {
    expect(tokenTreeError(defaultTokens())).toBeUndefined();
    for (const id of Object.keys(LANGUAGES)) expect(tokenTreeError(languageTokens(id)), id).toBeUndefined();
  });

  it('drops unsafe values from a stored document and keeps the rest', () => {
    const doc = stored((d) => { (tree(d).color!.white as { $value: string }).$value = breakout; });
    const css = renderCss(doc, '', []);
    expect(css).not.toContain('</style');
    expect(css).not.toContain('--color-white:');
    expect(css).toContain('--color-neutral-50:');
    expect(renderDocument(doc)).not.toContain('onerror');
  });

  it('an old bad value does not block edits to other tokens, and can be repaired', () => {
    const doc = stored((d) => { (tree(d).color!.white as { $value: string }).$value = breakout; });
    expect(() => doc.setToken('color.custom.ok', '#123456', { type: 'color' })).not.toThrow();
    expect(() => doc.setToken('color.white', '#ffffff')).not.toThrow();
    expect(tokensToCss(doc.data.tokens)).toContain('--color-white: #ffffff;');
  });

  it('undo can restore a tree holding an old bad value', () => {
    const doc = stored((d) => { (tree(d).color!.white as { $value: string }).$value = breakout; });
    doc.setToken('color.white', '#ffffff');
    expect(() => doc.undo()).not.toThrow();
    expect(renderCss(doc, '', [])).not.toContain('</style');
  });

  it('neutralises token paths and theme names in stored documents', () => {
    expect(cssVarName('color.primary.600')).toBe('--color-primary-600');
    expect(cssVarName('space.0.5')).toBe('--space-0-5');
    expect(cssVarName('a</style>')).toBe('--a--style-');
    const doc = stored((d) => {
      tree(d).color!['x}</style><b>'] = { $value: '#000000', $type: 'color' };
      (d.data.tokens as { $extensions?: unknown }).$extensions = { rangoli: { themes: { 'x"]{}</style>': { name: 'x', base: 'dark' } } } };
    });
    const css = tokensToCss(doc.data.tokens);
    expect(css).not.toContain('</style');
    expect(css).not.toContain('x"]');
  });

  it('tokenValueToCss guards composite values', () => {
    expect(tokenValueToCss({ fontSize: 14, lineHeight: '1;}</style>' }, 'typography')).toBeUndefined();
    expect(tokenValueToCss(['</style>'], 'fontFamily')).toBeUndefined();
    expect(tokenValueToCss('#123456', 'color')).toBe('#123456');
  });
});

describe('V3: sanitizeCss', () => {
  for (const attack of [
    'background:u\\72l(http://x)', 'background:\\75rl(http://x)', 'color:\\72 ed', 'background:image-set("http://x" 1x)', 'background:-webkit-image-set("http://x" 1x)',
    'background:IMAGE-SET("http://x" 1x)', 'mask:url(x)', 'background:URL(x)', 'background:cross-fade("a","b")', 'background:image("x")', 'background:element(#a)',
    'color:red</style><script>alert(1)</script>', '</style>', 'color:red<!--', '}body{display:none', 'color:red/*', 'width:calc(1px', 'font-family:"x',
  ]) {
    it(`rejects ${attack}`, () => expect(sanitizeCss(attack)).toBeUndefined());
  }

  it('keeps legitimate declarations', () => {
    expect(sanitizeCss('filter:grayscale(1);mix-blend-mode:normal')).toBe('filter:grayscale(1);mix-blend-mode:normal');
    expect(sanitizeCss('transform: translate(4px, 8px) rotate(3deg)')).toBe('transform: translate(4px, 8px) rotate(3deg)');
    expect(sanitizeCss('background:linear-gradient(90deg, #fff 0%, rgba(0,0,0,.5) 100%)')).toBeDefined();
    expect(sanitizeCss('font-family:"Segoe UI", sans-serif;width:calc(100% - 8px)')).toBe('font-family:"Segoe UI", sans-serif;width:calc(100% - 8px)');
    expect(sanitizeCss('-webkit-line-clamp:3')).toBe('-webkit-line-clamp:3');
  });

  it('RDL refuses escapes with the usual error', () => {
    expect(() => applyRdl(createDocument(), 'Box css:"background:image-set(x)"')).toThrow(/only plain declarations/);
  });

  it('render drops a stored escape', () => {
    const doc = stored((d) => put(d, frame({ style: { css: 'background:u\\72l(http://x)' } })));
    expect(renderFragment(doc).css).not.toContain('72l');
  });
});

describe('V22: paints and grid templates', () => {
  const evil = 'red;}</style><script>alert(1)</script>';

  it('paintCss never emits raw document strings', () => {
    expect(paintCss({ hex: evil })).toBe('transparent');
    expect(paintCss({ hex: '#12345678' })).toBe('#12345678');
    expect(paintCss({ token: 'x)}</style>' })).not.toMatch(/[<>{}]/);
    expect(paintCss({ token: 'color.white', alpha: '1;}' as unknown as number })).toBe('var(--color-white)');
    expect(paintCss({ gradient: { type: 'linear', angle: '1;}' as unknown as number, stops: [{ at: 0, color: { hex: evil } }] } })).toBe('linear-gradient(180deg, transparent 0%)');
    expect(paintCss({ token: 'primary.600', alpha: 40 })).toBe('color-mix(in srgb, var(--primary-600) 40%, transparent)');
  });

  it('rejects bad paints and templates in direct ops', () => {
    const doc = createDocument();
    const create = (over: Partial<RNode>) => doc.apply([{ op: 'create', node: frame({ id: '', ...over }) }]);
    expect(() => create({ style: { fill: [{ hex: evil }] } })).toThrow(/Invalid colour/);
    expect(() => create({ style: { color: { token: 'a.</style>' } } })).toThrow(/invalid segment/);
    expect(() => create({ style: { stroke: { paint: { hex: 'url(x)' } } } })).toThrow(/Invalid colour/);
    expect(() => create({ style: { fill: [{ image: { url: 'http://169.254.169.254/', fit: 'cover' } }] } })).toThrow(/https/);
    expect(() => create({ style: { fill: [{ image: { url: 'https://x/a.png")}</style>', fit: 'cover' } }] } })).toThrow(/https/);
    expect(() => create({ style: { css: 'background:u\\72l(x)' } })).toThrow(/plain declarations/);
    expect(() => create({ style: { cursor: 'url(http://x),auto' } })).toThrow(/Invalid style/);
    expect(() => create({ layout: { mode: 'grid', columns: `1fr;${evil}` } })).toThrow(/grid columns/);
    expect(() => create({ layout: { mode: 'grid', rows: 'url(x)' } })).toThrow(/grid rows/);
    const id = create({ layout: { mode: 'grid', columns: 'repeat(2, minmax(0, 1fr)) 200px', rows: 'auto 1fr' }, style: { fill: [{ hex: '#abcdef' }] } }).created[0]!;
    expect(() => doc.apply([{ op: 'update', id, patch: { layout: { mode: 'grid', rows: evil } } }])).toThrow(/grid rows/);
    expect(() => doc.apply([{ op: 'update', id, patch: { style: { fill: [{ hex: evil }] } } }])).toThrow(/Invalid colour/);
    const css = renderFragment(doc).css;
    expect(css).toContain('grid-template-columns:repeat(2, minmax(0, 1fr)) 200px');
    expect(css).toContain('grid-template-rows:auto 1fr');
    expect(css).toContain('background:#abcdef');
  });

  it('a stored document renders with the bad values dropped', () => {
    const doc = stored((d) => {
      put(d, frame({
        layout: { mode: 'grid', columns: evil, rows: 'url(http://x)', gap: `1;${evil}` as unknown as number },
        style: { fill: [{ hex: evil }], cursor: 'url(http://x),auto', blend: evil, radius: 4, font: { family: `var(x);${evil}`, letterSpacing: evil } },
      }));
      put(d, frame({ id: 'n2', style: { fill: [{ image: { url: `https://x/${evil}`, fit: evil as 'cover', pos: evil } }], color: { hex: '#123456' } } }));
      put(d, frame({ id: 'x}</style><b>', style: { fill: [{ hex: '#000000' }] } }));
    });
    const html = renderDocument(doc);
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('</style><');
    expect(html).not.toContain('http://x');
    const { css } = renderFragment(doc);
    expect(css).toContain('border-radius:4px');
    expect(css).toContain('color:#123456');
    expect(css).toContain('display:grid');
  });

  it('SVG attributes stay closed for stored vector paints', () => {
    const quote = '#000" onload="alert(1)';
    const doc = stored((d) => put(d, frame({
      type: 'vector',
      vector: { vw: 24, vh: 24, paths: [{ d: 'M0 0L1 1', fill: { hex: quote } as Paint, color: quote, cap: quote as 'round', join: quote as 'round', strokeWidth: quote as unknown as number }] },
    })));
    expect(renderFragment(doc).html).not.toContain('onload="');
  });

  it('a safe image paint still renders', () => {
    const doc = createDocument();
    applyRdl(doc, 'Box fill:image(https://example.com/a.png,cover,top-left,primary.500~40)');
    const { css } = renderFragment(doc);
    expect(css).toContain('url("https://example.com/a.png") top left / cover no-repeat');
    expect(css).toContain('color-mix(in srgb, var(--color-primary-500) 40%, transparent)');
  });

  it('renderCss cannot be closed by anything in a stored document', () => {
    const doc = stored((d) => {
      (d.data.motion ??= {}).x = { target: 'x', specs: [{ trigger: 'hover', duration: '100ms', easing: 'out', tracks: [{ prop: 'fill', to: `#000;}</style><script>x` }] }] } as never;
    });
    expect(renderCss(doc, '.a{color:red}</style><!--', [])).not.toMatch(/<\/style|<!--/i);
  });

  it('isSafeCssValue allows normal CSS', () => {
    for (const v of ['0 0 0 0 transparent', 'cubic-bezier(0.2, 0, 0, 1)', '"IBM Plex Sans", sans-serif', "font-family:'A B'", 'grid-template-columns:repeat(3,minmax(0,1fr))']) expect(isSafeCssValue(v), v).toBe(true);
  });
});
