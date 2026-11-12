/**
 * Scalar node properties copied verbatim. The schema and the extractor both
 * read these lists, so a property can't be captured but rejected, or the reverse.
 */

export const NODE_NUMBER_FIELDS = [
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'opacity',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'layoutGrow',
  'paddingLeft',
  'paddingRight',
  'paddingTop',
  'paddingBottom',
  'itemSpacing',
  'counterAxisSpacing',
  'cornerRadius',
  'cornerSmoothing',
  'topLeftRadius',
  'topRightRadius',
  'bottomLeftRadius',
  'bottomRightRadius',
  'strokeWeight',
  'strokeTopWeight',
  'strokeBottomWeight',
  'strokeLeftWeight',
  'strokeRightWeight',
  'strokeMiterLimit',
  'numberOfFixedChildren',
  'pointCount',
  'innerRadius',
] as const;

export const NODE_TOKEN_FIELDS = [
  'blendMode',
  'maskType',
  'layoutMode',
  'layoutWrap',
  'layoutAlign',
  'layoutPositioning',
  'layoutSizingHorizontal',
  'layoutSizingVertical',
  'primaryAxisSizingMode',
  'counterAxisSizingMode',
  'primaryAxisAlignItems',
  'counterAxisAlignItems',
  'counterAxisAlignContent',
  'strokeAlign',
  'strokeCap',
  'strokeJoin',
  'booleanOperation',
  'handleMirroring',
  'overflowDirection',
] as const;

export const NODE_BOOL_FIELDS = [
  'visible',
  'locked',
  'isMask',
  'clipsContent',
  'strokesIncludedInLayout',
  'itemReverseZIndex',
  'constrainProportions',
  'sectionContentsHidden',
  'isExposedInstance',
] as const;

export const NODE_STYLE_ID_FIELDS = [
  'fillStyleId',
  'strokeStyleId',
  'effectStyleId',
  'gridStyleId',
  'textStyleId',
] as const;

/** Only present on grid auto layout containers. */
export const GRID_CONTAINER_NUMBER_FIELDS = [
  'gridRowCount',
  'gridColumnCount',
  'gridRowGap',
  'gridColumnGap',
] as const;
export const GRID_CONTAINER_TOKEN_FIELDS = ['gridAutoTracks', 'gridItemsPositioning'] as const;

/** Only meaningful on children of a grid auto layout container. */
export const GRID_CHILD_NUMBER_FIELDS = [
  'gridRowAnchorIndex',
  'gridColumnAnchorIndex',
  'gridRowSpan',
  'gridColumnSpan',
] as const;
export const GRID_CHILD_TOKEN_FIELDS = [
  'gridChildHorizontalAlign',
  'gridChildVerticalAlign',
] as const;

export const TEXT_NODE_TOKEN_FIELDS = [
  'textAlignHorizontal',
  'textAlignVertical',
  'textAutoResize',
  'textTruncation',
] as const;

export const TEXT_NODE_BOOL_FIELDS = [
  'hangingPunctuation',
  'hangingList',
  'autoRename',
  'hasMissingFont',
] as const;

/** Requested from getStyledTextSegments. */
export const TEXT_SEGMENT_FIELDS = [
  'fontSize',
  'fontName',
  'fontWeight',
  'fontStyle',
  'textDecoration',
  'textDecorationStyle',
  'textDecorationOffset',
  'textDecorationThickness',
  'textDecorationColor',
  'textDecorationSkipInk',
  'textCase',
  'lineHeight',
  'letterSpacing',
  'fills',
  'textStyleId',
  'fillStyleId',
  'listOptions',
  'listSpacing',
  'indentation',
  'paragraphIndent',
  'paragraphSpacing',
  'textWrapStyle',
  'hyperlink',
  'openTypeFeatures',
  'boundVariables',
  'textStyleOverrides',
] as const;

/** Fallback when a runtime rejects a newer field in TEXT_SEGMENT_FIELDS. */
export const TEXT_SEGMENT_CORE_FIELDS = [
  'fontSize',
  'fontName',
  'fontWeight',
  'textDecoration',
  'textCase',
  'lineHeight',
  'letterSpacing',
  'fills',
  'hyperlink',
] as const;

export const TEXT_SEGMENT_NUMBER_FIELDS = [
  'fontSize',
  'fontWeight',
  'listSpacing',
  'indentation',
  'paragraphIndent',
  'paragraphSpacing',
] as const;

export const TEXT_SEGMENT_TOKEN_FIELDS = [
  'fontStyle',
  'textDecoration',
  'textDecorationStyle',
  'textCase',
  'textWrapStyle',
] as const;

export const TEXT_STYLE_NUMBER_FIELDS = [
  'fontSize',
  'paragraphIndent',
  'paragraphSpacing',
  'listSpacing',
] as const;

export const TEXT_STYLE_TOKEN_FIELDS = ['textDecoration', 'textCase', 'leadingTrim'] as const;

export const EFFECT_NUMBER_FIELDS = [
  'radius',
  'spread',
  'startRadius',
  'noiseSize',
  'density',
  'opacity',
  'lightIntensity',
  'lightAngle',
  'refraction',
  'depth',
  'dispersion',
] as const;
export const EFFECT_TOKEN_FIELDS = ['blendMode', 'blurType', 'noiseType'] as const;
export const EFFECT_BOOL_FIELDS = ['visible', 'showShadowBehindNode', 'clipToShape'] as const;
export const EFFECT_VECTOR_FIELDS = ['offset', 'startOffset', 'endOffset', 'noiseSizeVector'] as const;
export const EFFECT_COLOR_FIELDS = ['color', 'secondaryColor'] as const;

export const IMAGE_FILTER_FIELDS = [
  'exposure',
  'contrast',
  'saturation',
  'temperature',
  'tint',
  'highlights',
  'shadows',
] as const;

/** Node types the format models structurally. Others keep geometry and raise a gap. */
export const MODELED_NODE_TYPES: ReadonlySet<string> = new Set([
  'FRAME',
  'GROUP',
  'SECTION',
  'SLOT',
  'COMPONENT',
  'COMPONENT_SET',
  'INSTANCE',
  'RECTANGLE',
  'ELLIPSE',
  'POLYGON',
  'STAR',
  'LINE',
  'VECTOR',
  'BOOLEAN_OPERATION',
  'TEXT',
]);

/** Node types that carry vector geometry worth exporting. */
export const VECTOR_NODE_TYPES: ReadonlySet<string> = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'STAR',
  'POLYGON',
  'LINE',
  'ELLIPSE',
]);
