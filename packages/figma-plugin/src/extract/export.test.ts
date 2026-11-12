import { describe, expect, it } from 'vitest';

import type { ExportOptions, ExportSelection, FigmaHost } from '../host.js';
import { LIMITS } from '../limits.js';
import { FigmaExportSchema, parseFigmaExport, type ExportNode, type FigmaExport } from '../schema.js';
import { ExportCancelled, buildExport } from './export.js';
import { MIXED, PNG_BYTES, SOLID_RED, mockHost, mockImage, mockNode, mockPage } from './test-helpers.js';

const OPTIONS: ExportOptions = { includeImages: true, includePreviews: false };
const wholePage = (pageId: string): ExportSelection => ({ pages: [{ pageId, nodeIds: null }] });

async function run(host: FigmaHost, selection: ExportSelection, options = OPTIONS): Promise<FigmaExport> {
  const data = await buildExport(host, selection, options);
  // Every scenario must also satisfy the schema the server will use.
  const parsed = FigmaExportSchema.safeParse(JSON.parse(JSON.stringify(data)));
  if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues.slice(0, 5)));
  return data;
}

const nodeOf = (data: FigmaExport, id: string): ExportNode => {
  const node = data.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`no node ${id}`);
  return node;
};
const gapCodes = (data: FigmaExport) => data.gaps.map((g) => g.code);

describe('layout capture', () => {
  it('captures auto layout, child sizing, constraints and transforms', async () => {
    const child = mockNode({
      id: '1:2',
      type: 'RECTANGLE',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      layoutAlign: 'STRETCH',
      layoutGrow: 1,
      layoutPositioning: 'ABSOLUTE',
      constraints: { horizontal: 'SCALE', vertical: 'MIN' },
      minWidth: 10,
      maxWidth: null,
    });
    const frame = mockNode({
      id: '1:1',
      type: 'FRAME',
      x: 5,
      y: 6,
      width: 100,
      height: 50,
      rotation: 15,
      relativeTransform: [[1, 0, 5], [0, 1, 6]],
      absoluteBoundingBox: { x: 5, y: 6, width: 100, height: 50 },
      absoluteRenderBounds: null,
      layoutMode: 'HORIZONTAL',
      layoutWrap: 'WRAP',
      primaryAxisSizingMode: 'AUTO',
      counterAxisSizingMode: 'FIXED',
      primaryAxisAlignItems: 'SPACE_BETWEEN',
      counterAxisAlignItems: 'BASELINE',
      counterAxisAlignContent: 'AUTO',
      paddingLeft: 1,
      paddingRight: 2,
      paddingTop: 3,
      paddingBottom: 4,
      itemSpacing: 8,
      counterAxisSpacing: 12,
      itemReverseZIndex: true,
      strokesIncludedInLayout: true,
      clipsContent: true,
      children: [child],
    });

    const data = await run(mockHost([mockPage('0:1', [frame])]), wholePage('0:1'));
    const f = nodeOf(data, '1:1');
    expect(f).toMatchObject({
      parentId: null,
      pageId: '0:1',
      x: 5,
      rotation: 15,
      relativeTransform: [[1, 0, 5], [0, 1, 6]],
      absoluteBoundingBox: { width: 100 },
      layoutMode: 'HORIZONTAL',
      layoutWrap: 'WRAP',
      primaryAxisAlignItems: 'SPACE_BETWEEN',
      counterAxisAlignItems: 'BASELINE',
      paddingBottom: 4,
      itemSpacing: 8,
      counterAxisSpacing: 12,
      itemReverseZIndex: true,
      clipsContent: true,
    });
    expect(f.absoluteRenderBounds).toBeUndefined();

    const c = nodeOf(data, '1:2');
    expect(c).toMatchObject({
      parentId: '1:1',
      layoutSizingHorizontal: 'FILL',
      layoutSizingVertical: 'HUG',
      layoutGrow: 1,
      layoutPositioning: 'ABSOLUTE',
      constraints: { horizontal: 'SCALE', vertical: 'MIN' },
      minWidth: 10,
    });
    expect(c.maxWidth).toBeUndefined();
    expect(data.roots).toEqual([{ nodeId: '1:1', pageId: '0:1', origin: 'selected' }]);
  });

  it('captures grid layout only where it applies', async () => {
    const gridChild = mockNode({ id: '1:2', type: 'FRAME', gridRowAnchorIndex: 1, gridColumnSpan: 2, gridChildHorizontalAlign: 'CENTER' });
    const grid = mockNode({
      id: '1:1',
      type: 'FRAME',
      layoutMode: 'GRID',
      gridRowCount: 2,
      gridColumnGap: 4,
      gridRowSizes: [{ type: 'FLEX', value: 1 }, { type: 'HUG' }],
      children: [gridChild],
    });
    const plain = mockNode({
      id: '1:3',
      type: 'FRAME',
      layoutMode: 'NONE',
      get gridRowCount(): number {
        throw new Error('not a grid');
      },
    });
    const data = await run(mockHost([mockPage('0:1', [grid, plain])]), wholePage('0:1'));
    expect(nodeOf(data, '1:1')).toMatchObject({ gridRowCount: 2, gridRowSizes: [{ type: 'FLEX', value: 1 }, { type: 'HUG' }] });
    expect(nodeOf(data, '1:2')).toMatchObject({ gridRowAnchorIndex: 1, gridColumnSpan: 2 });
    expect(gapCodes(data)).not.toContain('read-failed');
  });
});

describe('appearance', () => {
  it('captures every paint and effect family, and marks mixed values', async () => {
    const rect = mockNode({
      id: '1:1',
      type: 'RECTANGLE',
      fills: [
        { ...SOLID_RED, boundVariables: { color: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' } } },
        { type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 0, g: 0, b: 0, a: 1 } }] },
        { type: 'IMAGE', scaleMode: 'CROP', imageHash: 'abc123', imageTransform: [[1, 0, 0], [0, 1, 0]], filters: { contrast: 0.5 } },
        { type: 'PATTERN', sourceNodeId: '9:9', tileType: 'RECTANGULAR', scalingFactor: 1, spacing: { x: 0, y: 0 }, horizontalAlignment: 'START' },
      ],
      strokes: [SOLID_RED],
      strokeWeight: MIXED,
      strokeTopWeight: 1,
      strokeLeftWeight: 3,
      strokeAlign: 'INSIDE',
      dashPattern: [2, 4],
      cornerRadius: MIXED,
      topLeftRadius: 4,
      bottomRightRadius: 8,
      effects: [
        { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 1, y: 2 }, radius: 4, spread: 1, visible: true, blendMode: 'NORMAL' },
        { type: 'LAYER_BLUR', radius: 3, visible: true, blurType: 'PROGRESSIVE', startRadius: 1, startOffset: { x: 0, y: 0 }, endOffset: { x: 1, y: 1 } },
        { type: 'GLASS', visible: true, radius: 2, refraction: 0.3, depth: 1, dispersion: 0, lightAngle: 45, lightIntensity: 0.5 },
      ],
      layoutGrids: [{ pattern: 'COLUMNS', alignment: 'STRETCH', gutterSize: 8, count: 12 }],
      fillStyleId: 'S:abc,1:1',
      effectStyleId: '',
    });
    const host = mockHost([mockPage('0:1', [rect])], {
      getImageByHash: () => mockImage(PNG_BYTES),
    });
    const data = await run(host, wholePage('0:1'));
    const r = nodeOf(data, '1:1');

    expect(r.fills?.map((f) => f.type)).toEqual(['SOLID', 'GRADIENT_LINEAR', 'IMAGE', 'PATTERN']);
    expect(r.fills?.[0]).toMatchObject({ boundVariables: [{ field: 'color', ids: ['VariableID:1:1'] }] });
    expect(r.mixed).toEqual(expect.arrayContaining(['strokeWeight', 'cornerRadius']));
    expect(r).toMatchObject({ strokeTopWeight: 1, topLeftRadius: 4, strokeAlign: 'INSIDE', dashPattern: [2, 4], fillStyleId: 'S:abc,1:1' });
    expect(r.effectStyleId).toBeUndefined();
    expect(r.effects?.map((e) => e.type)).toEqual(['DROP_SHADOW', 'LAYER_BLUR', 'GLASS']);
    expect(r.effects?.[1]).toMatchObject({ blurType: 'PROGRESSIVE', endOffset: { x: 1, y: 1 } });
    expect(r.layoutGrids?.[0]).toMatchObject({ pattern: 'COLUMNS', count: 12 });
  });

  it('keeps the stack position of unrepresentable paints and records them', async () => {
    const rect = mockNode({
      id: '1:1',
      type: 'RECTANGLE',
      fills: [{ type: 'SHADER', id: 'x', visible: true }, SOLID_RED, { type: 'VIDEO', scaleMode: 'FILL', videoHash: 'deadbeef' }],
      effects: [{ type: 'SHADER', id: 'x', visible: true }],
    });
    const data = await run(mockHost([mockPage('0:1', [rect])]), wholePage('0:1'));
    const r = nodeOf(data, '1:1');
    expect(r.fills?.map((f) => f.type)).toEqual(['UNSUPPORTED', 'SOLID', 'VIDEO']);
    expect(r.effects?.[0]).toEqual({ type: 'SHADER', unsupported: true });
    expect(gapCodes(data)).toEqual(expect.arrayContaining(['unsupported-paint', 'unsupported-effect', 'video-not-exported']));
  });
});

describe('text', () => {
  const textNode = (extra: Record<string, unknown> = {}) =>
    mockNode({
      id: '1:1',
      type: 'TEXT',
      characters: 'Hello world',
      fontSize: MIXED,
      fontName: MIXED,
      fills: MIXED,
      textStyleId: MIXED,
      textAlignHorizontal: 'CENTER',
      textAutoResize: 'HEIGHT',
      textTruncation: 'ENDING',
      maxLines: 2,
      leadingTrim: 'CAP_HEIGHT',
      hasMissingFont: false,
      getStyledTextSegments: () => [
        {
          characters: 'Hello ',
          start: 0,
          end: 6,
          fontSize: 12,
          fontName: { family: 'Inter', style: 'Regular' },
          fontWeight: 400,
          lineHeight: { unit: 'AUTO' },
          letterSpacing: { unit: 'PERCENT', value: 2 },
          textDecoration: 'NONE',
          textCase: 'ORIGINAL',
          fills: [SOLID_RED],
          listOptions: { type: 'NONE' },
          hyperlink: null,
          openTypeFeatures: { SUPS: true },
          textStyleId: 'S:t,1:1',
        },
        {
          characters: 'world',
          start: 6,
          end: 11,
          fontSize: 20,
          fontName: { family: 'Inter', style: 'Bold' },
          fontWeight: 700,
          lineHeight: { unit: 'PIXELS', value: 24 },
          letterSpacing: { unit: 'PIXELS', value: 0 },
          textDecoration: 'UNDERLINE',
          textCase: 'UPPER',
          fills: [],
          listOptions: { type: 'UNORDERED' },
          hyperlink: { type: 'URL', value: 'https://example.com' },
        },
      ],
      ...extra,
    });

  it('captures mixed-style segments and node-level text settings', async () => {
    const data = await run(mockHost([mockPage('0:1', [textNode()])]), wholePage('0:1'));
    const t = nodeOf(data, '1:1');
    expect(t.text?.characters).toBe('Hello world');
    expect(t.text?.segments).toHaveLength(2);
    expect(t.text?.segments[1]).toMatchObject({
      start: 6,
      end: 11,
      fontSize: 20,
      fontName: { family: 'Inter', style: 'Bold' },
      lineHeight: { unit: 'PIXELS', value: 24 },
      textDecoration: 'UNDERLINE',
      listType: 'UNORDERED',
      hyperlink: { type: 'URL', value: 'https://example.com' },
    });
    expect(t.text?.segments[0]?.openTypeFeatures).toEqual([{ tag: 'SUPS', enabled: true }]);
    expect(t.text).toMatchObject({ textAlignHorizontal: 'CENTER', maxLines: 2, leadingTrim: 'CAP_HEIGHT' });
    expect(t.mixed).toEqual(expect.arrayContaining(['fills', 'textStyleId']));
    expect(data.fonts).toEqual([{ family: 'Inter', style: 'Regular' }, { family: 'Inter', style: 'Bold' }]);
  });

  it('reports missing fonts', async () => {
    const data = await run(mockHost([mockPage('0:1', [textNode({ hasMissingFont: true })])]), wholePage('0:1'));
    const gap = data.gaps.find((g) => g.code === 'missing-font');
    expect(gap).toMatchObject({ nodeId: '1:1', severity: 'warning' });
    expect(gap?.message).toContain('Inter Bold');
  });

  it('falls back to core fields, then records total failure', async () => {
    let calls = 0;
    const fallback = textNode({
      getStyledTextSegments: (fields: string[]) => {
        calls += 1;
        if (fields.includes('textWrapStyle')) throw new Error('unknown field');
        return [{ start: 0, end: 11, fontSize: 9 }];
      },
    });
    let data = await run(mockHost([mockPage('0:1', [fallback])]), wholePage('0:1'));
    expect(calls).toBe(2);
    expect(nodeOf(data, '1:1').text?.segments).toEqual([{ start: 0, end: 11, fontSize: 9 }]);
    expect(gapCodes(data)).toContain('text-segment-fields-reduced');

    const broken = textNode({
      getStyledTextSegments: () => {
        throw new Error('nope');
      },
    });
    data = await run(mockHost([mockPage('0:1', [broken])]), wholePage('0:1'));
    expect(nodeOf(data, '1:1').text?.segments).toEqual([]);
    expect(data.gaps.find((g) => g.code === 'text-segments-unavailable')?.severity).toBe('error');
  });

  it('drops unsafe hyperlinks and truncates oversized text with a gap', async () => {
    const node = textNode({
      characters: 'x'.repeat(LIMITS.maxTextCharacters + 5),
      getStyledTextSegments: () => [
        { start: 0, end: LIMITS.maxTextCharacters + 5, hyperlink: { type: 'URL', value: 'javascript:alert(1)' } },
      ],
    });
    const data = await run(mockHost([mockPage('0:1', [node])]), wholePage('0:1'));
    const t = nodeOf(data, '1:1').text;
    expect(t?.characters).toHaveLength(LIMITS.maxTextCharacters);
    expect(t?.segments[0]?.end).toBe(LIMITS.maxTextCharacters);
    expect(t?.segments[0]?.hyperlink).toBeUndefined();
    expect(gapCodes(data)).toEqual(expect.arrayContaining(['text-truncated', 'hyperlink-dropped']));
  });
});

describe('vectors', () => {
  it('captures paths, geometry and the vector network', async () => {
    const vector = mockNode({
      id: '1:1',
      type: 'VECTOR',
      vectorPaths: [{ windingRule: 'EVENODD', data: 'M 0 0 L 10 10 Z' }],
      fillGeometry: [{ windingRule: 'NONZERO', data: 'M 0 0 L 1 1 Z' }],
      strokeGeometry: [],
      handleMirroring: MIXED,
      vectorNetwork: {
        vertices: [{ x: 0, y: 0, strokeCap: 'ROUND' }, { x: 1, y: 1, cornerRadius: 2 }],
        segments: [{ start: 0, end: 1, tangentStart: { x: 1, y: 0 } }],
        regions: [{ windingRule: 'NONZERO', loops: [[0]], fills: [SOLID_RED] }],
      },
    });
    const bool = mockNode({ id: '1:2', type: 'BOOLEAN_OPERATION', booleanOperation: 'SUBTRACT', fillGeometry: [{ windingRule: 'NONZERO', data: 'M0 0Z' }], children: [] });
    const star = mockNode({ id: '1:3', type: 'STAR', pointCount: 5, innerRadius: 0.4, fillGeometry: [] });
    const arc = mockNode({ id: '1:4', type: 'ELLIPSE', arcData: { startingAngle: 0, endingAngle: 3, innerRadius: 0.5 }, fillGeometry: [] });
    const data = await run(mockHost([mockPage('0:1', [vector, bool, star, arc])]), wholePage('0:1'));

    const v = nodeOf(data, '1:1');
    expect(v.vector?.vectorPaths?.[0]?.windingRule).toBe('EVENODD');
    expect(v.vector?.vectorNetwork?.vertices).toHaveLength(2);
    expect(v.vector?.vectorNetwork?.regions?.[0]?.fills).toHaveLength(1);
    expect(v.mixed).toContain('handleMirroring');
    expect(nodeOf(data, '1:2')).toMatchObject({ booleanOperation: 'SUBTRACT', vector: { fillGeometry: [{ data: 'M0 0Z' }] } });
    expect(nodeOf(data, '1:3')).toMatchObject({ pointCount: 5, innerRadius: 0.4 });
    expect(nodeOf(data, '1:4').arcData?.endingAngle).toBe(3);
    expect(data.stats.vectorNodes).toBe(4);
  });

  it('rejects path data that is not path grammar, and oversized networks', async () => {
    const bad = mockNode({
      id: '1:1',
      type: 'VECTOR',
      vectorPaths: [{ windingRule: 'NONZERO', data: 'M0 0"/><script>alert(1)</script>' }],
      vectorNetwork: {
        vertices: Array.from({ length: LIMITS.maxVectorVertices + 1 }, () => ({ x: 0, y: 0 })),
        segments: [],
      },
    });
    const data = await run(mockHost([mockPage('0:1', [bad])]), wholePage('0:1'));
    expect(nodeOf(data, '1:1').vector?.vectorPaths).toEqual([]);
    expect(nodeOf(data, '1:1').vector?.vectorNetwork).toBeUndefined();
    expect(gapCodes(data)).toEqual(expect.arrayContaining(['vector-path-invalid', 'vector-network-too-large']));
  });
});

describe('components', () => {
  function designSystem() {
    const iconMain = mockNode({ id: '5:1', type: 'COMPONENT', key: 'icon', remote: false, children: [] });
    const primary = mockNode({
      id: '4:2',
      type: 'COMPONENT',
      key: 'k-primary',
      variantProperties: { State: 'Primary', __proto__x: 'y' },
      get componentPropertyDefinitions(): never {
        throw new Error('definitions can only be read on the set');
      },
      children: [
        mockNode({
          id: '4:3',
          type: 'INSTANCE',
          getMainComponentAsync: async () => iconMain,
          componentProperties: {},
          overrides: [],
          children: [],
        }),
      ],
    });
    const secondary = mockNode({ id: '4:4', type: 'COMPONENT', key: 'k-secondary', variantProperties: { State: 'Secondary' }, children: [] });
    const set = mockNode({
      id: '4:1',
      type: 'COMPONENT_SET',
      key: 'k-set',
      name: 'Button',
      description: 'A button',
      componentPropertyDefinitions: {
        State: { type: 'VARIANT', defaultValue: 'Primary', variantOptions: ['Primary', 'Secondary'] },
        Label: { type: 'TEXT', defaultValue: 'Click' },
      },
      children: [primary, secondary],
    });
    Object.defineProperty(set, 'defaultVariant', { value: primary, enumerable: false });
    return { iconMain, primary, secondary, set };
  }

  function libraryPage() {
    const { iconMain, primary, set } = designSystem();
    return { page: mockPage('0:2', [set, iconMain]), primary, set };
  }

  it('captures variants, definitions, overrides and instance properties', async () => {
    const { page, primary } = libraryPage();
    const instance = mockNode({
      id: '1:1',
      type: 'INSTANCE',
      scaleFactor: 2,
      getMainComponentAsync: async () => primary,
      componentProperties: {
        State: { type: 'VARIANT', value: 'Primary' },
        Label: { type: 'TEXT', value: 'Buy', boundVariables: { value: { type: 'VARIABLE_ALIAS', id: 'VariableID:7:7' } } },
      },
      overrides: [{ id: 'I1:1;4:3', overriddenFields: ['characters', 'fills'] }],
      children: [],
    });
    const data = await run(
      mockHost([mockPage('0:1', [instance]), page]),
      { pages: [{ pageId: '0:1', nodeIds: ['1:1'] }] },
    );

    expect(nodeOf(data, '1:1').instance).toEqual({
      mainComponentId: '4:2',
      scaleFactor: 2,
      properties: [
        { name: 'State', type: 'VARIANT', value: 'Primary' },
        { name: 'Label', type: 'TEXT', value: 'Buy', boundVariables: [{ field: 'value', ids: ['VariableID:7:7'] }] },
      ],
      overrides: [{ id: 'I1:1;4:3', fields: ['characters', 'fills'] }],
    });

    // The whole set is pulled in as a definition, plus the nested icon it uses.
    expect(data.roots).toEqual([
      { nodeId: '1:1', pageId: '0:1', origin: 'selected' },
      { nodeId: '4:1', pageId: '0:2', origin: 'component-definition' },
      { nodeId: '5:1', pageId: '0:2', origin: 'component-definition' },
    ]);
    expect(nodeOf(data, '4:1').component).toMatchObject({
      key: 'k-set',
      description: 'A button',
      defaultVariantId: '4:2',
      propertyDefinitions: [
        { name: 'State', type: 'VARIANT', defaultValue: 'Primary', variantOptions: ['Primary', 'Secondary'] },
        { name: 'Label', type: 'TEXT', defaultValue: 'Click' },
      ],
    });
    expect(nodeOf(data, '4:2').component?.variantProperties).toEqual([
      { name: 'State', value: 'Primary' },
      { name: '__proto__x', value: 'y' },
    ]);
    expect(nodeOf(data, '4:2').component?.propertyDefinitions).toBeUndefined();

    const catalog = data.components.find((c) => c.id === '4:2');
    expect(catalog).toMatchObject({ definition: 'captured', componentSetId: '4:1', componentSetName: 'Button', pageId: '0:2' });
    expect(data.components.map((c) => c.id).sort()).toEqual(['4:2', '4:4', '5:1']);
    expect(gapCodes(data)).not.toContain('read-failed');
  });

  it('treats a property literally named __proto__ as data', async () => {
    const properties = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(properties, '__proto__', {
      value: { type: 'TEXT', value: 'evil' },
      enumerable: true,
    });
    const instance = mockNode({
      id: '1:1',
      type: 'INSTANCE',
      getMainComponentAsync: async () => null,
      componentProperties: properties,
      overrides: [],
    });
    const data = await run(mockHost([mockPage('0:1', [instance])]), wholePage('0:1'));
    expect(nodeOf(data, '1:1').instance?.properties).toEqual([{ name: '__proto__', type: 'TEXT', value: 'evil' }]);
    expect(({} as Record<string, unknown>)['value']).toBeUndefined();
  });

  it('records library components as metadata only and missing mains as gaps', async () => {
    const remote = mockNode({ id: '8:1', type: 'COMPONENT', key: 'lib', remote: true });
    const a = mockNode({ id: '1:1', type: 'INSTANCE', getMainComponentAsync: async () => remote, overrides: [], componentProperties: {} });
    const b = mockNode({ id: '1:2', type: 'INSTANCE', getMainComponentAsync: async () => null, overrides: [], componentProperties: {} });
    const c = mockNode({
      id: '1:3',
      type: 'INSTANCE',
      getMainComponentAsync: async () => {
        throw new Error('gone');
      },
      overrides: [],
      componentProperties: {},
    });
    const data = await run(mockHost([mockPage('0:1', [a, b, c])]), wholePage('0:1'));
    expect(data.components).toEqual([expect.objectContaining({ id: '8:1', remote: true, definition: 'metadata-only', pageId: null })]);
    expect(data.gaps.filter((g) => g.code === 'main-component-missing')).toHaveLength(2);
    expect(gapCodes(data)).toContain('remote-component-definition');
    expect(nodeOf(data, '1:2').instance?.mainComponentId).toBeNull();
  });
});

describe('variables and styles', () => {
  it('captures local variables of every value kind, and library variables in use', async () => {
    const rect = mockNode({
      id: '1:1',
      type: 'RECTANGLE',
      boundVariables: {
        width: { type: 'VARIABLE_ALIAS', id: 'VariableID:lib/2:1' },
        fills: [{ type: 'VARIABLE_ALIAS', id: 'VariableID:1:1' }],
        componentProperties: { Label: { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } },
      },
      explicitVariableModes: { 'VariableCollectionId:1:0': '1:1' },
      componentPropertyReferences: { visible: 'Show#1:2' },
    });
    const variable = (id: string, valuesByMode: Record<string, unknown>, extra = {}) => ({
      id,
      key: `key-${id}`,
      name: `color/${id}`,
      description: '',
      remote: false,
      hiddenFromPublishing: false,
      variableCollectionId: 'VariableCollectionId:1:0',
      resolvedType: 'COLOR',
      scopes: ['ALL_FILLS'],
      codeSyntax: { WEB: '--brand' },
      valuesByMode,
      ...extra,
    });
    const host = mockHost([mockPage('0:1', [rect])], {
      getLocalVariableCollectionsAsync: async () => [
        { id: 'VariableCollectionId:1:0', key: 'c', name: 'Theme', remote: false, defaultModeId: '1:0', modes: [{ modeId: '1:0', name: 'Light' }, { modeId: '1:1', name: 'Dark' }] },
      ],
      getLocalVariablesAsync: async () => [
        variable('VariableID:1:1', { '1:0': { r: 1, g: 1, b: 1, a: 1 }, '1:1': { type: 'VARIABLE_ALIAS', id: 'VariableID:1:2' } }),
        variable('VariableID:1:2', { '1:0': 4, '1:1': true }, { resolvedType: 'FLOAT' }),
        variable('VariableID:1:3', { '1:0': 'hello', '1:1': { type: 'EASING', x: 1 } }, { resolvedType: 'STRING' }),
      ],
      getVariableByIdAsync: async (id) => (id === 'VariableID:lib/2:1' ? variable(id, { '9:0': 2 }, { remote: true, variableCollectionId: 'VariableCollectionId:lib/1:0' }) : null),
      getVariableCollectionByIdAsync: async () => ({ id: 'VariableCollectionId:lib/1:0', key: 'l', name: 'Library', remote: true, defaultModeId: '9:0', modes: [{ modeId: '9:0', name: 'Default' }] }),
    });
    const data = await run(host, wholePage('0:1'));

    const r = nodeOf(data, '1:1');
    expect(r.boundVariables).toEqual(
      expect.arrayContaining([
        { field: 'width', ids: ['VariableID:lib/2:1'] },
        { field: 'fills', ids: ['VariableID:1:1'] },
        { field: 'componentProperties', key: 'Label', ids: ['VariableID:1:2'] },
      ]),
    );
    expect(r.explicitVariableModes).toEqual([{ collectionId: 'VariableCollectionId:1:0', modeId: '1:1' }]);
    expect(r.componentPropertyReferences).toEqual([{ field: 'visible', property: 'Show#1:2' }]);

    expect(data.variables.collections.map((c) => c.name)).toEqual(['Theme', 'Library']);
    const first = data.variables.items.find((v) => v.id === 'VariableID:1:1');
    expect(first?.values).toEqual([
      { modeId: '1:0', value: { kind: 'color', value: { r: 1, g: 1, b: 1, a: 1 } } },
      { modeId: '1:1', value: { kind: 'alias', id: 'VariableID:1:2' } },
    ]);
    expect(first?.codeSyntax).toEqual([{ platform: 'WEB', value: '--brand' }]);
    expect(data.variables.items.find((v) => v.id === 'VariableID:lib/2:1')?.remote).toBe(true);
    expect(data.variables.items.find((v) => v.id === 'VariableID:1:3')?.values[1]?.value).toEqual({ kind: 'unsupported' });
    expect(gapCodes(data)).toContain('variable-value-unsupported');
  });

  it('records failure when variables or styles are unavailable', async () => {
    const data = await run(
      mockHost([mockPage('0:1', [])], {
        getLocalVariablesAsync: async () => {
          throw new Error('plan limit');
        },
        getLocalTextStylesAsync: async () => {
          throw new Error('nope');
        },
      }),
      wholePage('0:1'),
    );
    expect(data.gaps.find((g) => g.code === 'variables-unavailable')?.severity).toBe('error');
    expect(gapCodes(data)).toContain('styles-unavailable');
  });

  it('captures local styles and flags library style references', async () => {
    const rect = mockNode({ id: '1:1', type: 'RECTANGLE', fillStyleId: 'S:local,1:1', strokeStyleId: 'S:lib,2:2' });
    const host = mockHost([mockPage('0:1', [rect])], {
      getLocalPaintStylesAsync: async () => [{ id: 'S:local,1:1', key: 'k', name: 'Brand', paints: [SOLID_RED] }],
      getLocalTextStylesAsync: async () => [{ id: 'S:t,1:1', key: 't', name: 'Body', fontName: { family: 'Inter', style: 'Regular' }, fontSize: 14, lineHeight: { unit: 'AUTO' }, letterSpacing: { unit: 'PERCENT', value: 0 }, textCase: 'ORIGINAL' }],
      getLocalEffectStylesAsync: async () => [{ id: 'S:e,1:1', key: 'e', name: 'Shadow', effects: [{ type: 'LAYER_BLUR', radius: 1, visible: true }] }],
      getLocalGridStylesAsync: async () => [{ id: 'S:g,1:1', key: 'g', name: 'Grid', layoutGrids: [{ pattern: 'GRID', sectionSize: 8 }] }],
    });
    const data = await run(host, wholePage('0:1'));
    expect(data.styles.map((s) => s.kind)).toEqual(['PAINT', 'TEXT', 'EFFECT', 'GRID']);
    expect(data.styles[1]?.text).toMatchObject({ fontSize: 14, fontName: { family: 'Inter' } });
    expect(data.gaps.filter((g) => g.code === 'library-style-reference').map((g) => g.field)).toEqual(['S:lib,2:2']);
  });
});

describe('images and previews', () => {
  const imageFill = (hash: string) => ({ type: 'IMAGE', scaleMode: 'FILL', imageHash: hash });

  it('embeds image bytes once per hash, with sniffed type and size', async () => {
    const a = mockNode({ id: '1:1', type: 'RECTANGLE', fills: [imageFill('aaa')] });
    const b = mockNode({ id: '1:2', type: 'RECTANGLE', fills: [imageFill('aaa')] });
    const data = await run(mockHost([mockPage('0:1', [a, b])], { getImageByHash: () => mockImage(PNG_BYTES) }), wholePage('0:1'));
    expect(data.images).toEqual([
      { hash: 'aaa', mime: 'image/png', width: 10, height: 20, byteLength: PNG_BYTES.length, base64: Buffer.from(PNG_BYTES).toString('base64') },
    ]);
  });

  it('records missing, oversized and excluded images while keeping their entries', async () => {
    const node = mockNode({ id: '1:1', type: 'RECTANGLE', fills: [imageFill('gone'), imageFill('huge')] });
    const huge = new Uint8Array(LIMITS.maxImageBytes + 1);
    const host = mockHost([mockPage('0:1', [node])], {
      getImageByHash: (hash) => (hash === 'huge' ? mockImage(huge) : null),
    });
    let data = await run(host, wholePage('0:1'));
    expect(data.images.map((i) => i.base64)).toEqual([null, null]);
    expect(gapCodes(data)).toEqual(expect.arrayContaining(['image-unavailable', 'image-too-large']));

    data = await run(host, wholePage('0:1'), { includeImages: false, includePreviews: false });
    expect(gapCodes(data)).toContain('images-excluded');
    expect(data.images.find((i) => i.hash === 'huge')).toMatchObject({ width: 10, base64: null });
  });

  it('stops embedding at the total image budget', async () => {
    const hashes = Array.from({ length: 13 }, (_, i) => `h${i}`);
    const node = mockNode({ id: '1:1', type: 'RECTANGLE', fills: hashes.map(imageFill) });
    const eightMiB = new Uint8Array(LIMITS.maxImageBytes);
    const data = await run(mockHost([mockPage('0:1', [node])], { getImageByHash: () => mockImage(eightMiB) }), wholePage('0:1'));
    expect(data.images.filter((i) => i.base64 !== null)).toHaveLength(12);
    expect(gapCodes(data)).toContain('image-budget-exceeded');
  });

  it('renders 1x previews for chosen frames only and records failures', async () => {
    const seen: unknown[] = [];
    const ok = mockNode({ id: '1:1', type: 'FRAME', exportAsync: async (settings: unknown) => { seen.push(settings); return PNG_BYTES; } });
    const bad = mockNode({ id: '1:2', type: 'FRAME', exportAsync: async () => { throw new Error('too big'); } });
    const data = await run(mockHost([mockPage('0:1', [ok, bad])]), wholePage('0:1'), { includeImages: false, includePreviews: true });
    expect(seen).toEqual([{ format: 'PNG', constraint: { type: 'SCALE', value: 1 } }]);
    expect(data.previews.map((p) => p.nodeId)).toEqual(['1:1']);
    expect(gapCodes(data)).toContain('preview-unavailable');
  });
});

describe('selection and walking', () => {
  it('loads only chosen pages and honours frame picks', async () => {
    let loadedOther = false;
    const other = mockPage('0:2', []);
    const originalLoad = other.loadAsync;
    (other as { loadAsync: () => Promise<void> }).loadAsync = async () => {
      loadedOther = true;
      await originalLoad();
    };
    const page = mockPage('0:1', [mockNode({ id: '1:1', type: 'FRAME' }), mockNode({ id: '1:2', type: 'FRAME' })]);
    const data = await run(mockHost([page, other]), { pages: [{ pageId: '0:1', nodeIds: ['1:2', '1:404'] }] });
    expect(loadedOther).toBe(false);
    expect(data.nodes.map((n) => n.id)).toEqual(['1:2']);
    expect(data.pages).toEqual([expect.objectContaining({ id: '0:1', wholePage: false })]);
    expect(data.gaps.find((g) => g.code === 'selection-not-found')?.field).toBe('1:404');
  });

  it('records pages that vanish or fail to load', async () => {
    const page = mockPage('0:1', []);
    (page as { loadAsync: () => Promise<void> }).loadAsync = async () => {
      throw new Error('load failed');
    };
    const data = await run(mockHost([page]), { pages: [{ pageId: '0:1', nodeIds: null }, { pageId: '0:9', nodeIds: null }] });
    expect(gapCodes(data)).toEqual(expect.arrayContaining(['page-load-failed', 'selection-not-found']));
  });

  it('keeps pre-order and survives getters that throw', async () => {
    const throwing = mockNode({
      id: '1:3',
      type: 'RECTANGLE',
      get opacity(): number {
        throw new Error('boom');
      },
    });
    const root = mockNode({
      id: '1:1',
      type: 'FRAME',
      children: [mockNode({ id: '1:2', type: 'GROUP', children: [throwing] }), mockNode({ id: '1:4', type: 'RECTANGLE' })],
    });
    const data = await run(mockHost([mockPage('0:1', [root])]), wholePage('0:1'));
    expect(data.nodes.map((n) => n.id)).toEqual(['1:1', '1:2', '1:3', '1:4']);
    expect(data.gaps.find((g) => g.code === 'read-failed')).toMatchObject({ nodeId: '1:3', field: 'opacity' });
  });

  it('records unmodelled layers and properties', async () => {
    const widget = mockNode({ id: '1:1', type: 'WIDGET', width: 10, height: 10 });
    const frame = mockNode({
      id: '1:2',
      type: 'FRAME',
      reactions: [{ actions: [] }],
      annotations: [{ label: 'x' }],
      exportSettings: [{ format: 'PNG' }],
      guides: [{ axis: 'X', offset: 1 }],
    });
    const data = await run(mockHost([mockPage('0:1', [widget, frame])]), wholePage('0:1'));
    expect(nodeOf(data, '1:1').width).toBe(10);
    expect(gapCodes(data)).toEqual(
      expect.arrayContaining([
        'unsupported-node-type',
        'prototype-not-captured',
        'annotations-not-captured',
        'export-settings-not-captured',
        'guides-not-captured',
      ]),
    );
  });

  it('stops at the depth cap without overflowing and flags it incomplete', async () => {
    let current = mockNode({ id: '9:0', type: 'FRAME' });
    for (let i = 1; i <= LIMITS.maxDepth + 5; i += 1) {
      current = mockNode({ id: `9:${i}`, type: 'FRAME', children: [current] });
    }
    const data = await run(mockHost([mockPage('0:1', [current])]), wholePage('0:1'));
    expect(data.nodes).toHaveLength(LIMITS.maxDepth + 1);
    expect(data.stats.complete).toBe(false);
    expect(gapCodes(data)).toContain('depth-limit-reached');
  });

  it('stops at the node cap and says so', async () => {
    const children = Array.from({ length: LIMITS.maxNodes + 10 }, (_, i) => ({ id: `2:${i}`, type: 'RECTANGLE', name: 'r' }) as never);
    const root = { id: '1:1', type: 'FRAME', name: 'big', children } as never;
    const data = await buildExport(mockHost([mockPage('0:1', [root])]), wholePage('0:1'), OPTIONS);
    expect(data.nodes).toHaveLength(LIMITS.maxNodes);
    expect(data.stats.complete).toBe(false);
    expect(gapCodes(data)).toContain('node-limit-reached');
    expect(FigmaExportSchema.safeParse(data).success).toBe(true);
  }, 60_000);

  it('caps the gap list but keeps full counts', async () => {
    const nodes = Array.from({ length: LIMITS.maxGaps + 7 }, (_, i) => mockNode({ id: `1:${i}`, type: 'WIDGET' }));
    const frame = mockNode({ id: '2:1', type: 'FRAME', children: nodes });
    const data = await run(mockHost([mockPage('0:1', [frame])]), wholePage('0:1'));
    expect(data.gaps).toHaveLength(LIMITS.maxGaps);
    expect(data.gapSummary.find((g) => g.code === 'unsupported-node-type')?.count).toBe(LIMITS.maxGaps + 7);
  }, 60_000);

  it('cancels between batches', async () => {
    const children = Array.from({ length: 600 }, (_, i) => mockNode({ id: `2:${i}`, type: 'RECTANGLE' }));
    const frame = mockNode({ id: '1:1', type: 'FRAME', children });
    let cancelled = false;
    const promise = buildExport(mockHost([mockPage('0:1', [frame])]), wholePage('0:1'), OPTIONS, {
      onProgress: () => {
        cancelled = true;
      },
      isCancelled: () => cancelled,
    });
    await expect(promise).rejects.toBeInstanceOf(ExportCancelled);
  });

  it('round-trips through parseFigmaExport', async () => {
    const data = await run(mockHost([mockPage('0:1', [mockNode({ id: '1:1', type: 'FRAME', name: 'A <b>name</b>' })])]), wholePage('0:1'));
    const parsed = parseFigmaExport(JSON.stringify(data));
    expect(parsed.ok && parsed.data.nodes[0]?.name).toBe('A <b>name</b>');
  });
});
