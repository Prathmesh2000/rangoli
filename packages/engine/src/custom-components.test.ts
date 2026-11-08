import { describe, expect, it } from 'vitest';
import { createDocument, withLibrary } from './components.js';
import { lint } from './lint.js';
import { applyRdl, componentRdl, serializeRdl } from './rdl.js';
import { renderFragment } from './render.js';

describe('component blocks (restyle + new variants)', () => {
  it('adds a variant to a library component and restyles all instances', () => {
    const doc = createDocument();
    applyRdl(doc, `component @Button
  variant=pill rfull px6 fill:success.600 color:white
  * shadow:md`);
    const btn = doc.data.components.Button!;
    expect(btn.axes.variant).toContain('pill');
    applyRdl(doc, 'Row row gap2\n  @Button variant=pill "Ship it"\n  @Button "Save"');
    const { css, html } = renderFragment(doc);
    expect(html).toContain('data-variant="pill"');
    expect(css).toMatch(/\.r-n2\{[^}]*padding:0 var\(--space-6\)[^}]*background:var\(--color-success-600\)[^}]*border-radius:var\(--radius-full\)/);
    expect(css).toMatch(/\.r-n3\{[^}]*box-shadow:var\(--shadow-md\)/); // "*" rule applies to every instance
    // rules merge per selector instead of replacing
    applyRdl(doc, 'component @Button\n  variant=pill weight:700');
    const pill = doc.data.components.Button!.styles.find((r) => r.user && r.when.variant === 'pill')!;
    expect(pill.style).toMatchObject({ radius: { token: 'radius.full' }, font: { weight: 700 } });
  });

  it('user rules survive library upgrades; reset returns to the library look', () => {
    const doc = createDocument();
    applyRdl(doc, 'component @Button\n  variant=pill rfull');
    const upgraded = withLibrary(structuredClone(doc.data.components));
    expect(upgraded.Button!.axes.variant).toContain('pill');
    expect(upgraded.Button!.styles.filter((r) => r.user)).toHaveLength(1);
    applyRdl(doc, 'component @Button reset');
    expect(doc.data.components.Button!.styles.some((r) => r.user)).toBe(false);
    expect(() => applyRdl(doc, 'component @Button none')).toThrow(/library component/);
  });

  it('prints customisations back as an editable block that re-applies identically', () => {
    const doc = createDocument();
    applyRdl(doc, 'component @Button\n  variant=pill rfull px6 fill:success.600\n  size=xl h56 row gap3\n  * shadow:md');
    const block = componentRdl(doc, 'Button');
    expect(block).toBe('component @Button\n  variant=pill py0px px6 fill:success.600 rfull\n  size=xl row gap3 h56\n  * shadow:md');
    const copy = createDocument();
    applyRdl(copy, block);
    expect(copy.data.components.Button!.styles.filter((r) => r.user)).toEqual(doc.data.components.Button!.styles.filter((r) => r.user));
    expect(componentRdl(createDocument(), 'Button')).toBe('');
  });

  it('rejects bad rules with guidance', () => {
    const doc = createDocument();
    expect(() => applyRdl(doc, 'component @Nope\n  * rfull')).toThrow(/not found/);
    expect(() => applyRdl(doc, 'component @Button\n  pill rfull')).toThrow(/axis=value/);
    expect(() => applyRdl(doc, 'component @Button\n  variant=pill')).toThrow(/no styles/);
  });
});

const PLAN = `Plan col gap3 p5 w280 fill:surface stroke:border rcard
  Name text title-sm "Starter"
  Price text headline "$0"
  Note text body-sm muted "For side projects"
  Mark icon:check w16 h16
  @Button variant=secondary "Choose plan"`;

describe('building blocks (component from layers)', () => {
  it('turns layers into a linked component with slots, and instances fill them', () => {
    const doc = createDocument();
    applyRdl(doc, PLAN);
    applyRdl(doc, 'component @PlanCard from #n1 "Pricing tier card"');
    const def = doc.data.components.PlanCard!;
    expect(Object.keys(def.slots!)).toEqual(['name', 'price', 'note', 'mark']);
    expect(def.labelProp).toBe('name');
    // the source layers became an instance with the same id
    expect(doc.node('n1')).toMatchObject({ type: 'instance', component: 'PlanCard' });
    expect(doc.page().nodes.n2).toBeUndefined();

    applyRdl(doc, '@PlanCard "Team" price="$49" note=none mark=ui/star');
    const { html, css } = renderFragment(doc);
    expect(html).toContain('>Starter<');
    expect(html).toContain('>Team<');
    expect(html).toContain('>$49<');
    expect(css).toContain('.r-n7_t4{display:none'); // note=none hides that layer in the second instance only
    expect(css).not.toContain('.r-n1_t4{display:none');
    expect(html).toMatch(/class="r-n7 rc-PlanCard"/);
    // serialises as a plain instance line and round-trips
    const out = serializeRdl(doc);
    expect(out).toContain('@PlanCard#n7 price=$49 note=none mark=ui/star "Team"');
    const copy = createDocument();
    copy.data.components = structuredClone(doc.data.components);
    applyRdl(copy, out);
    expect(serializeRdl(copy)).toBe(out);
    expect(lint(doc).filter((i) => i.severity === 'P0')).toEqual([]);
  });

  it('editing the definition updates every instance (detach → edit → from)', () => {
    const doc = createDocument();
    applyRdl(doc, PLAN);
    applyRdl(doc, 'component @PlanCard from #n1\n@PlanCard "Team"');
    const team = doc.page().children.at(-1)!;
    applyRdl(doc, 'component @PlanCard detach #n1');
    const n1 = doc.node('n1')!;
    expect(n1.type).toBe('frame');
    const priceId = n1.children!.find((c) => doc.node(c)!.name === 'Price')!;
    applyRdl(doc, `set #${priceId} color:primary.700 "$0 forever"\ncomponent @PlanCard from #n1`);
    const { html } = renderFragment(doc);
    expect(html.match(/\$0 forever/g)).toHaveLength(2); // both instances follow the new definition
    expect(doc.node(team)).toMatchObject({ component: 'PlanCard', props: { name: 'Team' } });
  });

  it('component rules style the root of a building block; unused ones can be deleted', () => {
    const doc = createDocument();
    applyRdl(doc, PLAN);
    applyRdl(doc, 'component @PlanCard from #n1\ncomponent @PlanCard\n  tone=featured fill:primary.50 stroke:primary.600/2');
    applyRdl(doc, '@PlanCard tone=featured "Pro"');
    const { css } = renderFragment(doc);
    expect(css).toMatch(/background:var\(--color-primary-50\)[^}]*box-shadow:inset 0 0 0 2px var\(--color-primary-600\)/);
    expect(() => applyRdl(doc, 'component @PlanCard none')).toThrow(/used by 2 layer/);
  });

  it('a new axis defaults to "default" so existing instances keep their look; unknown slots are errors', () => {
    const doc = createDocument();
    applyRdl(doc, PLAN);
    applyRdl(doc, 'component @PlanCard from #n1\ncomponent @PlanCard\n  tone=featured fill:primary.50');
    expect(doc.data.components.PlanCard!.axes.tone).toEqual(['default', 'featured']);
    expect(doc.data.components.PlanCard!.defaults.tone).toBe('default');
    expect(renderFragment(doc).css).not.toContain('primary-50');
    expect(() => applyRdl(doc, '@PlanCard perk-text="x"')).toThrow(/no slot "perk-text" — slots: name, price, note, mark; axes: tone/);
  });

  it('a component cannot contain itself', () => {
    const doc = createDocument();
    applyRdl(doc, 'Box col p2\n  Text "x"');
    applyRdl(doc, 'component @Box from #n1 keep');
    applyRdl(doc, 'insert #n1 end\n  @Box');
    applyRdl(doc, 'component @Box from #n1 keep');
    expect(() => renderFragment(doc)).not.toThrow();
  });
});
