import type { ComponentDef, RNode, Style, Layout, Sizing } from './model.js';
import { RangoliDocument } from './document.js';
import { defaultTokens, type DefaultTokenOptions } from './tokens.js';
import { defaultMotion } from './motion.js';

const t = (token: string) => ({ token });

/**
 * Implementation-neutral starter components. Adapters map these to real code components.
 */
export function defaultComponents(): Record<string, ComponentDef> {
  const button: ComponentDef = {
    id: 'Button',
    name: 'Button',
    tag: 'button',
    role: 'action',
    labelProp: 'label',
    axes: { variant: ['primary', 'secondary', 'ghost', 'danger'], size: ['sm', 'md', 'lg'] },
    defaults: { variant: 'primary', size: 'md' },
    styles: [
      {
        when: {},
        layout: { mode: 'row', gap: t('space.2'), align: 'center', justify: 'center', padding: [0, t('space.4'), 0, t('space.4')] },
        size: { h: { kind: 'fixed', v: 36 }, w: { kind: 'hug' } },
        style: { radius: t('radius.2'), textStyle: t('textStyle.label') },
      },
      { when: { size: 'sm' }, size: { h: { kind: 'fixed', v: 32 } }, layout: { mode: 'row', padding: [0, t('space.3'), 0, t('space.3')] }, style: {} },
      { when: { size: 'lg' }, size: { h: { kind: 'fixed', v: 44 } }, layout: { mode: 'row', padding: [0, t('space.5'), 0, t('space.5')] }, style: { textStyle: t('textStyle.body-lg') } },
      { when: { variant: 'primary' }, style: { fill: [t('color.action.primary')], color: t('color.text.onPrimary') } },
      { when: { variant: 'secondary' }, style: { fill: [t('color.bg.surface')], color: t('color.text.primary'), stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' } } },
      { when: { variant: 'ghost' }, style: { fill: [], color: t('color.text.primary') } },
      { when: { variant: 'danger' }, style: { fill: [t('color.action.danger')], color: t('color.text.onDanger') } },
    ],
  };
  const chip: ComponentDef = {
    id: 'Chip',
    name: 'Chip',
    tag: 'span',
    role: 'status',
    labelProp: 'label',
    axes: { variant: ['success', 'warning', 'error', 'info', 'neutral'] },
    defaults: { variant: 'neutral' },
    styles: [
      { when: {}, layout: { mode: 'row', align: 'center', gap: t('space.1'), padding: [t('space.0.5'), t('space.2'), t('space.0.5'), t('space.2')] }, size: { w: { kind: 'hug' } }, style: { radius: t('radius.full'), textStyle: t('textStyle.caption'), font: { weight: 500 } } },
      ...(['success', 'warning', 'error', 'info', 'neutral'] as const).map((v) => ({
        when: { variant: v },
        style: { fill: [t(`color.status.${v}.bg`)], color: t(`color.status.${v}.fg`) } as Style,
      })),
    ],
  };
  const input: ComponentDef = {
    id: 'Input',
    name: 'Input',
    tag: 'input',
    role: 'field',
    labelProp: 'placeholder',
    axes: { size: ['sm', 'md'], state: ['default', 'error', 'disabled'] },
    defaults: { size: 'md', state: 'default' },
    styles: [
      { when: {}, layout: { mode: 'row', align: 'center', padding: [0, t('space.3'), 0, t('space.3')] }, size: { h: { kind: 'fixed', v: 36 }, w: { kind: 'fill' } }, style: { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, radius: t('radius.2'), textStyle: t('textStyle.body'), color: t('color.text.primary') } },
      { when: { size: 'sm' }, size: { h: { kind: 'fixed', v: 32 } }, style: {} },
      { when: { state: 'error' }, style: { stroke: { paint: t('color.error.600'), width: 1, align: 'inside' } } },
      { when: { state: 'disabled' }, style: { fill: [t('color.bg.subtle')], color: t('color.text.disabled') } },
    ],
  };
  return { Button: button, Chip: chip, Input: input };
}

/** Resolve the effective layout/size/style of an instance: component base → matching variant rules → node overrides. */
export function resolveInstance(node: RNode, comp: ComponentDef): { layout?: Layout; size?: Sizing; style: Style; variant: Record<string, string> } {
  const variant = { ...comp.defaults, ...(node.variant ?? {}) };
  let layout: Layout | undefined;
  let size: Sizing | undefined;
  let style: Style = {};
  for (const rule of comp.styles) {
    const matches = Object.entries(rule.when).every(([k, v]) => variant[k] === v);
    if (!matches) continue;
    if (rule.layout) layout = { ...(layout ?? { mode: rule.layout.mode }), ...rule.layout };
    if (rule.size) size = { ...(size ?? {}), ...rule.size };
    style = { ...style, ...rule.style, font: { ...(style.font ?? {}), ...(rule.style.font ?? {}) } };
  }
  if (node.layout) layout = { ...(layout ?? { mode: node.layout.mode }), ...node.layout };
  if (node.size) size = { ...(size ?? {}), ...node.size };
  if (node.style) style = { ...style, ...node.style };
  return { layout, size, style, variant };
}

/** New document with default tokens and starter components. */
export function createDocument(name = 'Untitled', tokenOpts: DefaultTokenOptions = {}): RangoliDocument {
  const doc = RangoliDocument.empty(name);
  doc.data.tokens = defaultTokens(tokenOpts);
  doc.data.components = defaultComponents();
  doc.data.motion = defaultMotion();
  return doc;
}
