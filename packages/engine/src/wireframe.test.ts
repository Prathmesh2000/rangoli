import { describe, expect, it } from 'vitest';
import { createDocument } from './components.js';
import { lint } from './lint.js';
import { PATTERNS } from './patterns.js';
import { applyRdl } from './rdl.js';
import { renderFragment } from './render.js';
import { emptyReviews } from './review.js';
import { annotationsOf, applySkin, skinCss, suggestTemplate, WF_DEVICES, WF_TEMPLATE_IDS, WIREFRAME_PATTERNS, wireframeScript, wireframeSpecHtml, type WfDevice } from './wireframe.js';

const blocking = (doc: ReturnType<typeof createDocument>) => lint(doc).filter((i) => i.severity === 'P0' || i.severity === 'P1');

describe('wireframe kit', () => {
  it('is registered with the other patterns', () => {
    for (const name of Object.keys(WIREFRAME_PATTERNS)) expect(PATTERNS[name], name).toBeDefined();
  });

  it.each(Object.keys(WIREFRAME_PATTERNS))('+%s renders', (name) => {
    const doc = createDocument();
    applyRdl(doc, `Wrap col p4 w800 h600 fill:surface\n  +${name}`);
    expect(renderFragment(doc).html).not.toContain('undefined');
    expect(blocking(doc)).toEqual([]);
  });
});

describe('starting layouts', () => {
  const cases = WF_TEMPLATE_IDS.flatMap((t) => (Object.keys(WF_DEVICES) as WfDevice[]).map((d) => [t, d] as const));

  it.each(cases)('%s on %s builds a frame of the right size with no blocking lint', (template, device) => {
    const doc = createDocument();
    const r = applyRdl(doc, wireframeScript('Run "results" \\ page', 'Watch a run', template, device));
    const frame = doc.node(r.created[0]!);
    expect(frame.name).toBe('Run "results" \\ page');
    expect(frame.parent).toBeUndefined();
    expect(frame.size?.w).toEqual({ kind: 'fixed', v: WF_DEVICES[device].w });
    expect(blocking(doc)).toEqual([]);
  });

  it('suggests a layout from what the screen is called', () => {
    expect(suggestTemplate('Login')).toBe('login');
    expect(suggestTemplate('Team dashboard')).toBe('dashboard');
    expect(suggestTemplate('Payment')).toBe('checkout');
    expect(suggestTemplate('Weekly thing', 'search across runs')).toBe('search');
    expect(suggestTemplate('Zzz')).toBe('blank');
  });
});

describe('skins', () => {
  it('leave a hi-fi page untouched and never alter the document', () => {
    expect(applySkin('<html><head></head><body></body></html>', 'none', '.x')).not.toContain('<style>');
    const out = applySkin('<html><head></head><body class="a"></body></html>', 'sketch', '.x');
    expect(out).toContain('rk-rough');
    expect(out).toMatch(/<body class="a"><svg/);
    expect(skinCss('clean', '.x')).not.toContain('rk-rough');
  });
});

describe('annotations', () => {
  const setup = () => {
    const doc = createDocument();
    const id = applyRdl(doc, 'Screen col w400 h300 fill:surface\n  Text title "Hello"').created[0]!;
    const reviews = emptyReviews();
    const note = (tid: string, body: string, kind: 'annotation' | 'comment' = 'annotation', resolved = false) =>
      reviews.threads.push({ id: tid, node: id, kind, resolved, comments: [{ id: 'c1', author: 'a', body, time: 1 }], time: 1 });
    return { doc, id, reviews, note };
  };

  it('number only live annotations, in order', () => {
    const { reviews, note } = setup();
    note('t1', 'first');
    note('t2', 'a comment', 'comment');
    note('t3', 'removed', 'annotation', true);
    note('t4', 'second');
    expect(annotationsOf(reviews).map((a) => [a.n, a.body])).toEqual([[1, 'first'], [2, 'second']]);
  });

  it('appear in the spec, escaped', () => {
    const { doc, reviews, note } = setup();
    note('t1', '<script>alert(1)</script> validates email');
    const html = wireframeSpecHtml(doc, reviews, { title: 'A <b>' });
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; validates email');
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('A &lt;b&gt;: wireframes');
  });
});
