import { useMemo, useRef, useState } from 'react';
import { LIBRARY, componentRdl, resolveInstance, type Dim, type Len, type Padding, type RNode } from '@rangoli/engine';
import { lenValue, nodeFlags, paintValue, rdlVal, resolvePaintHex, tokenOptions, type Opt } from './helpers';
import { Area, ColorField, Combo, Row, Section, Segmented, Select, TextInput, Toggle, setFlags as set } from './controls';
import { api, getState, rdl, select, toast, useEditor } from './store';
import { FontField } from './FontPicker';
import { IconField } from './IconPicker';
import { DEVICES, SceneSection } from './Scene3DPanel';

type Opts = ReturnType<typeof tokenOptions>;

/** A length field value → RDL: a scale step stays a step, any other number becomes raw px. */
const lenFlag = (v: string, steps: Opt[]) => (steps.some((s) => s.value === v) ? v : /^\d+(\.\d+)?$/.test(v) ? `${v}px` : v);
const opt = (...vals: string[]): Opt[] => vals.map((v) => ({ value: v, label: v }));

const SIZES = opt('10', '11', '12', '13', '14', '15', '16', '18', '20', '22', '24', '28', '32', '36', '40', '48', '56', '64', '72', '80', '96', '120', '160');
const WEIGHTS = ['300', '400', '500', '600', '700', '800', '900'].map((v) => ({ value: v, label: v }));
const LEADING = opt('1', '1.15', '1.25', '1.4', '1.5', '1.75', '2');
const TRACKING = opt('-0.04em', '-0.02em', '-0.01em', '0', '0.02em', '0.04em', '0.08em', '0.12em');
const RATIOS = opt('1/1', '4/3', '3/2', '16/9', '21/9', '3/4', '9/16');
const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'soft-light', 'hard-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity'].map((v) => ({ value: v, label: v }));
const CURSORS = ['auto', 'pointer', 'default', 'text', 'move', 'grab', 'not-allowed', 'help'].map((v) => ({ value: v, label: v }));

export function DesignTab({ node }: { node: RNode }) {
  const mode = useEditor((s) => s.mode);
  const version = useEditor((s) => s.version);
  const doc = getState().doc!;
  const opts = useMemo(() => tokenOptions(doc, mode), [doc, mode, version]);
  const comp = node.component ? doc.data.components[node.component] : undefined;
  const eff = comp ? resolveInstance(node, comp) : { layout: node.layout, size: node.size, style: node.style ?? {}, variant: {} as Record<string, string> };
  const st = eff.style;
  const id = node.id;
  const f = nodeFlags(doc, node);
  const isText = node.type === 'text';
  const isContainer = node.type === 'frame' || node.type === 'group';
  const isPen = node.type === 'vector' && !!node.vector && !node.icon;
  const hasText = isText || (!!comp && !comp.template);
  const parentMode = node.parent ? doc.node(node.parent).layout?.mode : undefined;
  const k = id; // reset local UI state when the selection changes

  return (
    <div className="props">
      {comp?.id === 'Scene3D' && <SceneSection key={`3${k}`} node={node} opts={opts} />}
      {comp && <ComponentSection key={`c${k}`} node={node} variant={eff.variant} />}
      {(isContainer || (node.type === 'vector')) && <CreateComponent key={`m${k}`} node={node} />}

      {node.type === 'vector' && node.icon && <Section key={`ic${k}`} title="Icon"><Row label="Icon"><IconField value={node.icon} onPick={(v) => set(id, `icon:${v}`, 'icon')} /></Row></Section>}
      {hasText && <TypeSection key={`t${k}`} node={node} f={f} opts={opts} st={st} mode={mode} />}

      {isContainer && <LayoutSection key={`l${k}`} id={id} layout={eff.layout} opts={opts} />}

      <PositionSection key={`p${k}`} node={node} f={f} parentFree={parentMode === 'none'} />
      <SizeSection key={`s${k}`} id={id} size={eff.size} ratio={f.kv.ratio ?? ''} root={!node.parent && node.type === 'frame'} />

      {!isText && <FillSection key={`f${k}`} id={id} value={f.kv.fill ?? ''} placeholder={paintValue(st.fill?.[0], opts.resolver)} swatch={resolvePaintHex(st.fill?.[0], opts.resolver, mode)} opts={opts} />}
      {!isText && <StrokeSection key={`b${k}`} id={id} value={f.kv.stroke ?? ''} inherited={paintValue(st.stroke?.paint, opts.resolver)} swatch={resolvePaintHex(st.stroke?.paint, opts.resolver, mode)} opts={opts} />}
      {!isText && <RadiusSection key={`r${k}`} id={id} radius={st.radius} opts={opts} />}
      {!isText && <ShadowSection key={`h${k}`} id={id} layers={f.shadows} inherited={st.shadow && 'token' in st.shadow ? st.shadow.token.replace('shadow.', '') : ''} opts={opts} />}

      <EffectsSection key={`e${k}`} id={id} f={f} />
      {isPen && <PathSection key={`v${k}`} node={node} />}
      <Section key={`x${k}`} title="Custom CSS" collapsed={!f.kv.css}>
        <Area value={f.kv.css ?? ''} code rows={3} label="Custom CSS" placeholder="filter:grayscale(1); letter-spacing:.1em"
          onCommit={(v) => set(id, v ? `css:${JSON.stringify(v)}` : 'unset:css', 'custom CSS')} />
        <p className="hint">Plain declarations for anything not listed above.</p>
      </Section>
    </div>
  );
}

// ------------------------------------------------------------------ components

function ComponentSection({ node, variant }: { node: RNode; variant: Record<string, string> }) {
  const doc = getState().doc!;
  const comp = doc.data.components[node.component!]!;
  const id = node.id;
  const doc2 = LIBRARY[comp.id]?.doc;
  const [editing, setEditing] = useState(false);
  const block = componentRdl(doc, comp.id);
  const [draft, setDraft] = useState('');
  const open = () => { setDraft(block || `component @${comp.id}\n  * shadow:md\n  ${Object.keys(comp.axes)[0] ?? 'variant'}=my-variant rfull`); setEditing(true); };
  const apply = async () => { if (await rdl(draft, `restyle @${comp.id}`)) setEditing(false); };
  return (
    <Section title={comp.template ? 'Building block' : 'Component'}>
      {Object.entries(comp.axes).map(([axis, values]) => (
        <Row key={axis} label={axis}>
          {values.length > 4
            ? <Select value={variant[axis] ?? ''} options={opt(...values)} onChange={(v) => set(id, `${axis}=${v}`)} />
            : <Segmented value={variant[axis] ?? ''} options={values} onChange={(v) => set(id, `${axis}=${v}`)} />}
        </Row>
      ))}
      {comp.template
        ? Object.entries(comp.slots ?? {}).map(([slot, s]) => (
          <Row key={slot} label={slot}>
            <TextInput value={String(node.props?.[slot] ?? '')} label={slot} placeholder={s.kind === 'text' ? String(comp.template!.nodes[s.node]?.text ?? '') : s.kind === 'icon' ? 'ui/star' : 'asset id'}
              onCommit={(v) => set(id, `${slot}=${JSON.stringify(v)}`, `slot ${slot}`)} />
          </Row>
        ))
        : !doc2?.noLabel && <Row label={comp.labelProp ?? 'label'}>
          <TextInput value={String(node.props?.[comp.labelProp ?? 'label'] ?? '')} onCommit={(v) => set(id, JSON.stringify(v), 'edit label')} />
        </Row>}
      {Object.entries(doc2?.props ?? {}).filter(([key]) => comp.id !== 'Scene3D').map(([key, spec]) => (
        <Row key={key} label={key}>
          {spec.type === 'boolean' ? (
            <Segmented value={String(node.props?.[key] ?? spec.default ?? false)} options={['true', 'false']} onChange={(v) => set(id, `${key}=${v}`)} />
          ) : spec.type === 'icon' ? (
            <IconField value={String(node.props?.[key] ?? spec.default ?? '')} onPick={(v) => set(id, `${key}=${v}`)} />
          ) : (
            <TextInput value={String(node.props?.[key] ?? '')} onCommit={(v) => set(id, v === '' ? `${key}=""` : `${key}=${spec.type === 'number' && /^-?\d+(\.\d+)?$/.test(v) ? v : JSON.stringify(v)}`)} />
          )}
        </Row>
      ))}
      {(doc2?.description ?? comp.description) && <p className="hint">{doc2?.description ?? comp.description}</p>}
      <div className="btn-row">
        <button className="btn btn-sm-inline" onClick={open}>{comp.template ? 'Add variants' : `Restyle all ${comp.id}s`}</button>
        {comp.template && <button className="btn btn-sm-inline" title="Turn this instance into editable layers" onClick={() => void rdl(`component @${comp.id} detach #${id}`, `detach @${comp.id}`)}>Edit layers</button>}
        {block && !comp.template && <button className="btn btn-sm-inline" onClick={() => void rdl(`component @${comp.id} reset`, `reset @${comp.id}`)}>Reset</button>}
      </div>
      {editing && (
        <div className="comp-edit">
          <textarea className="input textarea mono" rows={5} value={draft} aria-label="Component rules" spellCheck={false} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <p className="hint">One rule per line: <code>variant=pill rfull px6</code>, or <code>*</code> for every instance. Applies everywhere this component is used.</p>
          <div className="btn-row">
            <button className="btn btn-primary" onClick={() => void apply()}>Apply</button>
            <button className="btn" onClick={() => setEditing(false)}>Cancel</button>
          </div>
        </div>
      )}
    </Section>
  );
}

function CreateComponent({ node }: { node: RNode }) {
  const doc = getState().doc!;
  const blocks = Object.values(doc.data.components).filter((c) => c.template).map((c) => ({ value: c.id, label: `update ${c.id}` }));
  const suggestion = node.name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ?? '').toUpperCase()).replace(/^./, (c) => c.toUpperCase());
  const [name, setName] = useState(suggestion);
  const isUpdate = blocks.some((b) => b.value === name);
  const valid = /^[A-Za-z][\w-]*$/.test(name);
  const create = async () => {
    const res = await rdl(`component @${name} from #${node.id}`, `${isUpdate ? 'update' : 'create'} @${name}`);
    if (res) select([node.id]);
  };
  return (
    <Section title="Building block" collapsed>
      <p className="hint">Save these layers as a reusable component. Text, icon and image layers become editable slots.</p>
      <div className="brand-row">
        <Combo value={name} options={blocks} onCommit={setName} label="Component name" placeholder="PlanCard" />
        <button className="btn btn-primary" disabled={!valid} onClick={() => void create()}>{isUpdate ? 'Update' : 'Create'}</button>
      </div>
    </Section>
  );
}

// ------------------------------------------------------------------ type

function TypeSection({ node, f, opts, st, mode }: { node: RNode; f: ReturnType<typeof nodeFlags>; opts: Opts; st: RNode['style'] & object; mode: string }) {
  const id = node.id;
  const isText = node.type === 'text';
  const b = f.bare;
  const ts = st.textStyle ? (opts.resolver.resolve(st.textStyle.token) as { fontSize?: number; fontWeight?: number; lineHeight?: number } | undefined) : undefined;
  const align = f.kv.align ?? st.textAlign ?? 'left';
  const decoration = b.has('underline') ? 'underline' : b.has('strike') ? 'strike' : '';
  const textCase = b.has('upper') ? 'upper' : b.has('lower') ? 'lower' : b.has('capitalize') ? 'capitalize' : 'none';
  return (
    <Section title={isText ? 'Text' : 'Typography'}>
      {isText && <Area value={node.text ?? ''} label="Text content" onCommit={(v) => set(id, JSON.stringify(v), 'edit text')} />}
      <Row label="Style">
        <Select value={st.textStyle?.token.replace('textStyle.', '') ?? ''} options={opts.textStyles} placeholder="inherit" onChange={(v) => set(id, v)} />
      </Row>
      <Row label="Font">
        <FontField value={f.kv.font ?? ''} placeholder="From text style" onPick={(v) => set(id, v ? `font:${rdlVal(v)}` : 'unset:family', 'font')} />
      </Row>
      <Row label="Size">
        <div className="pair">
          <Combo value={f.kv.size ?? ''} options={SIZES} placeholder={String(ts?.fontSize ?? '')} label="Font size" onCommit={(v) => set(id, v ? `size:${v}` : 'unset:size')} />
          <Select value={f.kv.weight ?? String(ts?.fontWeight ?? '')} options={WEIGHTS} placeholder="weight" onChange={(v) => set(id, `weight:${v}`)} />
        </div>
      </Row>
      <Row label="Line / space">
        <div className="pair">
          <Combo value={f.kv.lh ?? ''} options={LEADING} placeholder="line" label="Line height" onCommit={(v) => set(id, v ? `lh:${v}` : 'unset:lh')} />
          <Combo value={f.kv.ls ?? ''} options={TRACKING} placeholder="letter" label="Letter spacing" onCommit={(v) => set(id, v ? `ls:${v}` : 'unset:ls')} />
        </div>
      </Row>
      <Row label="Align">
        <Segmented value={align} options={['left', 'center', 'right', 'justify']} labels={{ left: 'Left', center: 'Mid', right: 'Right', justify: 'Just' }} onChange={(v) => set(id, `align:${v}`)} />
      </Row>
      <Row label="Decorate">
        <div className="tog-row">
          <Toggle on={b.has('italic')} title="Italic" onClick={() => set(id, b.has('italic') ? 'unset:italic' : 'italic')}><i>I</i></Toggle>
          <Toggle on={decoration === 'underline'} title="Underline" onClick={() => set(id, decoration === 'underline' ? 'unset:decoration' : 'underline')}><u>U</u></Toggle>
          <Toggle on={decoration === 'strike'} title="Strikethrough" onClick={() => set(id, decoration === 'strike' ? 'unset:decoration' : 'strike')}><s>S</s></Toggle>
        </div>
      </Row>
      <Row label="Case">
        <Segmented value={textCase} options={['none', 'upper', 'lower', 'capitalize']} labels={{ none: 'Aa', upper: 'AA', lower: 'aa', capitalize: 'Ab' }} onChange={(v) => set(id, v === 'none' ? 'unset:case' : v)} />
      </Row>
      <Row label="Colour">
        <ColorField live="color" value={f.kv.color ?? ''} options={opts.colors} label="Text colour" placeholder={paintValue(st.color, opts.resolver) || 'inherit'} swatch={resolvePaintHex(st.color, opts.resolver, mode)}
          onCommit={(v) => set(id, v ? `color:${v}` : 'unset:color')} />
      </Row>
    </Section>
  );
}

// ------------------------------------------------------------------ layout, position, size

function LayoutSection({ id, layout, opts }: { id: string; layout: RNode['layout']; opts: Opts }) {
  const m = layout?.mode ?? 'col';
  const pad = layout?.padding;
  const sides: [string, number][] = [['pt', 0], ['pr', 1], ['pb', 2], ['pl', 3]];
  return (
    <Section title="Layout">
      <Row label="Direction">
        <Segmented value={m} options={['col', 'row', 'grid', 'none']} labels={{ col: '↓ Col', row: '→ Row', grid: '▦ Grid', none: 'Free' }} onChange={(v) => set(id, v)} />
      </Row>
      {m === 'grid' && <Row label="Columns"><TextInput value={String(layout?.columns ?? '')} label="Columns" onCommit={(v) => /^\d+$/.test(v) && set(id, `cols${v}`)} /></Row>}
      {m !== 'none' && (
        <>
          <Row label={`Gap${pxOf(opts.space, lenValue(layout?.gap, 'space'))}`}>
            <Combo value={lenValue(layout?.gap, 'space')} options={opts.space} placeholder="0" label="Gap" onCommit={(v) => set(id, v ? `gap${lenFlag(v, opts.space)}` : 'unset:gap')} />
          </Row>
          <Row label={`Padding${pxOf(opts.space, uniformPad(pad))}`}>
            <Combo value={uniformPad(pad)} options={opts.space} placeholder={pad ? 'mixed' : '0'} label="Padding, all sides" onCommit={(v) => set(id, v ? `p${lenFlag(v, opts.space)}` : 'unset:padding')} />
          </Row>
          <Row label="Sides">
            <div className="quad">
              {sides.map(([flag, i]) => (
                <Combo key={flag} value={pad ? lenValue(pad[i], 'space').replace(/^0px$/, '0') : ''} options={opts.space} placeholder="0" label={`Padding ${['top', 'right', 'bottom', 'left'][i]}`} onCommit={(v) => set(id, `${flag}${lenFlag(v || '0', opts.space)}`)} />
              ))}
            </div>
          </Row>
          <Row label="Justify">
            <Segmented value={layout?.justify ?? 'start'} options={['start', 'center', 'end', 'between']} labels={{ start: 'Start', center: 'Mid', end: 'End', between: 'Space' }} onChange={(v) => set(id, v === 'between' ? 'between' : `j${v}`)} />
          </Row>
          <Row label="Align">
            <Segmented value={layout?.align ?? 'stretch'} options={['start', 'center', 'end', 'stretch']} labels={{ start: 'Start', center: 'Mid', end: 'End', stretch: 'Fill' }} onChange={(v) => set(id, v)} />
          </Row>
          {m === 'row' && <Row label="Wrap"><Toggle on={!!layout?.wrap} onClick={() => set(id, layout?.wrap ? 'unset:wrap' : 'wrap')}>Wrap lines</Toggle></Row>}
        </>
      )}
    </Section>
  );
}

/** A scale step's real size, shown beside the field label. */
const pxOf = (steps: Opt[], v: string) => { const m = / · (\d+px)/.exec(steps.find((s) => s.value === v)?.label ?? ''); return m ? ` ${m[1]}` : ''; };

function uniformPad(p: Padding | undefined): string {
  if (!p) return '';
  const vals = p.map((v) => lenValue(v, 'space'));
  return vals.every((v) => v === vals[0]) ? vals[0]! : '';
}

function PositionSection({ node, f, parentFree }: { node: RNode; f: ReturnType<typeof nodeFlags>; parentFree: boolean }) {
  const id = node.id;
  const placed = !!node.absolute || parentFree;
  const x = node.position?.x ?? 0, y = node.position?.y ?? 0;
  return (
    <Section title="Position" collapsed={!placed && !f.kv.rotate && !f.kv.z}>
      {!parentFree && node.parent && (
        <Row label="Place">
          <Segmented value={node.absolute ? 'abs' : 'flow'} options={['flow', 'abs']} labels={{ flow: 'In flow', abs: 'Absolute' }} onChange={(v) => set(id, v === 'abs' ? 'abs' : 'unset:abs')} />
        </Row>
      )}
      {placed && (
        <Row label="X / Y">
          <div className="pair">
            <TextInput value={String(x)} label="X" onCommit={(v) => /^-?\d+(\.\d+)?$/.test(v) && set(id, `at:${v},${y}`)} />
            <TextInput value={String(y)} label="Y" onCommit={(v) => /^-?\d+(\.\d+)?$/.test(v) && set(id, `at:${x},${v}`)} />
          </div>
        </Row>
      )}
      <Row label="Rotate / Z">
        <div className="pair">
          <TextInput value={f.kv.rotate ?? ''} label="Rotation in degrees" placeholder="0°" onCommit={(v) => set(id, v ? `rotate:${v}` : 'unset:rotate')} />
          <TextInput value={f.kv.z ?? ''} label="Stack order" placeholder="z" onCommit={(v) => set(id, v ? `z:${v}` : 'unset:z')} />
        </div>
      </Row>
    </Section>
  );
}

function SizeSection({ id, size, ratio, root }: { id: string; size: RNode['size']; ratio: string; root: boolean }) {
  const lim = (key: 'minW' | 'maxW' | 'minH' | 'maxH', flag: string, label: string) => (
    <TextInput value={typeof size?.[key] === 'number' ? String(size[key]) : ''} placeholder={label} label={label} onCommit={(v) => set(id, v ? `${flag}${v}` : `unset:${flag}`)} />
  );
  return (
    <Section title="Size">
      {root && <Row label="Device"><Select value="" placeholder="Choose a screen size" options={DEVICES.map((d) => ({ value: `w${d.w} h${d.h}`, label: `${d.name} · ${d.w}×${d.h}` }))} onChange={(v) => set(id, v, 'device size')} /></Row>}
      <DimRow axis="w" dim={size?.w} id={id} />
      <DimRow axis="h" dim={size?.h} id={id} />
      <Row label="Min / max W"><div className="pair">{lim('minW', 'minw', 'min')}{lim('maxW', 'maxw', 'max')}</div></Row>
      <Row label="Min / max H"><div className="pair">{lim('minH', 'minh', 'min')}{lim('maxH', 'maxh', 'max')}</div></Row>
      <Row label="Ratio"><Combo value={ratio} options={RATIOS} placeholder="free" label="Aspect ratio" onCommit={(v) => set(id, v ? `ratio:${v}` : 'unset:ratio')} /></Row>
    </Section>
  );
}

function DimRow({ axis, dim, id }: { axis: 'w' | 'h'; dim: Dim | undefined; id: string }) {
  const kind = dim?.kind ?? 'auto';
  const px = dim?.kind === 'fixed' && typeof dim.v === 'number' ? String(dim.v) : '';
  return (
    <Row label={axis === 'w' ? 'Width' : 'Height'}>
      <div className="dim">
        <Segmented value={kind === 'auto' ? 'hug' : kind} options={['hug', 'fill', 'fixed']} labels={{ hug: 'Hug', fill: 'Fill', fixed: 'Fixed' }}
          onChange={(v) => (v === 'fixed' ? set(id, `${axis}${px || 100}`) : set(id, `${axis}${v}`))} />
        {kind === 'fixed' && <TextInput value={px} small label={axis === 'w' ? 'Width in px' : 'Height in px'} onCommit={(v) => /^\d+(\.\d+)?$/.test(v) && set(id, `${axis}${v}`)} />}
      </div>
    </Row>
  );
}

// ------------------------------------------------------------------ paint

interface Grad { type: 'linear' | 'radial'; angle: string; stops: { c: string; at: string }[] }

function parseGrad(v: string): Grad | null {
  const m = /^(linear|radial)\((.*)\)$/.exec(v);
  if (!m) return null;
  const args = m[2]!.split(',').map((s) => s.trim());
  const angle = m[1] === 'linear' && /^-?\d+(\.\d+)?$/.test(args[0] ?? '') ? args.shift()! : '180';
  return { type: m[1] as Grad['type'], angle, stops: args.map((a) => { const [c = '', at = ''] = a.split('@'); return { c, at }; }) };
}
const gradStr = (g: Grad) => `${g.type}(${[...(g.type === 'linear' ? [g.angle] : []), ...g.stops.map((s) => (s.at ? `${s.c}@${s.at}` : s.c))].join(',')})`;

interface Img { src: string; fit: string; pos: string; tint: string }
function parseImage(v: string): Img | null {
  const m = /^image\((.*)\)$/.exec(v);
  if (!m) return null;
  const [src = '', fit = 'cover', pos = 'center', tint = ''] = m[1]!.split(',').map((s) => s.trim());
  return { src, fit, pos, tint };
}
const imageStr = (i: Img) => `image(${i.src},${i.fit}${i.pos !== 'center' || i.tint ? `,${i.pos}` : ''}${i.tint ? `,${i.tint}` : ''})`;
const POSITIONS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];

function ImageFill({ id, image, opts, onDone }: { id: string; image: Img | null; opts: Opts; onDone: () => void }) {
  useEditor((s) => s.version);
  const assets = Object.values(getState().doc!.data.assets ?? {}).filter((a) => a.mime.startsWith('image/'));
  const cur: Img = image ?? { src: '', fit: 'cover', pos: 'center', tint: '' };
  const write = async (n: Img) => { if (n.src && (await set(id, `fill:${imageStr(n)}`, 'background image'))) onDone(); };
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f?: File) => {
    if (!f) return;
    const dataUrl = await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(f); });
    const res = await fetch(api('/api/assets'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, dataUrl }) });
    const meta = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !meta.id) return toast('error', meta.error ?? 'Upload failed');
    window.setTimeout(() => void write({ ...cur, src: meta.id! }), 300);
  };
  return (
    <>
      <div className="img-grid">
        <button className="img-add" onClick={() => file.current?.click()}>Upload</button>
        <input ref={file} type="file" hidden accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif" aria-label="Upload a background image" onChange={(e) => void upload(e.target.files?.[0])} />
        {assets.map((a) => <button key={a.id} className="img-tile" aria-pressed={cur.src === a.id} title={a.name} style={{ backgroundImage: `url("${api(`/assets/${a.file}`)}")` }} aria-label={`Use ${a.name}`} onClick={() => void write({ ...cur, src: a.id })} />)}
      </div>
      <Row label="URL"><TextInput value={cur.src.startsWith('https://') ? cur.src : ''} placeholder="https://…" label="Image URL" onCommit={(v) => v && write({ ...cur, src: v })} /></Row>
      {image && (
        <>
          <Row label="Fit"><Segmented value={cur.fit} options={['cover', 'contain', 'tile']} labels={{ cover: 'Cover', contain: 'Contain', tile: 'Tile' }} onChange={(v) => write({ ...cur, fit: v })} /></Row>
          <Row label="Focus"><Select value={cur.pos} options={opt(...POSITIONS)} onChange={(v) => write({ ...cur, pos: v })} /></Row>
          <Row label="Tint"><ColorField value={cur.tint} options={opts.colors} label="Image tint" placeholder="none" onCommit={(v) => write({ ...cur, tint: v })} /></Row>
        </>
      )}
    </>
  );
}

function FillSection({ id, value, placeholder, swatch, opts }: { id: string; value: string; placeholder: string; swatch?: string; opts: Opts }) {
  const [picking, setPicking] = useState(false);
  const grad = parseGrad(value);
  const image = parseImage(value);
  const kind = image ? 'image' : grad?.type ?? 'solid';
  const colors = useMemo(() => [{ value: 'none', label: 'none' }, ...opts.colors], [opts]);
  const start = (type: Grad['type']) => {
    const from = value && !grad && value !== 'none' ? value : 'primary.500';
    set(id, `fill:${gradStr(grad ? { ...grad, type } : { type, angle: '135', stops: [{ c: from, at: '' }, { c: 'primary.800', at: '' }] })}`, 'gradient');
  };
  const update = (next: Grad) => { if (next.stops.length >= 2 && next.stops.every((s) => s.c)) void set(id, `fill:${gradStr(next)}`, 'gradient'); };
  return (
    <Section title="Fill">
      <Row label="Type">
        <Segmented value={kind} options={['solid', 'linear', 'radial', 'image']} labels={{ solid: 'Solid', linear: 'Linear', radial: 'Radial', image: 'Image' }}
          onChange={(v) => { if (v === 'image') setPicking(true); else if (v === 'solid') void set(id, `fill:${grad?.stops[0]?.c ?? 'surface'}`); else start(v as Grad['type']); }} />
      </Row>
      {(image || picking) && <ImageFill id={id} image={image} opts={opts} onDone={() => setPicking(false)} />}
      {!grad && !image && !picking && (
        <Row label="Colour">
          <ColorField allowNone live="background" value={value} options={colors} label="Fill" placeholder={placeholder || 'none'} swatch={swatch} onCommit={(v) => set(id, v ? `fill:${v}` : 'unset:fill')} />
        </Row>
      )}
      {grad && (
        <>
          {grad.type === 'linear' && <Row label="Angle"><TextInput value={grad.angle} label="Gradient angle" onCommit={(v) => /^-?\d+(\.\d+)?$/.test(v) && update({ ...grad, angle: v })} /></Row>}
          {grad.stops.map((s, i) => (
            <Row key={i} label={`Stop ${i + 1}`}>
              <div className="stop">
                <Combo value={s.c} options={opts.colors} label={`Stop ${i + 1} colour`} onCommit={(v) => v && update({ ...grad, stops: grad.stops.map((x, j) => (j === i ? { ...x, c: v } : x)) })} />
                <TextInput small value={s.at} placeholder="%" label={`Stop ${i + 1} position`} onCommit={(v) => update({ ...grad, stops: grad.stops.map((x, j) => (j === i ? { ...x, at: v } : x)) })} />
                <button className="btn btn-icon" aria-label={`Remove stop ${i + 1}`} disabled={grad.stops.length <= 2} onClick={() => update({ ...grad, stops: grad.stops.filter((_, j) => j !== i) })}>×</button>
              </div>
            </Row>
          ))}
          <button className="btn btn-sm-inline" onClick={() => update({ ...grad, stops: [...grad.stops, { c: 'primary.300', at: '' }] })}>Add stop</button>
        </>
      )}
    </Section>
  );
}

function StrokeSection({ id, value, inherited, swatch, opts }: { id: string; value: string; inherited: string; swatch?: string; opts: Opts }) {
  const parts = value.split('/');
  const cur = {
    c: parts[0] ?? '',
    w: parts.slice(1).find((p) => /^\d/.test(p)) ?? '1',
    style: parts.slice(1).find((p) => /^(solid|dashed|dotted)$/.test(p)) ?? 'solid',
    sides: parts.slice(1).find((p) => /^[tblr]{1,4}$/.test(p)) ?? '',
  };
  const write = (n: typeof cur) => set(id, `stroke:${n.c || 'border'}/${n.w || 1}${n.style !== 'solid' || n.sides ? `/${n.style}` : ''}${n.sides ? `/${n.sides}` : ''}`, 'border');
  const toggleSide = (s: string) => {
    // no sides means all four; removing one from "all" leaves the other three
    const on = cur.sides || 'trbl';
    const next = on.includes(s) ? on.replace(s, '') : 'trbl'.split('').filter((x) => on.includes(x) || x === s).join('');
    if (next) void write({ ...cur, sides: next.length === 4 ? '' : next });
  };
  return (
    <Section title="Border">
      <Row label="Colour">
        <ColorField live="outline" value={cur.c} options={opts.colors} label="Border colour" placeholder={inherited || 'none'} swatch={swatch} onCommit={(v) => (v ? write({ ...cur, c: v }) : set(id, 'unset:stroke'))} />
      </Row>
      {cur.c && (
        <>
          <Row label="Width"><TextInput value={cur.w} label="Border width" onCommit={(v) => /^\d+(\.\d+)?$/.test(v) && write({ ...cur, w: v })} /></Row>
          <Row label="Style"><Segmented value={cur.style} options={['solid', 'dashed', 'dotted']} labels={{ solid: 'Solid', dashed: 'Dash', dotted: 'Dot' }} onChange={(v) => write({ ...cur, style: v })} /></Row>
          <Row label="Sides">
            <div className="tog-row">
              {[['t', 'Top'], ['r', 'Right'], ['b', 'Bottom'], ['l', 'Left']].map(([s, name]) => (
                <Toggle key={s} on={!cur.sides || cur.sides.includes(s!)} title={name} onClick={() => toggleSide(s!)}>{s!.toUpperCase()}</Toggle>
              ))}
            </div>
          </Row>
        </>
      )}
    </Section>
  );
}

function RadiusSection({ id, radius, opts }: { id: string; radius: Len | [Len, Len, Len, Len] | undefined; opts: Opts }) {
  const [split, setSplit] = useState(Array.isArray(radius));
  const num = (v: Len | undefined) => lenValue(v, 'radius').replace(/px$/, '');
  const corners: string[] = Array.isArray(radius) ? radius.map(num) : [0, 1, 2, 3].map(() => num(radius as Len | undefined) || '0');
  const writeCorner = (i: number, v: string) => set(id, `r:${corners.map((c, j) => (j === i ? v || '0' : c)).join(',')}`, 'corner radius');
  return (
    <Section title="Corners" action={<Toggle on={split} title="Set each corner" onClick={() => setSplit(!split)}>Each</Toggle>}>
      {!split && (
        <Row label="Radius">
          <Combo value={Array.isArray(radius) ? '' : lenValue(radius, 'radius')} options={opts.radius} placeholder={Array.isArray(radius) ? 'mixed' : '0'} label="Corner radius" onCommit={(v) => set(id, v ? `r${lenFlag(v, opts.radius)}` : 'unset:radius')} />
        </Row>
      )}
      {split && (
        <Row label="↖ ↗ ↘ ↙">
          <div className="quad">
            {corners.map((c, i) => <TextInput key={i} value={c} label={['Top left', 'Top right', 'Bottom right', 'Bottom left'][i]} onCommit={(v) => writeCorner(i, v)} />)}
          </div>
        </Row>
      )}
    </Section>
  );
}

function ShadowSection({ id, layers, inherited, opts }: { id: string; layers: string[]; inherited: string; opts: Opts }) {
  const custom = layers.some((l) => l.includes(','));
  const rows = custom ? layers.map((l) => { const [x = '0', y = '0', blur = '0', spread = '0', color = 'neutral.900~16', inset] = l.split(','); return { x, y, blur, spread, color, inset: inset === 'inset' }; }) : [];
  type L = (typeof rows)[number];
  const write = (next: L[]) => set(id, next.length ? next.map((l, i) => `shadow${i ? '+' : ''}:${l.x},${l.y},${l.blur},${l.spread},${l.color}${l.inset ? ',inset' : ''}`).join(' ') : 'unset:shadow', 'shadow');
  const change = (i: number, patch: Partial<L>) => write(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const fresh: L = { x: '0', y: '4', blur: '12', spread: '0', color: 'neutral.900~16', inset: false };
  const n = (i: number, key: 'x' | 'y' | 'blur' | 'spread', v: string) => /^-?\d+(\.\d+)?$/.test(v) && change(i, { [key]: v });
  return (
    <Section title="Shadow" collapsed={!layers.length && !inherited} action={<button className="btn btn-sm-inline" onClick={() => write([...rows, fresh])}>Add layer</button>}>
      {!custom && (
        <Row label="Preset">
          <Select value={layers[0] ?? inherited} options={[{ value: 'none', label: 'none' }, ...opts.shadows]} placeholder="none" onChange={(v) => set(id, `shadow:${v}`)} />
        </Row>
      )}
      {rows.map((l, i) => (
        <div key={i} className="shadow-layer">
          <div className="quad">
            <TextInput value={l.x} label="X offset" onCommit={(v) => n(i, 'x', v)} />
            <TextInput value={l.y} label="Y offset" onCommit={(v) => n(i, 'y', v)} />
            <TextInput value={l.blur} label="Blur" onCommit={(v) => n(i, 'blur', v)} />
            <TextInput value={l.spread} label="Spread" onCommit={(v) => n(i, 'spread', v)} />
          </div>
          <div className="stop">
            <Combo value={l.color} options={opts.colors} label="Shadow colour" onCommit={(v) => v && change(i, { color: v })} />
            <Toggle on={l.inset} title="Inner shadow" onClick={() => change(i, { inset: !l.inset })}>In</Toggle>
            <button className="btn btn-icon" aria-label={`Remove shadow layer ${i + 1}`} onClick={() => write(rows.filter((_, j) => j !== i))}>×</button>
          </div>
        </div>
      ))}
      {custom && <p className="hint">X · Y · blur · spread, then colour (<code>token~alpha</code> for opacity).</p>}
    </Section>
  );
}

function EffectsSection({ id, f }: { id: string; f: ReturnType<typeof nodeFlags> }) {
  const k = f.kv;
  return (
    <Section title="Effects" collapsed={!k.opacity && !k.blur && !k.bgblur && !k.blend && !k.overflow && !k.cursor}>
      <Row label="Opacity"><TextInput value={k.opacity ?? ''} placeholder="1" label="Opacity from 0 to 1" onCommit={(v) => set(id, v ? `opacity:${v}` : 'unset:opacity')} /></Row>
      <Row label="Blur"><TextInput value={k.blur ?? ''} placeholder="0" label="Layer blur in px" onCommit={(v) => set(id, v ? `blur:${v}` : 'unset:blur')} /></Row>
      <Row label="Backdrop"><TextInput value={k.bgblur ?? ''} placeholder="0" label="Backdrop blur in px" onCommit={(v) => set(id, v ? `bgblur:${v}` : 'unset:bgblur')} /></Row>
      <Row label="Blend"><Select value={k.blend ?? 'normal'} options={BLENDS} onChange={(v) => set(id, v === 'normal' ? 'unset:blend' : `blend:${v}`)} /></Row>
      <Row label="Overflow"><Segmented value={k.overflow ?? 'visible'} options={['visible', 'hidden', 'auto']} labels={{ visible: 'Show', hidden: 'Clip', auto: 'Scroll' }} onChange={(v) => set(id, v === 'visible' ? 'unset:overflow' : `overflow:${v}`)} /></Row>
      <Row label="Cursor"><Select value={k.cursor ?? 'auto'} options={CURSORS} onChange={(v) => set(id, v === 'auto' ? 'unset:cursor' : `cursor:${v}`)} /></Row>
    </Section>
  );
}

function PathSection({ node }: { node: RNode }) {
  const v = node.vector!;
  const pen = v.paths.filter((p) => !p.fromShapes).map((p) => p.d);
  return (
    <Section title="Path">
      <Row label="View box"><div className="pair"><span className="hint">{v.vw} × {v.vh}</span></div></Row>
      <Area value={pen.join('\n')} code rows={4} label="SVG path data, one path per line" placeholder="M2 20 Q32 2 60 20"
        onCommit={(t) => { const d = t.split('\n').map((l) => l.trim()).filter(Boolean); void set(node.id, ['unset:paths', ...d.map((x) => `d:${JSON.stringify(x)}`)].join(' '), 'edit path'); }} />
      {v.shapes && <p className="hint">Also has drawn shapes: <code>{v.shapes}</code></p>}
    </Section>
  );
}
