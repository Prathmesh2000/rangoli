import { describe, expect, it } from 'vitest';

import { LIMITS, SCHEMA_VERSION } from './limits.js';
import { FigmaExportSchema, parseFigmaExport, type FigmaExport } from './schema.js';

const node = (id: string, parentId: string | null = null) => ({ id, parentId, pageId: '0:1', type: 'FRAME', name: 'n' });

function valid(): FigmaExport {
  return {
    format: 'rangoli.figma-export',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: '2026-11-09T00:00:00.000Z',
    source: { fileName: 'f', fileKey: null, editorType: 'figma', pluginVersion: '0.1.0' },
    pages: [{ id: '0:1', name: 'P', wholePage: true }],
    roots: [{ nodeId: '1:1', pageId: '0:1', origin: 'selected' }],
    nodes: [node('1:1'), node('1:2', '1:1')],
    components: [],
    variables: { collections: [], items: [] },
    styles: [],
    fonts: [],
    images: [],
    previews: [],
    gaps: [],
    gapSummary: [],
    stats: { nodes: 2, textNodes: 0, instances: 0, vectorNodes: 0, complete: true },
  };
}

const check = (value: unknown) => FigmaExportSchema.safeParse(value);
const messages = (value: unknown) => {
  const result = check(value);
  return result.success ? [] : result.error.issues.map((i) => i.message);
};

describe('FigmaExportSchema', () => {
  it('accepts a minimal valid export', () => {
    expect(check(valid()).success).toBe(true);
  });

  it('rejects other versions and formats', () => {
    expect(check({ ...valid(), schemaVersion: 2 }).success).toBe(false);
    expect(check({ ...valid(), format: 'other' }).success).toBe(false);
  });

  it('rejects unknown keys at every level', () => {
    expect(check({ ...valid(), extra: 1 }).success).toBe(false);
    const data = valid();
    (data.nodes[0] as Record<string, unknown>)['onclick'] = 'x';
    expect(check(data).success).toBe(false);
  });

  it('rejects __proto__ smuggled in through JSON', () => {
    const text = JSON.stringify(valid()).replace('"format"', '"__proto__":{"polluted":true},"format"');
    expect(parseFigmaExport(text).ok).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('enforces array caps', () => {
    const tooMany = Array.from({ length: LIMITS.maxNodes + 1 }, (_, i) => node(`1:${i}`));
    expect(check({ ...valid(), nodes: tooMany }).success).toBe(false);
    expect(check({ ...valid(), gaps: Array(LIMITS.maxGaps + 1).fill({ code: 'x', severity: 'info', message: 'm' }) }).success).toBe(false);
  });

  it('enforces string caps and shapes', () => {
    const longName = valid();
    longName.nodes[0]!.name = 'x'.repeat(LIMITS.maxNameLength + 1);
    expect(check(longName).success).toBe(false);

    const badId = valid();
    badId.nodes[1]!.parentId = '1:1"><script>';
    expect(check(badId).success).toBe(false);

    const badToken = valid();
    badToken.nodes[0]!.blendMode = 'x;y';
    expect(check(badToken).success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const data = valid();
    data.nodes[0]!.width = Infinity;
    expect(check(data).success).toBe(false);
  });

  it('rejects markup in vector path data and unsafe link schemes', () => {
    const vector = valid();
    vector.nodes[0]!.vector = { fillGeometry: [{ windingRule: 'NONZERO', data: '<script>' }] };
    expect(check(vector).success).toBe(false);

    for (const value of ['javascript:alert(1)', 'data:text/html,x', ' javascript:x']) {
      const text = valid();
      text.nodes[0]!.text = { characters: 'a', segments: [{ start: 0, end: 1, hyperlink: { type: 'URL', value } }] };
      expect(check(text).success).toBe(false);
    }
  });

  it('rejects children before parents, which also rules out cycles', () => {
    const data = valid();
    data.nodes = [node('1:2', '1:1'), node('1:1', '1:2')];
    expect(messages(data)).toContain('parent must appear before child');
  });

  it('rejects trees past the depth cap', () => {
    const chain = [node('1:0')];
    for (let i = 1; i <= LIMITS.maxDepth + 1; i += 1) chain.push(node(`1:${i}`, `1:${i - 1}`));
    expect(messages({ ...valid(), nodes: chain, roots: [{ nodeId: '1:0', pageId: '0:1', origin: 'selected' }] })).toContain('tree too deep');
  });

  it('checks references between sections', () => {
    expect(messages({ ...valid(), nodes: [...valid().nodes, node('1:1')] })).toContain('duplicate node id');
    expect(messages({ ...valid(), nodes: [...valid().nodes, node('1:3')] })).toContain('parentless node is not a root');
    expect(messages({ ...valid(), roots: [{ nodeId: '1:2', pageId: '0:1', origin: 'selected' }] })).toContain('root is not a parentless node');
    expect(messages({ ...valid(), nodes: [{ ...node('1:1'), pageId: '0:9' }, node('1:2', '1:1')] })).toContain('unknown page');

    const instance = valid();
    instance.nodes[1]!.instance = { mainComponentId: '4:4', properties: [], overrides: [] };
    expect(messages(instance)).toContain('instance references unknown component');
  });

  it('caps image size per image and in total', () => {
    const image = (hash: string, length: number) => ({
      hash,
      mime: 'image/png',
      width: 1,
      height: 1,
      byteLength: 1,
      base64: 'A'.repeat(length),
    });
    const perImage = Math.ceil(LIMITS.maxImageBytes / 3) * 4;
    expect(check({ ...valid(), images: [image('a', perImage + 4)] }).success).toBe(false);

    const count = Math.ceil(LIMITS.maxTotalImageBytes / LIMITS.maxImageBytes) + 1;
    const images = Array.from({ length: count }, (_, i) => image(`h${i}`, perImage));
    expect(messages({ ...valid(), images })).toContain('images too large');
  });
});

describe('parseFigmaExport', () => {
  it('reports malformed JSON without throwing', () => {
    expect(parseFigmaExport('{nope')).toMatchObject({ ok: false, error: 'Export is not valid JSON.' });
  });

  it('reports issue paths', () => {
    const data = valid();
    data.nodes[0]!.width = 'x' as never;
    const result = parseFigmaExport(JSON.stringify(data));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues[0]?.path).toBe('nodes.0.width');
  });

  it('rejects oversized input before parsing', () => {
    const huge = { length: LIMITS.maxExportBytes + 1 } as unknown as string;
    expect(parseFigmaExport(huge)).toMatchObject({ ok: false, error: 'Export is larger than the size limit.' });
  });
});
