/**
 * Component library: ~30 production components with anatomy (inner parts), variants, states and
 * token-based CSS. Implementation-neutral: adapters map them to MUI / shadcn / etc.
 *
 * A component = ComponentDef (axes, defaults, root styles) + optional ANATOMY renderer (inner markup)
 * + COMPONENT_CSS (part styles, states). Everything is driven by design tokens.
 */
import type { ComponentDef, Layout, RNode, Sizing, Style } from './model.js';

const t = (token: string) => ({ token });
/** control height from the density tokens (size.control.*) */
const CTL: Record<number, string> = { 24: 'xs', 32: 'sm', 36: 'md', 44: 'lg' };
const sz = (h: number, w: Sizing['w'] = { kind: 'hug' }): Sizing => ({ h: { kind: 'fixed', v: CTL[h] ? t(`size.control.${CTL[h]}`) : h }, w });
const row = (gap: string, px?: string, py?: string): Layout => ({ mode: 'row', gap: t(gap), align: 'center', ...(px ? { padding: [py ? t(py) : 0, t(px), py ? t(py) : 0, t(px)] } : {}) });

export interface PropSpec {
  type: 'string' | 'number' | 'boolean' | 'icon' | 'list';
  default?: string | number | boolean;
  description: string;
}

/** Extra documentation for agents/editor (props beyond variant axes). */
export interface ComponentDoc {
  category: 'Actions' | 'Inputs' | 'Display' | 'Navigation' | 'Feedback' | 'Data' | 'Charts' | 'Media' | 'Web3';
  description: string;
  props?: Record<string, PropSpec>;
  example: string;
  /** component has no visible text label (hide the label field in editors) */
  noLabel?: boolean;
}

export type Def = ComponentDef & { doc: ComponentDoc };

const variantStyles = (axis: string, map: Record<string, Style>): ComponentDef['styles'] => Object.entries(map).map(([v, style]) => ({ when: { [axis]: v }, style }));
const STATUS = ['neutral', 'info', 'success', 'warning', 'error'] as const;

/** Field looks shared by Input, Select and Textarea. */
const FIELD_AXIS = ['outlined', 'filled', 'underlined', 'pill', 'ghost', 'floating', 'floating-filled'];
const fieldLooks = (): ComponentDef['styles'] => [
  { when: { appearance: 'filled' }, style: { fill: [t('color.bg.subtle')], stroke: undefined } },
  { when: { appearance: 'underlined' }, style: { fill: [], radius: 0, stroke: { paint: t('color.border.strong'), width: 1, align: 'inside', sides: 'b' } } },
  { when: { appearance: 'pill' }, style: { radius: t('radius.full') } },
  { when: { appearance: 'ghost' }, style: { fill: [], stroke: undefined } },
  { when: { appearance: 'floating-filled' }, style: { fill: [t('color.bg.subtle')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside', sides: 'b' }, radius: 0 } },
];

export const LIBRARY: Record<string, Def> = {
  // ---------------------------------------------------------------- actions
  Button: {
    id: 'Button', name: 'Button', tag: 'button', role: 'action', labelProp: 'label', anatomy: 'button',
    axes: { variant: ['primary', 'secondary', 'ghost', 'danger', 'outline', 'soft', 'link', 'success'], size: ['sm', 'md', 'lg'], state: ['default', 'loading', 'disabled'] },
    defaults: { variant: 'primary', size: 'md', state: 'default' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.2'), align: 'center', justify: 'center', padding: [0, t('space.4'), 0, t('space.4')] }, size: sz(36), style: { radius: t('radius.control'), textStyle: t('textStyle.label') } },
      { when: { size: 'sm' }, size: sz(32), layout: { mode: 'row', padding: [0, t('space.3'), 0, t('space.3')] }, style: {} },
      { when: { size: 'lg' }, size: sz(44), layout: { mode: 'row', padding: [0, t('space.5'), 0, t('space.5')] }, style: { textStyle: t('textStyle.body-lg') } },
      { when: { variant: 'primary' }, style: { fill: [t('color.action.primary')], color: t('color.text.onPrimary'), shadow: t('shadow.control') } },
      { when: { variant: 'secondary' }, style: { fill: [t('color.bg.surface')], color: t('color.text.primary'), stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, shadow: t('shadow.control') } },
      { when: { variant: 'ghost' }, style: { fill: [], color: t('color.text.primary') } },
      { when: { variant: 'danger' }, style: { fill: [t('color.action.danger')], color: t('color.text.onDanger'), shadow: t('shadow.control') } },
      { when: { variant: 'outline' }, style: { fill: [], color: t('color.text.link'), stroke: { paint: t('color.border.focus'), width: 1, align: 'inside' } } },
      { when: { variant: 'soft' }, style: { fill: [t('color.bg.selected')], color: t('color.text.link') } },
      { when: { variant: 'link' }, style: { fill: [], color: t('color.text.link') }, layout: { padding: [0, 0, 0, 0] } },
      { when: { variant: 'success' }, style: { fill: [t('color.status.success.fg')], color: t('color.bg.surface') } },
    ],
    doc: { category: 'Actions', description: 'Primary, secondary, ghost, outline, soft, link, success or destructive action. One primary per view. icon= leads, iconright= trails; state=loading shows a spinner.', props: { icon: { type: 'icon', description: 'leading icon' }, iconright: { type: 'icon', description: 'trailing icon' } }, example: '@Button variant=primary "Run tests"' },
  },
  IconButton: {
    id: 'IconButton', name: 'IconButton', tag: 'button', role: 'action', labelProp: 'ariaLabel', anatomy: 'iconbutton',
    axes: { variant: ['ghost', 'secondary', 'primary'], size: ['sm', 'md', 'lg'] },
    defaults: { variant: 'ghost', size: 'md' },
    styles: [
      { when: {}, layout: { mode: 'row', align: 'center', justify: 'center' }, size: { w: { kind: 'fixed', v: t('size.control.md') }, h: { kind: 'fixed', v: t('size.control.md') } }, style: { radius: t('radius.control'), color: t('color.text.secondary'), fill: [] } },
      { when: { size: 'sm' }, size: { w: { kind: 'fixed', v: 28 }, h: { kind: 'fixed', v: 28 } }, style: {} },
      { when: { size: 'lg' }, size: { w: { kind: 'fixed', v: t('size.control.lg') }, h: { kind: 'fixed', v: t('size.control.lg') } }, style: {} },
      { when: { variant: 'secondary' }, style: { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, color: t('color.text.primary') } },
      { when: { variant: 'primary' }, style: { fill: [t('color.action.primary')], color: t('color.text.onPrimary') } },
    ],
    doc: { category: 'Actions', description: 'Icon-only action. Always give an accessible label (the quoted text).', props: { icon: { type: 'icon', default: 'more', description: 'icon name' } }, example: '@IconButton icon=more "More actions"' },
  },
  Link: {
    id: 'Link', name: 'Link', tag: 'a', role: 'link', labelProp: 'label',
    axes: { variant: ['default', 'muted', 'danger'] },
    defaults: { variant: 'default' },
    styles: [
      { when: {}, style: { textStyle: t('textStyle.body'), color: t('color.text.link') } },
      { when: { variant: 'muted' }, style: { color: t('color.text.secondary') } },
      { when: { variant: 'danger' }, style: { color: t('color.status.error.fg') } },
    ],
    doc: { category: 'Actions', description: 'Inline navigation. Underlines on hover/focus.', example: '@Link "View all runs"' },
  },

  // ---------------------------------------------------------------- inputs
  Input: {
    id: 'Input', name: 'Input', tag: 'div', role: 'field', labelProp: 'placeholder', anatomy: 'input',
    axes: { appearance: FIELD_AXIS, size: ['sm', 'md', 'lg'], state: ['default', 'error', 'success', 'disabled'] },
    defaults: { appearance: 'outlined', size: 'md', state: 'default' },
    styles: [
      { when: {}, layout: row('space.2', 'space.3'), size: sz(36, { kind: 'fill' }), style: { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, radius: t('radius.control'), shadow: t('shadow.control'), textStyle: t('textStyle.body'), color: t('color.text.primary') } },
      { when: { size: 'sm' }, size: sz(32, { kind: 'fill' }), style: {} },
      { when: { size: 'lg' }, size: sz(44, { kind: 'fill' }), style: {} },
      ...fieldLooks(),
      { when: { appearance: 'floating' }, size: { h: { kind: 'fixed', v: 48 }, w: { kind: 'fill' } }, style: {} },
      { when: { appearance: 'floating-filled' }, size: { h: { kind: 'fixed', v: 56 }, w: { kind: 'fill' } }, style: {} },
      { when: { state: 'error' }, style: { stroke: { paint: t('color.action.danger'), width: 1, align: 'inside' } } },
      { when: { state: 'success' }, style: { stroke: { paint: t('color.status.success.fg'), width: 1, align: 'inside' } } },
      { when: { state: 'disabled' }, style: { fill: [t('color.bg.subtle')], color: t('color.text.disabled') } },
    ],
    doc: { category: 'Inputs', description: 'Single-line text field in any look: appearance=outlined, filled, underlined, pill, ghost, floating (label moves up on focus) or floating-filled. Quoted text = placeholder, or the floating label.', props: { value: { type: 'string', description: 'entered value' }, title: { type: 'string', description: 'label above the field' }, help: { type: 'string', description: 'helper or error text below' }, icon: { type: 'icon', description: 'leading icon' }, iconright: { type: 'icon', description: 'trailing icon' }, prefix: { type: 'string', description: 'text before, e.g. https://' }, suffix: { type: 'string', description: 'text after, e.g. .com' }, max: { type: 'number', description: 'character counter limit' }, reveal: { type: 'boolean', description: 'password eye icon' }, required: { type: 'boolean', description: 'adds *' }, type: { type: 'string', default: 'text', description: 'text | email | password | number | url | tel' } }, example: '@Input icon=search "Search runs"' },
  },
  Textarea: {
    id: 'Textarea', name: 'Textarea', tag: 'div', role: 'field', labelProp: 'placeholder', anatomy: 'textarea',
    axes: { appearance: FIELD_AXIS, state: ['default', 'error', 'disabled'] },
    defaults: { appearance: 'outlined', state: 'default' },
    styles: [
      { when: {}, layout: { mode: 'col', padding: [t('space.2'), t('space.3'), t('space.2'), t('space.3')] }, size: { w: { kind: 'fill' }, h: { kind: 'fixed', v: 96 } }, style: { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, radius: t('radius.control'), shadow: t('shadow.control'), textStyle: t('textStyle.body'), color: t('color.text.primary') } },
      ...fieldLooks(),
      { when: { state: 'error' }, style: { stroke: { paint: t('color.action.danger'), width: 1, align: 'inside' } } },
      { when: { state: 'disabled' }, style: { fill: [t('color.bg.subtle')], color: t('color.text.disabled') } },
    ],
    doc: { category: 'Inputs', description: 'Multi-line text. value= for content.', props: { value: { type: 'string', description: 'content' } }, example: '@Textarea "Describe the failure"' },
  },
  Select: {
    id: 'Select', name: 'Select', tag: 'button', role: 'field', labelProp: 'value', anatomy: 'select',
    axes: { appearance: FIELD_AXIS, size: ['sm', 'md'], state: ['default', 'error', 'disabled'] },
    defaults: { appearance: 'outlined', size: 'md', state: 'default' },
    styles: [
      { when: {}, layout: { mode: 'row', align: 'center', justify: 'between', gap: t('space.2'), padding: [0, t('space.2'), 0, t('space.3')] }, size: sz(36, { kind: 'fill' }), style: { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, radius: t('radius.control'), shadow: t('shadow.control'), textStyle: t('textStyle.body'), color: t('color.text.primary') } },
      { when: { size: 'sm' }, size: sz(32, { kind: 'fill' }), style: {} },
      ...fieldLooks(),
      { when: { appearance: 'floating' }, size: { h: { kind: 'fixed', v: 48 }, w: { kind: 'fill' } }, style: {} },
      { when: { appearance: 'floating-filled' }, size: { h: { kind: 'fixed', v: 56 }, w: { kind: 'fill' } }, style: {} },
      { when: { state: 'error' }, style: { stroke: { paint: t('color.action.danger'), width: 1, align: 'inside' } } },
      { when: { state: 'disabled' }, style: { fill: [t('color.bg.subtle')], color: t('color.text.disabled') } },
    ],
    doc: { category: 'Inputs', description: 'Closed dropdown showing the chosen value (or placeholder=).', props: { placeholder: { type: 'string', description: 'shown when no value' } }, example: '@Select "Last 7 days"' },
  },
  SearchInput: {
    id: 'SearchInput', name: 'SearchInput', tag: 'div', role: 'search', labelProp: 'placeholder', anatomy: 'search',
    axes: { size: ['sm', 'md'] },
    defaults: { size: 'md' },
    styles: [
      { when: {}, layout: row('space.2', 'space.3'), size: sz(36, { kind: 'fill' }), style: { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, radius: t('radius.control'), shadow: t('shadow.control'), textStyle: t('textStyle.body'), color: t('color.text.secondary') } },
      { when: { size: 'sm' }, size: sz(32, { kind: 'fill' }), style: {} },
    ],
    doc: { category: 'Inputs', description: 'Search field with icon and optional shortcut hint.', props: { shortcut: { type: 'string', description: 'e.g. ⌘K or /' } }, example: '@SearchInput shortcut=/ "Search test cases"' },
  },
  Checkbox: {
    id: 'Checkbox', name: 'Checkbox', tag: 'label', role: 'field', labelProp: 'label', anatomy: 'checkbox',
    axes: { checked: ['false', 'true', 'mixed'], state: ['default', 'disabled'] },
    defaults: { checked: 'false', state: 'default' },
    styles: [{ when: {}, layout: row('space.2'), style: { textStyle: t('textStyle.body'), color: t('color.text.primary') } }, { when: { state: 'disabled' }, style: { color: t('color.text.disabled') } }],
    doc: { category: 'Inputs', description: 'Multi-select option. checked=true|false|mixed.', example: '@Checkbox checked=true "Include flaky tests"' },
  },
  Radio: {
    id: 'Radio', name: 'Radio', tag: 'label', role: 'field', labelProp: 'label', anatomy: 'radio',
    axes: { checked: ['false', 'true'], state: ['default', 'disabled'] },
    defaults: { checked: 'false', state: 'default' },
    styles: [{ when: {}, layout: row('space.2'), style: { textStyle: t('textStyle.body'), color: t('color.text.primary') } }, { when: { state: 'disabled' }, style: { color: t('color.text.disabled') } }],
    doc: { category: 'Inputs', description: 'Single choice within a group.', example: '@Radio checked=true "Nightly"' },
  },
  Switch: {
    id: 'Switch', name: 'Switch', tag: 'label', role: 'field', labelProp: 'label', anatomy: 'switch',
    axes: { checked: ['false', 'true'], state: ['default', 'disabled'] },
    defaults: { checked: 'false', state: 'default' },
    styles: [{ when: {}, layout: row('space.2'), style: { textStyle: t('textStyle.body'), color: t('color.text.primary') } }, { when: { state: 'disabled' }, style: { color: t('color.text.disabled') } }],
    doc: { category: 'Inputs', description: 'On/off setting that applies immediately (not for actions).', example: '@Switch checked=true "Retry failed tests"' },
  },
  Slider: {
    id: 'Slider', name: 'Slider', tag: 'div', role: 'field', labelProp: 'label', anatomy: 'slider',
    axes: { state: ['default', 'disabled'] },
    defaults: { state: 'default' },
    styles: [{ when: {}, layout: { mode: 'col', gap: t('space.1') }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.body-sm'), color: t('color.text.secondary') } }],
    doc: { category: 'Inputs', description: 'Range value 0–100.', props: { value: { type: 'number', default: 50, description: '0–100' } }, example: '@Slider value=30 "Timeout"' },
  },
  Segmented: {
    id: 'Segmented', name: 'Segmented', tag: 'div', role: 'tablist', labelProp: 'items', anatomy: 'segmented',
    axes: { size: ['sm', 'md'] },
    defaults: { size: 'md' },
    styles: [{ when: {}, layout: { mode: 'row', gap: t('space.0.5'), padding: [t('space.0.5'), t('space.0.5'), t('space.0.5'), t('space.0.5')] }, size: { w: { kind: 'hug' } }, style: { fill: [t('color.bg.subtle')], radius: t('radius.control'), textStyle: t('textStyle.label') } }],
    doc: { category: 'Inputs', description: 'Compact switch between 2–5 views. Quoted text = items separated by |.', props: { selected: { type: 'number', default: 0, description: 'selected index' } }, example: '@Segmented selected=0 "List|Board|Timeline"' },
  },
  Rating: {
    id: 'Rating', name: 'Rating', tag: 'div', role: 'img', labelProp: 'label', anatomy: 'rating',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: row('space.0.5'), style: { color: t('color.warning.500') } }],
    doc: { category: 'Inputs', noLabel: true, description: 'Read-only star rating 0–5.', props: { value: { type: 'number', default: 4, description: '0–5' } }, example: '@Rating value=4' },
  },

  // ---------------------------------------------------------------- display
  Badge: {
    id: 'Badge', name: 'Badge', tag: 'span', role: 'status', labelProp: 'label', anatomy: 'badge',
    axes: { variant: ['neutral', 'primary', 'success', 'warning', 'error'], kind: ['count', 'dot'] },
    defaults: { variant: 'primary', kind: 'count' },
    styles: [
      { when: {}, layout: { mode: 'row', align: 'center', justify: 'center', padding: [0, t('space.1.5'), 0, t('space.1.5')] }, size: { h: { kind: 'fixed', v: 18 }, minW: 18 }, style: { radius: t('radius.full'), textStyle: t('textStyle.caption'), font: { weight: 600 } } },
      { when: { kind: 'dot' }, size: { h: { kind: 'fixed', v: 8 }, w: { kind: 'fixed', v: 8 }, minW: 8 }, layout: { mode: 'row', padding: [0, 0, 0, 0] }, style: {} },
      ...variantStyles('variant', {
        neutral: { fill: [t('color.neutral.200')], color: t('color.neutral.800') },
        primary: { fill: [t('color.action.primary')], color: t('color.text.onPrimary') },
        success: { fill: [t('color.success.600')], color: t('color.white') },
        warning: { fill: [t('color.warning.500')], color: t('color.neutral.900') },
        error: { fill: [t('color.error.600')], color: t('color.white') },
      }),
    ],
    doc: { category: 'Display', description: 'Small count or dot indicator (notifications, new items).', example: '@Badge variant=error "3"' },
  },
  Chip: {
    id: 'Chip', name: 'Chip', tag: 'span', role: 'status', labelProp: 'label',
    axes: { variant: [...STATUS] },
    defaults: { variant: 'neutral' },
    styles: [
      { when: {}, layout: { mode: 'row', align: 'center', gap: t('space.1'), padding: [t('space.0.5'), t('space.2'), t('space.0.5'), t('space.2')] }, size: { w: { kind: 'hug' } }, style: { radius: t('radius.full'), textStyle: t('textStyle.caption'), font: { weight: 500 } } },
      ...STATUS.map((v) => ({ when: { variant: v }, style: { fill: [t(`color.status.${v}.bg`)], color: t(`color.status.${v}.fg`) } as Style })),
    ],
    doc: { category: 'Display', description: 'Compact status/label. Pair colour with text.', example: '@Chip variant=success "Passed"' },
  },
  Tag: {
    id: 'Tag', name: 'Tag', tag: 'span', role: 'listitem', labelProp: 'label', anatomy: 'tag',
    axes: { removable: ['false', 'true'] },
    defaults: { removable: 'false' },
    styles: [{ when: {}, layout: { mode: 'row', align: 'center', gap: t('space.1'), padding: [0, t('space.2'), 0, t('space.2')] }, size: sz(24), style: { radius: t('radius.1'), fill: [t('color.bg.subtle')], stroke: { paint: t('color.border.default'), width: 1, align: 'inside' }, textStyle: t('textStyle.caption'), color: t('color.text.primary') } }],
    doc: { category: 'Display', description: 'Label/filter token; removable=true adds a remove button.', example: '@Tag removable=true "smoke"' },
  },
  Status: {
    id: 'Status', name: 'Status', tag: 'span', role: 'status', labelProp: 'label', anatomy: 'status',
    axes: { variant: ['passed', 'failed', 'running', 'skipped', 'flaky', 'blocked'] },
    defaults: { variant: 'passed' },
    styles: [{ when: {}, layout: row('space.1.5'), style: { textStyle: t('textStyle.body-sm'), color: t('color.text.primary') } }],
    doc: { category: 'Display', description: 'Test result: icon + label (never colour alone). Label defaults to the variant.', example: '@Status variant=failed' },
  },
  Avatar: {
    id: 'Avatar', name: 'Avatar', tag: 'span', role: 'img', labelProp: 'name', anatomy: 'avatar',
    axes: { size: ['xs', 'sm', 'md', 'lg'], tone: ['neutral', 'primary'] },
    defaults: { size: 'md', tone: 'neutral' },
    styles: [
      { when: {}, layout: { mode: 'row', align: 'center', justify: 'center' }, size: { w: { kind: 'fixed', v: 32 }, h: { kind: 'fixed', v: 32 } }, style: { radius: t('radius.full'), textStyle: t('textStyle.label'), fill: [t('color.status.neutral.bg')], color: t('color.status.neutral.fg'), clip: true } },
      { when: { size: 'xs' }, size: { w: { kind: 'fixed', v: 20 }, h: { kind: 'fixed', v: 20 } }, style: { textStyle: t('textStyle.caption') } },
      { when: { size: 'sm' }, size: { w: { kind: 'fixed', v: 24 }, h: { kind: 'fixed', v: 24 } }, style: { textStyle: t('textStyle.caption') } },
      { when: { size: 'lg' }, size: { w: { kind: 'fixed', v: 48 }, h: { kind: 'fixed', v: 48 } }, style: { textStyle: t('textStyle.title-sm') } },
      { when: { tone: 'primary' }, style: { fill: [t('color.status.info.bg')], color: t('color.status.info.fg') } },
    ],
    doc: { category: 'Display', description: 'Person initials (quoted name) in a circle.', example: '@Avatar size=sm "Asha Rao"' },
  },
  Kbd: {
    id: 'Kbd', name: 'Kbd', tag: 'kbd', role: 'text', labelProp: 'label',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'row', align: 'center', padding: [0, t('space.1.5'), 0, t('space.1.5')] }, size: { h: { kind: 'fixed', v: 20 } }, style: { radius: t('radius.1'), fill: [t('color.bg.surface')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, textStyle: t('textStyle.caption'), mono: true, color: t('color.text.secondary') } }],
    doc: { category: 'Display', description: 'Keyboard key or shortcut.', example: '@Kbd "Ctrl K"' },
  },
  Divider: {
    id: 'Divider', name: 'Divider', tag: 'div', role: 'separator', labelProp: 'label', anatomy: 'divider',
    axes: { orientation: ['horizontal', 'vertical'] },
    defaults: { orientation: 'horizontal' },
    styles: [
      { when: {}, layout: row('space.3'), size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.caption'), color: t('color.text.secondary') } },
      { when: { orientation: 'vertical' }, size: { w: { kind: 'fixed', v: 1 }, h: { kind: 'fixed', v: 20 } }, style: { fill: [t('color.border.default')] } },
    ],
    doc: { category: 'Display', description: 'Separator line; optional centred label.', example: '@Divider "or"' },
  },
  Tooltip: {
    id: 'Tooltip', name: 'Tooltip', tag: 'span', role: 'tooltip', labelProp: 'label', anatomy: 'tooltip',
    axes: { placement: ['top', 'bottom'] },
    defaults: { placement: 'top' },
    styles: [{ when: {}, layout: { mode: 'row', padding: [t('space.1'), t('space.2'), t('space.1'), t('space.2')] }, size: { w: { kind: 'hug' }, maxW: 240 }, style: { radius: t('radius.2'), fill: [t('color.bg.inverse')], color: t('color.bg.surface'), textStyle: t('textStyle.caption') } }],
    doc: { category: 'Display', description: 'Short supplementary hint (shown on hover/focus). Never put essential info here.', example: '@Tooltip "Copy run ID"' },
  },
  Skeleton: {
    id: 'Skeleton', name: 'Skeleton', tag: 'span', role: 'presentation', labelProp: 'label', anatomy: 'skeleton',
    axes: { shape: ['text', 'rect', 'circle'] },
    defaults: { shape: 'text' },
    styles: [
      { when: {}, size: { w: { kind: 'fixed', v: 160 }, h: { kind: 'fixed', v: 12 } }, style: { radius: t('radius.1'), fill: [t('color.bg.subtle')] } },
      { when: { shape: 'rect' }, size: { w: { kind: 'fill' }, h: { kind: 'fixed', v: 80 } }, style: { radius: t('radius.3') } },
      { when: { shape: 'circle' }, size: { w: { kind: 'fixed', v: 32 }, h: { kind: 'fixed', v: 32 } }, style: { radius: t('radius.full') } },
    ],
    doc: { category: 'Feedback', noLabel: true, description: 'Loading placeholder matching the final layout.', example: '@Skeleton shape=text w200' },
  },
  Spinner: {
    id: 'Spinner', name: 'Spinner', tag: 'span', role: 'status', labelProp: 'label', anatomy: 'spinner',
    axes: { size: ['sm', 'md', 'lg'] },
    defaults: { size: 'md' },
    styles: [
      { when: {}, size: { w: { kind: 'fixed', v: 20 }, h: { kind: 'fixed', v: 20 } }, style: { color: t('color.action.primary') } },
      { when: { size: 'sm' }, size: { w: { kind: 'fixed', v: 16 }, h: { kind: 'fixed', v: 16 } }, style: {} },
      { when: { size: 'lg' }, size: { w: { kind: 'fixed', v: 32 }, h: { kind: 'fixed', v: 32 } }, style: {} },
    ],
    doc: { category: 'Feedback', description: 'Indeterminate loading (short waits only).', example: '@Spinner "Loading runs"' },
  },
  ProgressBar: {
    id: 'ProgressBar', name: 'ProgressBar', tag: 'div', role: 'progressbar', labelProp: 'label', anatomy: 'progress',
    axes: { variant: ['primary', 'success', 'warning', 'error'], size: ['sm', 'md'] },
    defaults: { variant: 'primary', size: 'md' },
    styles: [{ when: {}, layout: { mode: 'col', gap: t('space.1') }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.caption'), color: t('color.text.secondary') } }],
    doc: { category: 'Feedback', description: 'Determinate progress 0–100.', props: { value: { type: 'number', default: 60, description: '0–100' } }, example: '@ProgressBar value=72 "Running 72%"' },
  },
  RunBar: {
    id: 'RunBar', name: 'RunBar', tag: 'div', role: 'img', labelProp: 'label', anatomy: 'runbar',
    axes: { size: ['sm', 'md'] },
    defaults: { size: 'md' },
    styles: [{ when: {}, layout: { mode: 'col', gap: t('space.1') }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.caption'), color: t('color.text.secondary') } }],
    doc: { category: 'Data', description: 'Stacked result bar: passed / failed / skipped (/ flaky). Labelled for screen readers.', props: { passed: { type: 'number', default: 120, description: 'count' }, failed: { type: 'number', default: 6, description: 'count' }, skipped: { type: 'number', default: 8, description: 'count' }, flaky: { type: 'number', default: 0, description: 'count' }, legend: { type: 'boolean', default: true, description: 'show counts' } }, example: '@RunBar passed=142 failed=3 skipped=5' },
  },

  // ---------------------------------------------------------------- navigation
  Tabs: {
    id: 'Tabs', name: 'Tabs', tag: 'div', role: 'tablist', labelProp: 'items', anatomy: 'tabs',
    axes: { variant: ['line', 'pill'] },
    defaults: { variant: 'line' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.4') }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.label'), stroke: { paint: t('color.border.default'), width: 1, align: 'inside' } } },
      { when: { variant: 'pill' }, layout: { mode: 'row', gap: t('space.1') }, style: { stroke: undefined as never } },
    ],
    doc: { category: 'Navigation', description: 'Switch between sibling views. Quoted items separated by |; counts with "Runs:12".', props: { selected: { type: 'number', default: 0, description: 'selected index' } }, example: '@Tabs selected=1 "Overview|Runs:24|Settings"' },
  },
  Breadcrumbs: {
    id: 'Breadcrumbs', name: 'Breadcrumbs', tag: 'nav', role: 'navigation', labelProp: 'items', anatomy: 'breadcrumbs',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: row('space.1.5'), style: { textStyle: t('textStyle.body-sm'), color: t('color.text.secondary') } }],
    doc: { category: 'Navigation', description: 'Location in a hierarchy (3+ levels). Items separated by /; last is current.', example: '@Breadcrumbs "Projects/Checkout/Suites"' },
  },
  Pagination: {
    id: 'Pagination', name: 'Pagination', tag: 'nav', role: 'navigation', labelProp: 'label', anatomy: 'pagination',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: row('space.1'), style: { textStyle: t('textStyle.label'), color: t('color.text.primary') } }],
    doc: { category: 'Navigation', noLabel: true, description: 'Page navigation with ellipsis.', props: { page: { type: 'number', default: 1, description: 'current page' }, pages: { type: 'number', default: 10, description: 'total pages' } }, example: '@Pagination page=3 pages=12' },
  },
  Stepper: {
    id: 'Stepper', name: 'Stepper', tag: 'ol', role: 'list', labelProp: 'steps', anatomy: 'stepper',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: row('space.3'), size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.label'), color: t('color.text.secondary') } }],
    doc: { category: 'Navigation', description: 'Multi-step progress. Steps separated by |.', props: { current: { type: 'number', default: 1, description: 'current step index (0-based)' } }, example: '@Stepper current=1 "Select suite|Configure|Review"' },
  },

  // ---------------------------------------------------------------- feedback
  Alert: {
    id: 'Alert', name: 'Alert', tag: 'div', role: 'alert', labelProp: 'label', anatomy: 'alert',
    axes: { variant: ['info', 'success', 'warning', 'error'] },
    defaults: { variant: 'info' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.3'), align: 'start', padding: [t('space.3'), t('space.4'), t('space.3'), t('space.3')] }, size: { w: { kind: 'fill' } }, style: { radius: t('radius.card'), textStyle: t('textStyle.body-sm') } },
      ...(['info', 'success', 'warning', 'error'] as const).map((v) => ({ when: { variant: v }, style: { fill: [t(`color.status.${v}.bg`)], color: t(`color.status.${v}.fg`) } as Style })),
    ],
    doc: { category: 'Feedback', description: 'Inline message about the page/section. title= optional; dismissible=true adds close.', props: { title: { type: 'string', description: 'bold first line' }, dismissible: { type: 'boolean', default: false, description: 'close button' } }, example: '@Alert variant=warning title="3 tests are flaky" "They failed in 2 of the last 10 runs."' },
  },
  Toast: {
    id: 'Toast', name: 'Toast', tag: 'div', role: 'status', labelProp: 'label', anatomy: 'toast',
    axes: { variant: ['neutral', 'success', 'error'] },
    defaults: { variant: 'neutral' },
    styles: [{ when: {}, layout: { mode: 'row', gap: t('space.3'), align: 'center', padding: [t('space.2'), t('space.2'), t('space.2'), t('space.4')] }, size: { w: { kind: 'hug' }, minW: 280, maxW: 420 }, style: { radius: t('radius.card'), fill: [t('color.bg.inverse')], color: t('color.bg.surface'), textStyle: t('textStyle.body-sm'), shadow: t('shadow.lg') } }],
    doc: { category: 'Feedback', description: 'Brief confirmation of a background action. action= adds a text button (e.g. Undo).', props: { action: { type: 'string', description: 'e.g. Undo' } }, example: '@Toast variant=success action=Undo "Run deleted"' },
  },
};

/** Default component definitions (without docs). */
export function libraryComponents(): Record<string, ComponentDef> {
  return Object.fromEntries(Object.entries(LIBRARY).map(([k, { doc: _doc, ...def }]) => [k, def as ComponentDef]));
}

// ---------------------------------------------------------------- anatomy (inner markup)

export interface AnatomyCtx {
  esc: (s: string) => string;
  /** svg markup for an icon ref, or '' */
  icon: (ref: string, size?: number) => string;
  /** colour token name → CSS var (for markup that needs a colour value, e.g. 3D scenes) */
  color?: (name: string) => string;
  /** URL of an uploaded asset */
  assetUrl?: (id: string) => string | undefined;
  /** an icon's shapes as path data (for 3D extrusion) */
  iconPaths?: (ref: string) => { paths: { d: string; fill: boolean; w?: number }[]; grid: number; stroke: number } | undefined;
}

export interface AnatomyResult {
  tag?: string;
  inner: string;
  attrs?: string[];
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('') || '?';

const num = (v: unknown, d: number) => (typeof v === 'number' ? v : Number.isFinite(Number(v)) && v !== undefined && v !== '' ? Number(v) : d);
const clampPct = (v: number) => Math.max(0, Math.min(100, v));

export const ANATOMY: Record<string, (n: RNode, variant: Record<string, string>, label: string | undefined, c: AnatomyCtx) => AnatomyResult> = {
  button: (n, v, label, c) => {
    const loading = v.state === 'loading';
    return {
      inner: `${loading ? '<span class="rk-spin" aria-hidden="true"></span>' : n.props?.icon ? c.icon(String(n.props.icon), 16) : ''}${c.esc(label ?? '')}${n.props?.iconright ? c.icon(String(n.props.iconright), 16) : ''}`,
      attrs: [...(v.state === 'disabled' ? ['disabled'] : []), ...(loading ? ['aria-busy="true"'] : [])],
    };
  },
  iconbutton: (n, _v, label, c) => ({ inner: c.icon(String(n.props?.icon ?? 'more'), 18), attrs: [`aria-label="${c.esc(label ?? 'Action')}"`, `title="${c.esc(label ?? '')}"`] }),
  input: (n, v, label, c) => {
    const p = n.props ?? {};
    const floating = v.appearance?.startsWith('floating');
    const icon = p.icon ? c.icon(String(p.icon), 16) : '';
    const val = p.value !== undefined ? String(p.value) : '';
    const value = val ? ` value="${c.esc(val)}"` : '';
    const type = ['email', 'password', 'number', 'url', 'tel'].includes(String(p.type)) ? String(p.type) : 'text';
    const star = p.required === true ? '<span class="rk-req" aria-hidden="true"> *</span>' : '';
    const fieldAttrs = `type="${type}" placeholder="${c.esc(floating ? ' ' : label ?? '')}"${value}${v.state === 'disabled' ? ' disabled' : ''}${v.state === 'error' ? ' aria-invalid="true"' : ''}${p.required === true ? ' required' : ''}${p.max ? ` maxlength="${c.esc(String(p.max))}"` : ''}`;
    const float = floating ? `<label class="rk-float${icon ? ' has-icon' : ''}">${c.esc(label ?? '')}${star}</label>` : '';
    const top = p.title ? `<label class="rk-top">${c.esc(String(p.title))}${star}</label>` : '';
    const count = p.max ? `${val.length}/${c.esc(String(p.max))}` : '';
    const help = p.help || count ? `<span class="rk-help"><span>${c.esc(String(p.help ?? ''))}</span><span>${count}</span></span>` : '';
    const space = [p.title ? 'margin-top:22px' : '', help ? 'margin-bottom:22px' : ''].filter(Boolean).join(';');
    return {
      inner: `${top}${icon}${p.prefix ? `<span class="rk-affix">${c.esc(String(p.prefix))}</span>` : ''}<input class="rk-field" ${fieldAttrs}>${float}${p.suffix ? `<span class="rk-affix">${c.esc(String(p.suffix))}</span>` : ''}${p.reveal === true ? `<span class="rk-eye" aria-label="Show password">${c.icon('ui/eye', 16)}</span>` : ''}${p.iconright ? c.icon(String(p.iconright), 16) : ''}${help}`,
      attrs: space ? [`style="${space}"`] : [],
    };
  },
  textarea: (n, v, label, c) => {
    const floating = v.appearance?.startsWith('floating');
    return { inner: `<textarea class="rk-field" placeholder="${c.esc(floating ? ' ' : label ?? '')}"${v.state === 'disabled' ? ' disabled' : ''}>${c.esc(String(n.props?.value ?? ''))}</textarea>${floating ? `<label class="rk-float">${c.esc(label ?? '')}</label>` : ''}` };
  },
  select: (n, v, label, c) => {
    const empty = !label;
    return {
      inner: `${n.props?.title ? `<span class="rk-float-static">${c.esc(String(n.props.title))}</span>` : ''}<span class="rk-value${empty ? ' is-placeholder' : ''}">${c.esc(label ?? String(n.props?.placeholder ?? 'Select…'))}</span>${c.icon('chevron-down', 16)}`,
      attrs: ['type="button"', 'aria-haspopup="listbox"', ...(v.state === 'disabled' ? ['disabled'] : [])],
    };
  },
  search: (n, _v, label, c) => ({
    inner: `${c.icon('search', 16)}<span class="rk-value is-placeholder">${c.esc(label ?? 'Search')}</span>${n.props?.shortcut ? `<kbd class="rk-kbd">${c.esc(String(n.props.shortcut))}</kbd>` : ''}`,
  }),
  checkbox: (_n, v, label, c) => {
    const mark = v.checked === 'true' ? '<path d="M3.5 8.5l3 3 6-7"/>' : v.checked === 'mixed' ? '<path d="M4 8h8"/>' : '';
    return { inner: `<span class="rk-box${v.checked !== 'false' ? ' is-on' : ''}" role="checkbox" aria-checked="${v.checked}"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${mark}</svg></span>${label ? `<span>${c.esc(label)}</span>` : ''}` };
  },
  radio: (_n, v, label, c) => ({ inner: `<span class="rk-radio${v.checked === 'true' ? ' is-on' : ''}" role="radio" aria-checked="${v.checked}"></span>${label ? `<span>${c.esc(label)}</span>` : ''}` }),
  switch: (_n, v, label, c) => ({ inner: `<span class="rk-switch${v.checked === 'true' ? ' is-on' : ''}" role="switch" aria-checked="${v.checked}"><span class="rk-thumb"></span></span>${label ? `<span>${c.esc(label)}</span>` : ''}` }),
  slider: (n, _v, label, c) => {
    const p = clampPct(num(n.props?.value, 50));
    return { inner: `${label ? `<span class="rk-row"><span>${c.esc(label)}</span><span class="rk-num">${p}</span></span>` : ''}<span class="rk-track" role="slider" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><span class="rk-fill" style="width:${p}%"></span><span class="rk-knob" style="left:${p}%"></span></span>` };
  },
  segmented: (n, _v, label, c) => {
    const items = (label ?? 'One|Two').split('|');
    const sel = num(n.props?.selected, 0);
    return { inner: items.map((it, i) => `<span class="rk-seg${i === sel ? ' is-on' : ''}" role="tab" aria-selected="${i === sel}">${c.esc(it)}</span>`).join('') };
  },
  rating: (n, _v, _label, _c) => {
    const val = Math.max(0, Math.min(5, Math.round(num(n.props?.value, 4))));
    const star = (on: boolean) => `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 1.6l1.9 4 4.4.5-3.3 3 .9 4.3L8 11.2 4.1 13.4 5 9.1 1.7 6.1l4.4-.5z" fill="${on ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>`;
    return { inner: Array.from({ length: 5 }, (_, i) => star(i < val)).join(''), attrs: [`aria-label="${val} out of 5"`] };
  },
  badge: (_n, v, label, c) => ({ inner: v.kind === 'dot' ? '' : c.esc(label ?? '1'), attrs: v.kind === 'dot' ? [`aria-label="${c.esc(label ?? 'New')}"`] : [] }),
  tag: (_n, v, label, c) => ({ inner: `${c.esc(label ?? '')}${v.removable === 'true' ? `<span class="rk-remove" role="button" aria-label="Remove ${c.esc(label ?? '')}">${c.icon('close', 12)}</span>` : ''}` }),
  status: (_n, v, label, c) => {
    const icon = { passed: 'check', failed: 'close', running: '', skipped: 'more', flaky: 'retry', blocked: 'alert' }[v.variant ?? 'passed'] ?? 'check';
    const text = label ?? (v.variant ?? 'passed').replace(/^./, (s) => s.toUpperCase());
    return { inner: `<span class="rk-dot rk-st-${v.variant}">${icon ? c.icon(icon, 12) : '<span class="rk-spin rk-spin-xs"></span>'}</span><span>${c.esc(text)}</span>` };
  },
  avatar: (_n, _v, label, c) => ({ inner: c.esc(initials(label ?? '')), attrs: [`aria-label="${c.esc(label ?? 'User')}"`, `title="${c.esc(label ?? '')}"`] }),
  divider: (_n, v, label, c) => (v.orientation === 'vertical' ? { inner: '', attrs: ['aria-orientation="vertical"'] } : { inner: label ? `<span class="rk-line"></span><span>${c.esc(label)}</span><span class="rk-line"></span>` : '<span class="rk-line"></span>' }),
  tooltip: (_n, _v, label, c) => ({ inner: `${c.esc(label ?? '')}<span class="rk-arrow"></span>` }),
  skeleton: () => ({ inner: '', attrs: ['aria-hidden="true"'] }),
  spinner: (_n, _v, label, c) => ({ inner: `<span class="rk-spin rk-spin-fill"></span><span class="rk-sr">${c.esc(label ?? 'Loading')}</span>` }),
  progress: (n, v, label, c) => {
    const p = clampPct(num(n.props?.value, 60));
    return { inner: `${label ? `<span>${c.esc(label)}</span>` : ''}<span class="rk-track rk-${v.size}" role="progressbar" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><span class="rk-fill rk-${v.variant}" style="width:${p}%"></span></span>` };
  },
  runbar: (n, v, label, c) => {
    // sample numbers only when no counts are given at all; otherwise a missing count means 0
    const keys = ['passed', 'failed', 'flaky', 'skipped'] as const;
    const anyGiven = keys.some((k) => n.props?.[k] !== undefined);
    const sample: Record<string, number> = { passed: 120, failed: 6, flaky: 0, skipped: 8 };
    const parts = keys.map((k) => ({ k, n: Math.max(0, num(n.props?.[k], anyGiven ? 0 : sample[k]!)) })).filter((p) => p.n > 0);
    const total = parts.reduce((a, p) => a + p.n, 0) || 1;
    const desc = parts.map((p) => `${p.n} ${p.k}`).join(', ');
    const legend = n.props?.legend === false ? '' : `<span class="rk-legend">${parts.map((p) => `<span><i class="rk-${p.k}"></i>${p.n} ${p.k}</span>`).join('')}</span>`;
    return { inner: `${label ? `<span>${c.esc(label)}</span>` : ''}<span class="rk-bar rk-${v.size}" role="img" data-total="${total}" aria-label="${c.esc(desc)}">${parts.map((p) => `<span class="rk-${p.k}" style="flex:${p.n}" title="${p.n} ${p.k}"></span>`).join('')}</span>${legend}` };
  },
  tabs: (n, _v, label, c) => {
    const items = (label ?? 'One|Two').split('|');
    const sel = num(n.props?.selected, 0);
    return {
      inner: items
        .map((it, i) => {
          const [name, count] = it.split(':');
          return `<span class="rk-tab${i === sel ? ' is-on' : ''}" role="tab" aria-selected="${i === sel}">${c.esc(name ?? '')}${count ? `<span class="rk-count">${c.esc(count)}</span>` : ''}</span>`;
        })
        .join(''),
    };
  },
  breadcrumbs: (_n, _v, label, c) => {
    const items = (label ?? 'Home/Page').split('/');
    return { inner: items.map((it, i) => (i === items.length - 1 ? `<span aria-current="page" class="rk-current">${c.esc(it)}</span>` : `<a href="#" class="rk-crumb">${c.esc(it)}</a><span class="rk-sep" aria-hidden="true">/</span>`)).join(''), attrs: ['aria-label="Breadcrumb"'] };
  },
  pagination: (n, _v, _label, c) => {
    const pages = Math.max(1, Math.round(num(n.props?.pages, 10)));
    const page = Math.max(1, Math.min(pages, Math.round(num(n.props?.page, 1))));
    const set = new Set([1, pages, page - 1, page, page + 1].filter((p) => p >= 1 && p <= pages));
    const list = [...set].sort((a, b) => a - b);
    let html = `<span class="rk-pg rk-nav${page === 1 ? ' is-off' : ''}" aria-label="Previous page">${c.icon('chevron-left', 16)}</span>`;
    list.forEach((p, i) => {
      if (i > 0 && p - list[i - 1]! > 1) html += '<span class="rk-pg rk-gap">…</span>';
      html += `<span class="rk-pg${p === page ? ' is-on' : ''}"${p === page ? ' aria-current="page"' : ''}>${p}</span>`;
    });
    html += `<span class="rk-pg rk-nav${page === pages ? ' is-off' : ''}" aria-label="Next page">${c.icon('chevron-right', 16)}</span>`;
    return { inner: html, attrs: ['aria-label="Pagination"'] };
  },
  stepper: (n, _v, label, c) => {
    const steps = (label ?? 'One|Two|Three').split('|');
    const cur = num(n.props?.current, 0);
    return {
      inner: steps
        .map((s, i) => `<li class="rk-step${i < cur ? ' is-done' : i === cur ? ' is-on' : ''}"${i === cur ? ' aria-current="step"' : ''}><span class="rk-num">${i < cur ? c.icon('check', 12) : i + 1}</span><span>${c.esc(s)}</span></li>${i < steps.length - 1 ? '<span class="rk-join" aria-hidden="true"></span>' : ''}`)
        .join(''),
    };
  },
  alert: (n, v, label, c) => {
    const icon = { info: 'info', success: 'check', warning: 'alert', error: 'alert' }[v.variant ?? 'info']!;
    return {
      inner: `<span class="rk-icon">${c.icon(icon, 18)}</span><span class="rk-body">${n.props?.title ? `<strong>${c.esc(String(n.props.title))}</strong>` : ''}<span>${c.esc(label ?? '')}</span></span>${n.props?.dismissible ? `<span class="rk-close" role="button" aria-label="Dismiss">${c.icon('close', 16)}</span>` : ''}`,
    };
  },
  toast: (n, v, label, c) => {
    const icon = v.variant === 'success' ? c.icon('check', 16) : v.variant === 'error' ? c.icon('alert', 16) : '';
    return { inner: `${icon ? `<span class="rk-icon rk-${v.variant}">${icon}</span>` : ''}<span class="rk-msg">${c.esc(label ?? '')}</span>${n.props?.action ? `<span class="rk-action" role="button">${c.esc(String(n.props.action))}</span>` : ''}<span class="rk-close" role="button" aria-label="Dismiss">${c.icon('close', 14)}</span>` };
  },
};

// ---------------------------------------------------------------- part CSS (tokens only)

const v = (p: string) => `var(--${p.replace(/\./g, '-')})`;

export const COMPONENT_CSS: Record<string, string> = {
  Button: `.rc-Button{cursor:pointer;border:0;white-space:nowrap}.rc-Button:disabled{cursor:not-allowed;opacity:.5}.rc-Button[aria-busy="true"]{cursor:progress}`,
  IconButton: `.rc-IconButton{cursor:pointer;border:0;padding:0;background:transparent}.rc-IconButton svg{display:block}`,
  Link: `.rc-Link{text-decoration:none;text-underline-offset:3px;cursor:pointer}.rc-Link:hover,.rc-Link:focus-visible{text-decoration:underline}`,
  Input: `.rc-Input{cursor:text;position:relative}.rc-Input .rk-affix{color:${v('color.text.secondary')};white-space:nowrap}.rc-Input .rk-eye{display:flex;cursor:pointer}.rc-Input .rk-req{color:${v('color.status.error.fg')}}.rc-Input .rk-top{position:absolute;left:0;bottom:calc(100% + 4px);font:var(--textStyle-label);color:${v('color.text.primary')}}.rc-Input .rk-help{position:absolute;left:0;right:0;top:calc(100% + 4px);display:flex;justify-content:space-between;gap:8px;font:var(--textStyle-caption);color:${v('color.text.secondary')}}.rc-Input[data-state="error"] .rk-help{color:${v('color.status.error.fg')}}.rc-Input .rk-float{position:absolute;left:12px;top:50%;transform:translateY(-50%);transform-origin:left center;pointer-events:none;color:${v('color.text.secondary')};background:transparent;padding:0 4px;margin-left:-4px;transition:top .14s,transform .14s,color .14s,background .14s}.rc-Input .rk-float.has-icon{left:36px}.rc-Input[data-appearance="floating"] .rk-field:focus~.rk-float,.rc-Input[data-appearance="floating"] .rk-field:not(:placeholder-shown)~.rk-float{top:0;left:12px;transform:translateY(-50%) scale(.82);background:${v('color.bg.surface')}}.rc-Input[data-appearance="floating"] .rk-field:focus~.rk-float{color:${v('color.border.focus')}}.rc-Input[data-appearance="floating-filled"] .rk-field{padding-top:16px}.rc-Input[data-appearance="floating-filled"] .rk-field:focus~.rk-float,.rc-Input[data-appearance="floating-filled"] .rk-field:not(:placeholder-shown)~.rk-float{top:12px;transform:translateY(-50%) scale(.8);color:${v('color.border.focus')}}.rc-Input[data-appearance="underlined"]:focus-within,.rc-Input[data-appearance="floating-filled"]:focus-within{box-shadow:none;border-bottom:2px solid ${v('color.border.focus')}}.rc-Input .rk-field{all:unset;flex:1;min-width:0;font:inherit;color:inherit}.rc-Input .rk-field::placeholder{color:${v('color.text.disabled')}}.rc-Input svg{flex-shrink:0;color:${v('color.text.secondary')}}.rc-Input:focus-within{box-shadow:inset 0 0 0 2px ${v('color.border.focus')}}`,
  Textarea: `.rc-Textarea{border:0;resize:vertical;font:inherit;outline:0}.rc-Textarea::placeholder{color:${v('color.text.disabled')}}.rc-Textarea:focus-visible{box-shadow:inset 0 0 0 2px ${v('color.border.focus')}}`,
  Select: `.rc-Select{border:0;cursor:pointer;text-align:left;position:relative}.rc-Select .rk-float-static{position:absolute;left:8px;top:0;transform:translateY(-50%);padding:0 4px;background:${v('color.bg.surface')};font:var(--textStyle-caption);color:${v('color.text.secondary')}}.rc-Select[data-appearance="floating-filled"] .rk-float-static{top:12px;background:none}.rc-Select[data-appearance="floating-filled"] .rk-value{padding-top:14px}.rc-Select .rk-value{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rc-Select .is-placeholder{color:${v('color.text.disabled')}}.rc-Select svg{flex-shrink:0;color:${v('color.text.secondary')}}.rc-Select:disabled{cursor:not-allowed}`,
  SearchInput: `.rc-SearchInput .rk-value{flex:1;min-width:0}.rc-SearchInput svg{flex-shrink:0}.rc-SearchInput .rk-kbd{font:500 11px/18px ${v('font.family.mono')};padding:0 6px;border-radius:4px;box-shadow:inset 0 0 0 1px ${v('color.border.default')};color:${v('color.text.secondary')}}`,
  Checkbox: `.rc-Checkbox{cursor:pointer}.rc-Checkbox .rk-box{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:min(${v('radius.1')}, 5px);box-shadow:inset 0 0 0 1.5px ${v('color.border.strong')};background:${v('color.bg.surface')};color:${v('color.text.onPrimary')};flex-shrink:0}.rc-Checkbox .rk-box.is-on{background:${v('color.action.primary')};box-shadow:none}.rc-Checkbox svg{width:12px;height:12px}`,
  Radio: `.rc-Radio{cursor:pointer}.rc-Radio .rk-radio{width:16px;height:16px;border-radius:50%;box-shadow:inset 0 0 0 1.5px ${v('color.border.strong')};background:${v('color.bg.surface')};flex-shrink:0}.rc-Radio .rk-radio.is-on{box-shadow:inset 0 0 0 5px ${v('color.action.primary')}}`,
  Switch: `.rc-Switch{cursor:pointer}.rc-Switch .rk-switch{position:relative;width:32px;height:18px;border-radius:9px;background:${v('color.bg.track')};flex-shrink:0;transition:background-color 120ms}.rc-Switch .rk-switch.is-on{background:${v('color.action.primary')}}.rc-Switch .rk-thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.2);transition:transform 120ms}.rc-Switch .is-on .rk-thumb{transform:translateX(14px)}`,
  Slider: `.rc-Slider .rk-row{display:flex;justify-content:space-between}.rc-Slider .rk-num{font-variant-numeric:tabular-nums;color:${v('color.text.primary')}}.rc-Slider .rk-track{position:relative;display:block;height:4px;border-radius:2px;background:${v('color.border.default')};margin:6px 0}.rc-Slider .rk-fill{position:absolute;inset:0 auto 0 0;border-radius:2px;background:${v('color.action.primary')}}.rc-Slider .rk-knob{position:absolute;top:50%;width:16px;height:16px;border-radius:50%;background:${v('color.bg.surface')};box-shadow:0 0 0 1.5px ${v('color.action.primary')},0 1px 3px rgba(0,0,0,.2);transform:translate(-50%,-50%)}`,
  Segmented: `.rc-Segmented .rk-seg{padding:4px 12px;border-radius:${v('radius.1')};color:${v('color.text.secondary')};cursor:pointer;white-space:nowrap}.rc-Segmented .rk-seg.is-on{background:${v('color.bg.surface')};color:${v('color.text.primary')};box-shadow:0 1px 2px rgba(16,24,40,.08)}`,
  Rating: `.rc-Rating svg{display:block}`,
  Badge: `.rc-Badge{font-variant-numeric:tabular-nums;line-height:1}`,
  Tag: `.rc-Tag .rk-remove{display:inline-grid;place-items:center;margin-right:-4px;width:16px;height:16px;border-radius:3px;color:${v('color.text.secondary')};cursor:pointer}.rc-Tag .rk-remove:hover{background:${v('color.bg.subtle')}}`,
  Status: `.rc-Status .rk-dot{display:inline-grid;place-items:center;width:16px;height:16px;border-radius:50%;flex-shrink:0}.rc-Status svg{width:10px;height:10px;stroke-width:2.5}
.rk-st-passed{background:${v('color.status.success.bg')};color:${v('color.status.success.fg')}}.rk-st-failed{background:${v('color.status.error.bg')};color:${v('color.status.error.fg')}}.rk-st-running{background:${v('color.status.info.bg')};color:${v('color.status.info.fg')}}.rk-st-skipped{background:${v('color.status.neutral.bg')};color:${v('color.status.neutral.fg')}}.rk-st-flaky{background:${v('color.status.warning.bg')};color:${v('color.status.warning.fg')}}.rk-st-blocked{background:${v('color.status.neutral.bg')};color:${v('color.status.error.fg')}}`,
  Avatar: `.rc-Avatar{font-weight:600;letter-spacing:.02em;user-select:none}`,
  Kbd: `.rc-Kbd{line-height:1}`,
  Divider: `.rc-Divider .rk-line{flex:1;height:1px;background:${v('color.border.default')}}`,
  Tooltip: `.rc-Tooltip{position:relative}.rc-Tooltip .rk-arrow{position:absolute;left:50%;bottom:-4px;width:8px;height:8px;background:inherit;transform:translateX(-50%) rotate(45deg)}.rc-Tooltip[data-placement="bottom"] .rk-arrow{bottom:auto;top:-4px}`,
  Skeleton: `.rc-Skeleton{display:block;position:relative;overflow:hidden}.rc-Skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);transform:translateX(-100%);animation:rk-shimmer 1.4s ease-in-out infinite}@keyframes rk-shimmer{to{transform:translateX(100%)}}@media (prefers-reduced-motion: reduce){.rc-Skeleton::after{animation:none}}`,
  Spinner: `.rc-Spinner{display:inline-block;position:relative}.rk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}`,
  ProgressBar: `.rc-ProgressBar .rk-track{display:block;height:6px;border-radius:3px;background:${v('color.border.default')};overflow:hidden}.rc-ProgressBar .rk-sm{height:4px}.rc-ProgressBar .rk-fill{display:block;height:100%;border-radius:inherit}.rc-ProgressBar .rk-primary{background:${v('color.action.primary')}}.rc-ProgressBar .rk-success{background:${v('color.success.500')}}.rc-ProgressBar .rk-warning{background:${v('color.warning.500')}}.rc-ProgressBar .rk-error{background:${v('color.error.500')}}`,
  RunBar: `.rc-RunBar .rk-bar{display:flex;gap:2px;height:8px;border-radius:4px;overflow:hidden}.rc-RunBar .rk-sm{height:6px}.rc-RunBar .rk-legend{display:flex;gap:12px;flex-wrap:wrap;font-variant-numeric:tabular-nums}.rc-RunBar .rk-legend span{display:inline-flex;align-items:center;gap:4px}.rc-RunBar .rk-legend i{width:8px;height:8px;border-radius:2px}
.rc-RunBar .rk-passed{background:${v('color.success.500')}}.rc-RunBar .rk-failed{background:${v('color.error.500')}}.rc-RunBar .rk-flaky{background:${v('color.warning.500')}}.rc-RunBar .rk-skipped{background:${v('color.neutral.300')}}`,
  Tabs: `.rc-Tabs{box-shadow:inset 0 -1px 0 ${v('color.border.default')}!important}.rc-Tabs .rk-tab{display:inline-flex;align-items:center;gap:6px;padding:10px 2px;color:${v('color.text.secondary')};cursor:pointer;box-shadow:inset 0 -2px 0 transparent;white-space:nowrap}.rc-Tabs .rk-tab.is-on{color:${v('color.text.primary')};box-shadow:inset 0 -2px 0 ${v('color.action.primary')}}.rc-Tabs .rk-count{font:500 11px/16px inherit;padding:0 6px;border-radius:999px;background:${v('color.bg.subtle')};color:${v('color.text.secondary')}}
.rc-Tabs[data-variant="pill"]{box-shadow:none!important}.rc-Tabs[data-variant="pill"] .rk-tab{padding:6px 12px;border-radius:999px;box-shadow:none}.rc-Tabs[data-variant="pill"] .rk-tab.is-on{background:${v('color.bg.selected')};color:${v('color.text.link')};box-shadow:none}`,
  Breadcrumbs: `.rc-Breadcrumbs .rk-crumb{color:inherit;text-decoration:none}.rc-Breadcrumbs .rk-crumb:hover{color:${v('color.text.primary')};text-decoration:underline}.rc-Breadcrumbs .rk-sep{color:${v('color.text.disabled')}}.rc-Breadcrumbs .rk-current{color:${v('color.text.primary')};font-weight:500}`,
  Pagination: `.rc-Pagination .rk-pg{display:inline-grid;place-items:center;min-width:32px;height:32px;padding:0 6px;border-radius:6px;font-variant-numeric:tabular-nums;cursor:pointer}.rc-Pagination .rk-pg:hover{background:${v('color.bg.subtle')}}.rc-Pagination .is-on{background:${v('color.bg.selected')};color:${v('color.text.link')};font-weight:600}.rc-Pagination .rk-gap{cursor:default;color:${v('color.text.secondary')}}.rc-Pagination .rk-gap:hover{background:none}.rc-Pagination .is-off{opacity:.4;pointer-events:none}`,
  Stepper: `.rc-Stepper{list-style:none;padding:0;margin:0}.rc-Stepper .rk-step{display:flex;align-items:center;gap:8px;white-space:nowrap}.rc-Stepper .rk-num{display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;font:600 12px/1 inherit;box-shadow:inset 0 0 0 1.5px ${v('color.border.strong')};color:${v('color.text.secondary')}}.rc-Stepper .is-on{color:${v('color.text.primary')}}.rc-Stepper .is-on .rk-num{background:${v('color.action.primary')};color:${v('color.text.onPrimary')};box-shadow:none}.rc-Stepper .is-done .rk-num{background:${v('color.status.success.bg')};color:${v('color.status.success.fg')};box-shadow:none}.rc-Stepper .rk-join{flex:1;min-width:24px;height:1px;background:${v('color.border.strong')}}`,
  Alert: `.rc-Alert .rk-icon{display:flex;padding-top:1px;flex-shrink:0}.rc-Alert .rk-body{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0}.rc-Alert strong{font-weight:600}.rc-Alert .rk-close{display:flex;opacity:.7;cursor:pointer}`,
  Toast: `.rc-Toast .rk-msg{flex:1}.rc-Toast .rk-icon{display:flex}.rc-Toast .rk-success{color:${v('color.success.300')}}.rc-Toast .rk-error{color:${v('color.error.300')}}.rc-Toast .rk-action{font-weight:600;color:${v('color.primary.300')};cursor:pointer;padding:4px 8px;border-radius:4px}.rc-Toast .rk-close{display:flex;padding:4px;border-radius:4px;opacity:.7;cursor:pointer}[data-mode="dark"] .rc-Toast .rk-action{color:${v('color.primary.700')}}[data-mode="dark"] .rc-Toast .rk-success{color:${v('color.success.700')}}[data-mode="dark"] .rc-Toast .rk-error{color:${v('color.error.700')}}`,
};

/** Shared spinner CSS (used by Button loading, Status running, Spinner). */
export const SHARED_CSS = `.rk-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}.rk-spin{display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:rk-rot .7s linear infinite;flex-shrink:0}.rk-spin-xs{width:9px;height:9px;border-width:1.5px}.rk-spin-fill{width:100%;height:100%;border-width:2px}@keyframes rk-rot{to{transform:rotate(360deg)}}@media (prefers-reduced-motion: reduce){.rk-spin{animation-duration:2s}}`;

// charts, rich inputs and media live in library-data.ts
import { DATA_ANATOMY, DATA_CSS, DATA_LIBRARY } from './library-data.js';
Object.assign(LIBRARY, DATA_LIBRARY);
Object.assign(ANATOMY, DATA_ANATOMY);
Object.assign(COMPONENT_CSS, DATA_CSS);
import { WEB3_ANATOMY, WEB3_CSS, WEB3_LIBRARY } from './library-web3.js';
Object.assign(LIBRARY, WEB3_LIBRARY);
Object.assign(ANATOMY, WEB3_ANATOMY);
Object.assign(COMPONENT_CSS, WEB3_CSS);
import { BASIC_ANATOMY, BASIC_CSS, BASIC_LIBRARY } from './library-basics.js';
Object.assign(LIBRARY, BASIC_LIBRARY);
Object.assign(ANATOMY, BASIC_ANATOMY);
Object.assign(COMPONENT_CSS, BASIC_CSS);
COMPONENT_CSS.Textarea = `.rc-Textarea{position:relative}.rc-Textarea .rk-field{all:unset;display:block;width:100%;height:100%;font:inherit;color:inherit;white-space:pre-wrap;resize:none}.rc-Textarea .rk-field::placeholder{color:var(--color-text-disabled)}.rc-Textarea:focus-within{box-shadow:inset 0 0 0 2px var(--color-border-focus)}.rc-Textarea .rk-float{position:absolute;left:12px;top:16px;pointer-events:none;color:var(--color-text-secondary);padding:0 4px;margin-left:-4px;transition:top .14s,transform .14s;transform-origin:left center}.rc-Textarea .rk-field:focus~.rk-float,.rc-Textarea .rk-field:not(:placeholder-shown)~.rk-float{top:-8px;transform:scale(.82);background:var(--color-bg-surface)}`;
