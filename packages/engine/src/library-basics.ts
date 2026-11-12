/** Library, part 4: more foundations, so ordinary screens need no custom work. */
import type { RNode } from './model.js';
import type { AnatomyCtx, AnatomyResult, Def } from './library.js';

const t = (token: string) => ({ token });
const v = (p: string) => `var(--${p.replace(/\./g, '-')})`;
const card = { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.default'), width: 1, align: 'inside' as const }, radius: t('radius.card') };
const list = (x: unknown) => String(x ?? '').split('|').map((s) => s.trim()).filter(Boolean);

export const BASIC_ANATOMY: Record<string, (n: RNode, variant: Record<string, string>, label: string | undefined, c: AnatomyCtx) => AnatomyResult> = {
  choicecard: (n, vr, label, c) => {
    const on = vr.selected === 'true';
    const radio = vr.kind === 'radio';
    const mark = radio ? `<span class="rk-mark rk-radio${on ? ' is-on' : ''}"></span>` : `<span class="rk-mark rk-check${on ? ' is-on' : ''}">${on ? c.icon('ui/check', 12) : ''}</span>`;
    return {
      inner: `${n.props?.icon ? `<span class="rk-ic">${c.icon(String(n.props.icon), 20)}</span>` : ''}<span class="rk-body"><b>${c.esc(label ?? 'Option')}</b>${n.props?.description ? `<span>${c.esc(String(n.props.description))}</span>` : ''}</span>${n.props?.meta ? `<span class="rk-meta">${c.esc(String(n.props.meta))}</span>` : ''}${mark}`,
      attrs: [`role="${radio ? 'radio' : 'checkbox'}"`, `aria-checked="${on}"`, 'tabindex="0"'],
    };
  },
  banner: (n, _v, label, c) => ({
    inner: `${n.props?.icon ? c.icon(String(n.props.icon), 16) : ''}<span class="rk-msg">${c.esc(label ?? '')}</span>${n.props?.action ? `<a class="rk-act" href="#">${c.esc(String(n.props.action))}</a>` : ''}${n.props?.dismissible === false ? '' : `<span class="rk-x" aria-label="Dismiss">${c.icon('ui/close', 14)}</span>`}`,
    attrs: ['role="status"'],
  }),
  callout: (n, vr, label, c) => {
    const icons: Record<string, string> = { note: 'ui/info', tip: 'ui/check', warning: 'ui/alert', danger: 'ui/alert' };
    return { inner: `<span class="rk-ic">${c.icon(icons[vr.tone ?? 'note']!, 16)}</span><span class="rk-body">${n.props?.title ? `<b>${c.esc(String(n.props.title))}</b>` : ''}<span>${c.esc(label ?? '')}</span></span>` };
  },
  listitem: (n, _v, label, c) => ({
    inner: `${n.props?.icon ? `<span class="rk-ic">${c.icon(String(n.props.icon), 18)}</span>` : ''}<span class="rk-body"><b>${c.esc(label ?? 'Item')}</b>${n.props?.description ? `<span>${c.esc(String(n.props.description))}</span>` : ''}</span>${n.props?.meta ? `<span class="rk-meta">${c.esc(String(n.props.meta))}</span>` : ''}${n.props?.chevron === false ? '' : c.icon('ui/chevron-right', 16)}`,
  }),
  toggle: (n, vr, label, c) => ({ inner: `${n.props?.icon ? c.icon(String(n.props.icon), 16) : ''}${c.esc(label ?? '')}`, attrs: [`aria-pressed="${vr.pressed === 'true'}"`, 'type="button"'] }),
  buttongroup: (n, _v, label, c) => {
    const sel = Number(n.props?.selected ?? -1);
    return { inner: list(label ?? 'One|Two|Three').map((x, i) => `<button type="button" class="rk-b${i === sel ? ' is-on' : ''}">${c.esc(x)}</button>`).join(''), attrs: ['role="group"'] };
  },
  label: (n, _v, label, c) => ({ inner: `${c.esc(label ?? 'Label')}${n.props?.required === true ? '<span class="rk-req" aria-hidden="true"> *</span>' : ''}${n.props?.optional === true ? '<span class="rk-opt"> (optional)</span>' : ''}`, tag: 'label' }),
};

const tones: Record<string, [string, string]> = { info: ['color.status.info.bg', 'color.status.info.fg'], success: ['color.status.success.bg', 'color.status.success.fg'], warning: ['color.status.warning.bg', 'color.status.warning.fg'], error: ['color.status.error.bg', 'color.status.error.fg'], neutral: ['color.status.neutral.bg', 'color.status.neutral.fg'] };

export const BASIC_LIBRARY: Record<string, Def> = {
  Card: {
    id: 'Card', name: 'Card', tag: 'div', role: 'group', labelProp: 'label',
    axes: { variant: ['outlined', 'elevated', 'filled', 'ghost', 'interactive'] }, defaults: { variant: 'outlined' },
    styles: [
      { when: {}, layout: { mode: 'col', gap: t('space.3'), padding: [t('space.5'), t('space.5'), t('space.5'), t('space.5')] }, size: { w: { kind: 'fill' } }, style: { ...card, color: t('color.text.primary') } },
      { when: { variant: 'elevated' }, style: { stroke: undefined, shadow: t('shadow.md') } },
      { when: { variant: 'filled' }, style: { stroke: undefined, fill: [t('color.bg.subtle')] } },
      { when: { variant: 'ghost' }, style: { stroke: undefined, fill: [] } },
    ],
    doc: { category: 'Display', description: 'Surface for grouped content. Put any layers inside it.', noLabel: true, example: '@Card variant=elevated\n  Text title-sm "Weekly summary"\n  Text body-sm muted "142 runs, 3 failures"' },
  },
  ButtonGroup: {
    id: 'ButtonGroup', name: 'ButtonGroup', tag: 'div', role: 'group', labelProp: 'items', anatomy: 'buttongroup',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'row' }, style: { textStyle: t('textStyle.label'), color: t('color.text.primary') } }],
    doc: { category: 'Actions', description: 'Connected buttons. Quoted text = labels separated by |.', props: { selected: { type: 'number', description: 'index shown as active' } }, example: '@ButtonGroup selected=1 "Day|Week|Month"' },
  },
  Toggle: {
    id: 'Toggle', name: 'Toggle', tag: 'button', role: 'action', labelProp: 'label', anatomy: 'toggle',
    axes: { pressed: ['false', 'true'] }, defaults: { pressed: 'false' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.1.5'), align: 'center', padding: [0, t('space.3'), 0, t('space.3')] }, size: { h: { kind: 'fixed', v: t('size.control.sm') } }, style: { radius: t('radius.control'), textStyle: t('textStyle.label'), color: t('color.text.secondary'), stroke: { paint: t('color.border.strong'), width: 1, align: 'inside' }, fill: [] } },
      { when: { pressed: 'true' }, style: { fill: [t('color.bg.selected')], color: t('color.text.link'), stroke: { paint: t('color.border.focus'), width: 1, align: 'inside' } } },
    ],
    doc: { category: 'Actions', description: 'On/off button for filters and formatting.', props: { icon: { type: 'icon', description: 'leading icon' } }, example: '@Toggle pressed=true icon=filter "Flaky only"' },
  },
  ChoiceCard: {
    id: 'ChoiceCard', name: 'ChoiceCard', tag: 'div', role: 'option', labelProp: 'title', anatomy: 'choicecard',
    axes: { kind: ['radio', 'check'], selected: ['false', 'true'] }, defaults: { kind: 'radio', selected: 'false' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.3'), align: 'center', padding: [t('space.4'), t('space.4'), t('space.4'), t('space.4')] }, size: { w: { kind: 'fill' } }, style: { ...card, textStyle: t('textStyle.body-sm'), color: t('color.text.secondary') } },
      { when: { selected: 'true' }, style: { fill: [t('color.bg.selected')], stroke: { paint: t('color.border.focus'), width: 2, align: 'inside' } } },
    ],
    doc: { category: 'Inputs', description: 'A larger, clearer radio or checkbox: plans, delivery options, onboarding choices.', props: { description: { type: 'string', description: 'second line' }, icon: { type: 'icon', description: 'leading icon' }, meta: { type: 'string', description: 'right side, e.g. a price' } }, example: '@ChoiceCard selected=true description="3–5 days" meta="Free" "Standard delivery"' },
  },
  Banner: {
    id: 'Banner', name: 'Banner', tag: 'div', role: 'status', labelProp: 'message', anatomy: 'banner',
    axes: { variant: Object.keys(tones) }, defaults: { variant: 'info' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.3'), align: 'center', justify: 'center', padding: [t('space.2'), t('space.4'), t('space.2'), t('space.4')] }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.body-sm') } },
      ...Object.entries(tones).map(([k, [bg, fg]]) => ({ when: { variant: k }, style: { fill: [t(bg)], color: t(fg) } })),
    ],
    doc: { category: 'Feedback', description: 'Full-width notice at the top of a page or section.', props: { action: { type: 'string', description: 'link text' }, icon: { type: 'icon', description: 'leading icon' }, dismissible: { type: 'boolean', default: true, description: 'show a close button' } }, example: '@Banner variant=warning action="Upgrade" "Your trial ends in 3 days"' },
  },
  Callout: {
    id: 'Callout', name: 'Callout', tag: 'aside', role: 'note', labelProp: 'body', anatomy: 'callout',
    axes: { tone: ['note', 'tip', 'warning', 'danger'] }, defaults: { tone: 'note' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.3'), padding: [t('space.3'), t('space.4'), t('space.3'), t('space.4')] }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.body-sm'), radius: t('radius.1'), fill: [t('color.status.info.bg')], color: t('color.text.primary'), stroke: { paint: t('color.status.info.fg'), width: 3, align: 'inside', sides: 'l' } } },
      { when: { tone: 'tip' }, style: { fill: [t('color.status.success.bg')], stroke: { paint: t('color.status.success.fg'), width: 3, align: 'inside', sides: 'l' } } },
      { when: { tone: 'warning' }, style: { fill: [t('color.status.warning.bg')], stroke: { paint: t('color.status.warning.fg'), width: 3, align: 'inside', sides: 'l' } } },
      { when: { tone: 'danger' }, style: { fill: [t('color.status.error.bg')], stroke: { paint: t('color.status.error.fg'), width: 3, align: 'inside', sides: 'l' } } },
    ],
    doc: { category: 'Display', description: 'Highlighted note inside content or documentation.', props: { title: { type: 'string', description: 'bold first line' } }, example: '@Callout tone=tip title="Tip" "Tag flaky tests so they stop blocking releases."' },
  },
  ListItem: {
    id: 'ListItem', name: 'ListItem', tag: 'div', role: 'listitem', labelProp: 'title', anatomy: 'listitem',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'row', gap: t('space.3'), align: 'center', padding: [t('space.3'), t('space.3'), t('space.3'), t('space.3')] }, size: { w: { kind: 'fill' } }, style: { textStyle: t('textStyle.body-sm'), color: t('color.text.secondary'), radius: t('radius.control') } }],
    doc: { category: 'Display', description: 'Row for menus, settings and mobile lists.', props: { description: { type: 'string', description: 'second line' }, icon: { type: 'icon', description: 'leading icon' }, meta: { type: 'string', description: 'right text' }, chevron: { type: 'boolean', default: true, description: 'show the arrow' } }, example: '@ListItem icon=bell description="Email and Slack" meta="On" "Notifications"' },
  },
  Label: {
    id: 'Label', name: 'Label', tag: 'label', role: 'text', labelProp: 'text', anatomy: 'label',
    axes: {}, defaults: {},
    styles: [{ when: {}, style: { textStyle: t('textStyle.label'), color: t('color.text.primary') } }],
    doc: { category: 'Inputs', description: 'Field label with required or optional marker.', props: { required: { type: 'boolean', description: 'adds *' }, optional: { type: 'boolean', description: 'adds (optional)' } }, example: '@Label required=true "Work email"' },
  },
};

export const BASIC_CSS: Record<string, string> = {
  ButtonGroup: `.rc-ButtonGroup .rk-b{height:${v('size.control.md')};padding:0 14px;border:0;background:${v('color.bg.surface')};color:inherit;font:inherit;cursor:pointer;box-shadow:inset 0 0 0 1px ${v('color.border.strong')};margin-left:-1px}.rc-ButtonGroup .rk-b:first-child{margin-left:0;border-radius:${v('radius.control')} 0 0 ${v('radius.control')}}.rc-ButtonGroup .rk-b:last-child{border-radius:0 ${v('radius.control')} ${v('radius.control')} 0}.rc-ButtonGroup .rk-b:hover{background:${v('color.bg.subtle')}}.rc-ButtonGroup .is-on{background:${v('color.bg.selected')};color:${v('color.text.link')};position:relative;z-index:1;box-shadow:inset 0 0 0 1px ${v('color.border.focus')}}`,
  Toggle: `.rc-Toggle{border:0;cursor:pointer;white-space:nowrap}`,
  ChoiceCard: `.rc-ChoiceCard{cursor:pointer}.rc-ChoiceCard .rk-body{flex:1;display:flex;flex-direction:column;gap:2px;min-width:0}.rc-ChoiceCard b{color:${v('color.text.primary')};font-weight:600}.rc-ChoiceCard .rk-ic{display:flex;color:${v('color.text.secondary')}}.rc-ChoiceCard .rk-meta{color:${v('color.text.primary')};font-weight:500}.rc-ChoiceCard .rk-mark{display:grid;place-items:center;width:18px;height:18px;flex-shrink:0;box-shadow:inset 0 0 0 1.5px ${v('color.border.strong')};background:${v('color.bg.surface')};color:${v('color.text.onPrimary')}}.rc-ChoiceCard .rk-radio{border-radius:50%}.rc-ChoiceCard .rk-radio.is-on{box-shadow:inset 0 0 0 5px ${v('color.action.primary')}}.rc-ChoiceCard .rk-check{border-radius:min(${v('radius.1')},5px)}.rc-ChoiceCard .rk-check.is-on{background:${v('color.action.primary')};box-shadow:none}`,
  Banner: `.rc-Banner .rk-act{color:inherit;font-weight:600}.rc-Banner .rk-x{display:flex;cursor:pointer;opacity:.7;margin-left:auto}.rc-Banner .rk-msg{min-width:0}`,
  Callout: `.rc-Callout .rk-body{display:flex;flex-direction:column;gap:2px}.rc-Callout b{font-weight:600}.rc-Callout .rk-ic{display:flex;padding-top:2px}`,
  ListItem: `.rc-ListItem{cursor:pointer}.rc-ListItem:hover{background:${v('color.bg.subtle')}}.rc-ListItem .rk-body{flex:1;display:flex;flex-direction:column;gap:1px;min-width:0}.rc-ListItem b{color:${v('color.text.primary')};font-weight:500}.rc-ListItem .rk-ic{display:flex;color:${v('color.text.secondary')}}`,
  Label: `.rc-Label .rk-req{color:${v('color.status.error.fg')}}.rc-Label .rk-opt{color:${v('color.text.secondary')};font-weight:400}`,
};
