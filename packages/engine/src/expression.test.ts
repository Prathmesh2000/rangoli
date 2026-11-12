import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { allFonts, findFont, fontHead, googleFontUrl, googleFonts } from './fonts.js';
import { lint } from './lint.js';
import { applyRdl, serializeRdl } from './rdl.js';
import { renderCss, renderDocument, renderFragment } from './render.js';
import { parseSceneObjects, scene3dModule, serializeSceneObjects } from './scene3d.js';
import { themesOf } from './themes.js';
import { TokenResolver } from './tokens.js';

describe('fonts', () => {
  it('knows the catalogue and builds correct Google URLs', () => {
    expect(googleFonts().length).toBeGreaterThan(1500);
    expect(findFont('source serif 4')?.category).toBe('serif');
    const url = googleFontUrl(['Inter', 'Lobster'])!;
    expect(url).toMatch(/family=Inter:ital,wght@0,100\.\.900;1,100\.\.900/);
    expect(url).toContain('family=Lobster');
  });

  it('loads only what a design uses, quotes names and adds the right fallback', () => {
    const doc = createDocument();
    applyRdl(doc, 'Title text font:"Playfair Display" "Hello"');
    expect(fontHead(doc).links.join()).toContain('Playfair+Display');
    expect(renderFragment(doc).css).toContain('font-family:"Playfair Display", serif');
    expect(renderDocument(doc)).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?');
  });

  it('lets people add their own font, and refuses unsafe sources', () => {
    const doc = createDocument();
    applyRdl(doc, 'fontface "Brand Sans" url=https://cdn.example.com/brand.woff2 weight=700\nTitle text font:"Brand Sans" "Hi"');
    expect(fontHead(doc).css).toContain('@font-face{font-family:"Brand Sans";src:url("https://cdn.example.com/brand.woff2");font-weight:700');
    expect(allFonts(doc.data.tokens)[0]).toMatchObject({ family: 'Brand Sans', source: 'custom' });
    expect(() => applyRdl(doc, 'fontface "X" url=http://bad.example/x.woff2')).toThrow(/fontface needs/);
    expect(() => applyRdl(doc, 'fontface "X" url="https://a/b);}body{display:none"')).toThrow(/fontface needs/);
    applyRdl(doc, 'fontface "Brand Sans" none');
    expect(fontHead(doc).css).toBe('');
  });
});

describe('themes', () => {
  it('adds a named theme with readable derived colours, in CSS and lint', () => {
    const doc = createDocument();
    applyRdl(doc, 'theme ocean preset=ocean\nCard col p4 fill:surface\n  Text body "Hi"\n  @Button "Go"');
    expect(themesOf(doc.data.tokens).ocean).toEqual({ name: 'Ocean', base: 'dark' });
    const r = new TokenResolver(doc.data.tokens);
    expect(r.resolve('color.bg.canvas', 'ocean')).toBe('#06262f');
    expect(r.resolve('color.status.error.bg', 'ocean')).toBe(r.resolve('color.status.error.bg', 'dark')); // falls back to its base
    expect(renderCss(doc, '', [])).toMatch(/\[data-mode="ocean"\] \{[^}]*--color-bg-canvas: #06262f/);
    expect(lint(doc).filter((i) => i.code === 'D03')).toEqual([]);
  });

  it.each(['midnight', 'ocean', 'forest', 'sunset', 'neon', 'rose', 'sepia', 'mint', 'mono', 'contrast'])('%s preset keeps text readable', (preset) => {
    const doc = createDocument();
    applyRdl(doc, `theme t preset=${preset}\nCard col p4 fill:surface\n  Text body "Hi"\n  Sub text body-sm muted "Lo"\n  @Button "Go"\n  @Link "More"`);
    expect(lint(doc, { modes: ['t'] }).filter((i) => i.code === 'D03')).toEqual([]);
  });

  it('removes cleanly, edits per theme, survives a language switch', () => {
    const doc = createDocument();
    applyRdl(doc, 'theme brand bg=#101820 primary=#ffb000 name="Brand"');
    applyRdl(doc, 'token color.bg.surface #ffffff brand=#1a2530');
    expect(new TokenResolver(doc.data.tokens).resolve('color.bg.surface', 'brand')).toBe('#1a2530');
    applyRdl(doc, 'language playful');
    expect(themesOf(doc.data.tokens).brand?.name).toBe('Brand');
    applyRdl(doc, 'theme brand none');
    expect(themesOf(doc.data.tokens).brand).toBeUndefined();
    expect(() => applyRdl(doc, 'theme dark bg=#000000 primary=#ffffff')).toThrow(/cannot be a theme/);
    expect(() => applyRdl(doc, 'theme x bg=red primary=#ffffff')).toThrow(/needs bg/);
  });
});

describe('image backgrounds', () => {
  it('renders url, fit, position and tint, and round-trips', () => {
    const doc = createDocument();
    applyRdl(doc, 'Hero col h200 fill:image(https://example.com/a.jpg,cover,top,neutral.900~40)');
    const { css } = renderFragment(doc);
    expect(css).toContain('background:linear-gradient(color-mix(in srgb, var(--color-neutral-900) 40%, transparent),color-mix(in srgb, var(--color-neutral-900) 40%, transparent)),url("https://example.com/a.jpg") top / cover no-repeat');
    const out = serializeRdl(doc);
    expect(out).toContain('fill:image(https://example.com/a.jpg,cover,top,neutral.900~40)');
    const copy = createDocument();
    applyRdl(copy, out);
    expect(serializeRdl(copy)).toBe(out);
  });

  it('refuses anything that is not an asset or https', () => {
    const doc = createDocument();
    expect(() => applyRdl(doc, 'A fill:image(javascript:alert(1))')).toThrow();
    expect(() => applyRdl(doc, 'A fill:image(http://x.com/a.png)')).toThrow(/neither an uploaded asset/);
  });
});

describe('layer JavaScript', () => {
  it('round-trips, bundles with el bound, and only ships when asked', () => {
    const doc = createDocument();
    applyRdl(doc, 'Box col script:"el.textContent = \'hi\'; // </script>"');
    expect(serializeRdl(doc)).toContain('script:');
    expect(renderFragment(doc).js).toContain("})(document.querySelector('.r-n1'));");
    expect(renderDocument(doc)).not.toContain("el.textContent");
    const page = renderDocument(doc, { scripts: true });
    expect(page).toContain('el.textContent');
    expect(page.match(/<\/script>/g)).toHaveLength(1); // the code cannot close its own tag
    applyRdl(doc, 'set #n1 unset:script');
    expect(renderFragment(doc).js).toBe('');
  });
});

describe('3D', () => {
  it('parses and re-serialises objects, dropping invalid ones', () => {
    const list = parseSceneObjects('torus color=primary.400 x=1.5 spin=.4 axis=x | nope | model url=http://bad/x.glb | sphere wire');
    expect(list.map((o) => o.shape)).toEqual(['torus', 'sphere']);
    expect(serializeSceneObjects(list)).toBe('torus color=primary.400 x=1.5 spin=0.4 axis=x | sphere wire');
  });

  it('carries token colours as CSS variables and embeds a self-contained runtime', () => {
    const doc = createDocument();
    applyRdl(doc, '@Scene3D h300 light=neon objects="gem color=primary.400" "Gem"');
    const page = renderDocument(doc);
    expect(page).toContain('rk-3d');
    expect(page).toContain('var(--color-primary-400)');
    expect(page).toContain('https://esm.sh/three@');
    expect(scene3dModule()).toContain('const mount = function mountScene3D');
  });
});
