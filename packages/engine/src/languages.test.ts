import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { LANGUAGES, languageOf, languageTokens, upgradeTokens } from './languages.js';
import { lint } from './lint.js';
import { applyRdl } from './rdl.js';
import { renderFragment } from './render.js';
import { TokenResolver, defaultTokens, fontStack } from './tokens.js';

const SAMPLE = readFileSync(new URL('../../../examples/language-sample.rdl', import.meta.url), 'utf8');

describe('design languages', () => {
  it.each(Object.keys(LANGUAGES))('%s: complete tokens, no contrast or size problems in light + dark', (id) => {
    const doc = createDocument();
    doc.apply([{ op: 'setTokens', tokens: languageTokens(id) }]);
    applyRdl(doc, SAMPLE);
    const bad = lint(doc).filter((i) => i.severity === 'P0' || i.severity === 'P1');
    expect(bad).toEqual([]);
    const r = new TokenResolver(doc.data.tokens);
    for (const p of ['size.control.md', 'radius.control', 'radius.card', 'shadow.control', 'font.family.display', 'color.bg.track']) expect(r.has(p)).toBe(true);
  });

  it('library components restyle from tokens alone', () => {
    const css = (id: string) => {
      const doc = createDocument();
      doc.apply([{ op: 'setTokens', tokens: languageTokens(id) }]);
      applyRdl(doc, '@Button "Save"');
      return { frag: renderFragment(doc).css, r: new TokenResolver(doc.data.tokens) };
    };
    const m = css('material'), c = css('carbon');
    expect(m.frag).toBe(c.frag); // identical markup/CSS — only token values differ
    expect(m.r.resolve('size.control.md')).toBe(40);
    expect(m.r.resolve('radius.control')).toBe(9999);
    expect(c.r.resolve('radius.control')).toBe(0);
  });

  it('remembers the language and keeps user overrides', () => {
    const tree = languageTokens('editorial', { brand: '#336699' });
    expect(languageOf(tree)).toEqual({ id: 'editorial', options: { brand: '#336699' } });
    expect(languageOf(defaultTokens())).toEqual({ id: 'rangoli', options: {} });
    expect(() => languageTokens('nope')).toThrow(/unknown design language/);
  });

  it('older documents gain new tokens without losing edits', () => {
    const old = defaultTokens() as Record<string, any>;
    delete old.size;
    delete old.radius.card;
    delete old.shadow.control;
    old.radius['2'].$value = 7; // a user edit
    const up = upgradeTokens(old);
    const r = new TokenResolver(up);
    expect(r.resolve('size.control.md')).toBe(36);
    expect(r.resolve('radius.card')).toBe(8);
    expect(r.resolve('radius.2')).toBe(7);
    expect(r.has('shadow.control')).toBe(true);
  });

  it('quotes font names that are not plain identifiers', () => {
    expect(fontStack(['Source Serif 4', 'Segoe UI', 'Georgia', '-apple-system', 'serif'])).toBe('"Source Serif 4", "Segoe UI", Georgia, -apple-system, serif');
  });
});

describe('token and language commands (RDL)', () => {
  it('sets tokens with modes and aliases, undoably; rejects broken aliases', async () => {
    const { applyRdl } = await import('./rdl.js');
    const doc = createDocument();
    applyRdl(doc, 'token color.primary.600 #1d4ed8 dark=#60a5fa\ntoken space.4 18\ntoken radius.control {radius.full}\ntoken color.brand.accent #ff5a1f');
    const r = new TokenResolver(doc.data.tokens);
    expect([r.resolve('color.primary.600'), r.resolve('color.primary.600', 'dark'), r.resolve('space.4'), r.resolve('radius.control'), r.resolve('color.brand.accent')]).toEqual(['#1d4ed8', '#60a5fa', 18, 9999, '#ff5a1f']);
    doc.undo();
    expect(new TokenResolver(doc.data.tokens).resolve('space.4')).toBe(16);
    expect(() => applyRdl(doc, 'token radius.control {radius.nope}')).toThrow(/does not resolve/);
  });

  it('switches language keeping the brand', async () => {
    const { applyRdl } = await import('./rdl.js');
    const doc = createDocument();
    applyRdl(doc, 'language material brand=#336699');
    applyRdl(doc, 'language brutalist');
    expect(languageOf(doc.data.tokens)).toEqual({ id: 'brutalist', options: { brand: '#336699' } });
    expect(() => applyRdl(doc, 'language nope')).toThrow(/unknown design language/);
  });
});

describe('composite tokens', () => {
  it('edits one field of a text style, undoably', async () => {
    const { applyRdl } = await import('./rdl.js');
    const doc = createDocument();
    applyRdl(doc, 'token textStyle.body.fontSize 17');
    expect((new TokenResolver(doc.data.tokens).resolve('textStyle.body') as { fontSize: number }).fontSize).toBe(17);
    doc.undo();
    expect((new TokenResolver(doc.data.tokens).resolve('textStyle.body') as { fontSize: number }).fontSize).toBe(14);
    expect(() => applyRdl(doc, 'token space.4.nope 1')).toThrow(/is a token, not a group/);
  });
});
