import { useMemo, useRef, useState } from 'react';
import { DEFAULT_OBJECTS, SCENE_KIT, SCENE_LIGHTS, SCENE_MATERIALS, SCENE_SHAPES, parseSceneObjects, serializeSceneObjects, type RNode, type SceneObject } from '@rangoli/engine';
import { ColorField, Row, Section, Select, TextInput, Toggle, setFlags as set } from './controls';
import type { Opt } from './helpers';
import { api, setView, toast, useEditor } from './store';

export const DEVICES = [
  { name: 'Desktop HD', w: 1920, h: 1080 }, { name: 'Desktop', w: 1440, h: 900 }, { name: 'Laptop', w: 1280, h: 800 },
  { name: 'Tablet', w: 768, h: 1024 }, { name: 'Tablet landscape', w: 1024, h: 768 }, { name: 'Phone', w: 390, h: 844 }, { name: 'Small phone', w: 360, h: 640 },
  { name: 'Open Graph', w: 1200, h: 630 }, { name: 'Instagram post', w: 1080, h: 1080 }, { name: 'Story', w: 1080, h: 1920 },
];

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const num = (v: unknown) => (v === undefined ? '' : String(v));
export const addShapeOptions = SCENE_SHAPES.map((s) => ({ value: s, label: cap(s) }));
const shapes = SCENE_SHAPES.map((s) => ({ value: s, label: cap(s) }));
const mats = [{ value: 'custom', label: 'Custom' }, ...SCENE_MATERIALS.map((s) => ({ value: s, label: cap(s) }))];

/** Drag the label left or right to change the number. */
function NumField({ label, value, onCommit, aria }: { label: string; value: string; onCommit: (v: string) => void; aria: string }) {
  const [live, setLive] = useState<string | null>(null);
  const scrub = (e: React.PointerEvent<HTMLSpanElement>) => {
    const el = e.currentTarget, sx = e.clientX, base = Number(value) || 0;
    el.setPointerCapture(e.pointerId);
    let cur: string | null = null;
    const mv = (ev: PointerEvent) => { const d = Math.round((ev.clientX - sx) / 2) * (ev.shiftKey ? 1 : 0.05); cur = String(Math.round((base + d) * 100) / 100); setLive(cur); };
    const up = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', up); setLive(null); if (cur !== null && cur !== value) onCommit(cur); };
    el.addEventListener('pointermove', mv);
    el.addEventListener('pointerup', up);
  };
  return <div className="lf"><span className="lf-scrub" title="Drag to change, Shift for bigger steps" data-scrub={aria} onPointerDown={scrub}>{label}</span><TextInput value={live ?? value} label={aria} onCommit={onCommit} /></div>;
}

const GROUPS: [string, [string, string][]][] = [
  ['Position', [['x', 'X'], ['y', 'Y'], ['z', 'Z'], ['s', 'Size']]],
  ['Rotation and stretch', [['rx', 'Rot X'], ['ry', 'Rot Y'], ['rz', 'Rot Z'], ['sy', 'Height']]],
  ['Surface', [['metal', 'Metal'], ['rough', 'Rough'], ['glass', 'Glass'], ['glow', 'Glow'], ['opacity', 'Opacity']]],
  ['Motion', [['spin', 'Spin'], ['float', 'Float'], ['orbit', 'Orbit'], ['pulse', 'Pulse']]],
  ['Repeat', [['copies', 'Copies'], ['radius', 'Ring'], ['stepx', 'Step X'], ['stepy', 'Step Y']]],
];

function ModelSource({ o, onChange }: { o: SceneObject; onChange: (p: Partial<SceneObject>) => unknown }) {
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f?: File) => {
    if (!f) return;
    if (f.size > 15 * 1024 * 1024) return toast('error', 'Models can be up to 15 MB');
    const buf = new Uint8Array(await f.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode(...buf.subarray(i, i + 32768));
    const res = await fetch(api('/api/assets'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: f.name, dataUrl: `data:model/gltf-binary;base64,${btoa(bin)}` }) });
    const meta = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !meta.id) return toast('error', meta.error ?? 'Upload failed');
    window.setTimeout(() => void onChange({ asset: meta.id, url: undefined }), 300);
  };
  return (
    <div className="stop">
      <TextInput value={String(o.url ?? '')} placeholder={o.asset ? 'Uploaded model' : 'https://…/model.glb'} label="Model URL" onCommit={(v) => onChange({ url: v || undefined, asset: undefined })} />
      <button className="btn btn-sm-inline" onClick={() => file.current?.click()}>Upload</button>
      <input ref={file} type="file" hidden accept=".glb" aria-label="Upload a GLB model" onChange={(e) => void upload(e.target.files?.[0])} />
    </div>
  );
}

export function ObjectEditor({ index: i, o, list, write, opts }: { index: number; o: SceneObject; list: SceneObject[]; write: (n: SceneObject[]) => unknown; opts: { colors: Opt[] } }) {
  const change = (patch: Partial<SceneObject>) => write(list.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const n = (key: string, v: string) => { if (v === '' || Number.isFinite(Number(v))) void change({ [key]: v === '' ? undefined : Number(v) }); };
  const label = `Object ${i + 1}`;
  return (
    <div className="scene-obj">
      <div className="scene-head">
        <Select value={o.shape} options={shapes} onChange={(v) => change({ shape: v })} />
        <Toggle on={!!o.wire} title="Wireframe" onClick={() => change({ wire: !o.wire })}>Wire</Toggle>
        <button className="btn btn-sm-inline" aria-label={`Remove object ${i + 1}`} onClick={() => write(list.filter((_, j) => j !== i))}>Remove</button>
      </div>
      {o.shape === 'model' && <ModelSource o={o} onChange={change} />}
      {o.shape === 'extrude' && <Row label="Icon"><TextInput value={String(o.icon ?? '')} placeholder="star, or ui/shield" label="Icon to extrude" onCommit={(v) => v && change({ icon: v })} /></Row>}
      {o.shape === 'text' && <Row label="Text"><TextInput value={String(o.text ?? '')} label="3D text" onCommit={(v) => change({ text: v })} /></Row>}
      {o.shape === 'lathe' && <Row label="Profile"><TextInput value={String(o.profile ?? '')} placeholder="0,-1;.9,-1;.5,0;.8,1;0,1" label="Lathe profile" onCommit={(v) => change({ profile: v || undefined })} /></Row>}
      {o.shape === 'blob' && <Row label="Lumps"><TextInput value={num(o.noise)} placeholder="1" label="Blob lumps" onCommit={(v) => n('noise', v)} /></Row>}
      {(o.shape === 'extrude' || o.shape === 'text') && <div className="pair"><NumField label="Depth" aria={`${label} depth`} value={num(o.depth)} onCommit={(v) => n('depth', v)} /><NumField label="Bevel" aria={`${label} bevel`} value={num(o.bevel)} onCommit={(v) => n('bevel', v)} /></div>}
      <Row label="Finish"><Select value={String(o.mat ?? 'custom')} options={mats} onChange={(v) => change({ mat: v === 'custom' ? undefined : v })} /></Row>
      <Row label="Colour"><ColorField value={String(o.color ?? '')} options={opts.colors} label={`${label} colour`} placeholder="colour" onCommit={(v) => change({ color: v || undefined })} /></Row>
      <Row label="Texture"><TextInput value={String(o.map ?? '')} placeholder="https://…/texture.jpg" label={`${label} texture`} onCommit={(v) => change({ map: v || undefined })} /></Row>
      {GROUPS.map(([title, fields]) => (
        <div key={title} className="lf-group">
          <span className="hint">{title}</span>
          <div className="quad lf-grid">{fields.map(([k, l]) => <NumField key={k} label={l} aria={`${label} ${k}`} value={num(o[k])} onCommit={(v) => n(k, v)} />)}</div>
        </div>
      ))}
    </div>
  );
}

export function SceneOptions({ node, opts }: { node: RNode; opts: { colors: Opt[] } }) {
  const id = node.id;
  const p = node.props ?? {};
  const prop = (key: string, v: string) => set(id, v === '' ? `${key}=""` : `${key}=${/^-?\d+(\.\d+)?$/.test(v) || v === 'true' || v === 'false' ? v : JSON.stringify(v)}`, key);
  return (
    <Section title="Scene">
      <Row label="Light"><Select value={String(p.light ?? 'studio')} options={SCENE_LIGHTS.map((l) => ({ value: l, label: cap(l) }))} onChange={(v) => prop('light', v)} /></Row>
      <Row label="Background"><ColorField value={String(p.bg ?? '')} options={[{ value: 'transparent', label: 'transparent' }, ...opts.colors]} label="Scene background" placeholder="transparent" onCommit={(v) => prop('bg', v)} /></Row>
      <div className="quad lf-grid">
        <NumField label="Distance" aria="Camera distance" value={num(p.cam)} onCommit={(v) => prop('cam', v)} />
        <NumField label="Lens" aria="Field of view" value={num(p.fov)} onCommit={(v) => prop('fov', v)} />
        <NumField label="Particles" aria="Particle count" value={num(p.particles)} onCommit={(v) => prop('particles', v)} />
        <NumField label="Auto orbit" aria="Auto orbit speed" value={num(p.autorotate)} onCommit={(v) => prop('autorotate', v)} />
      </div>
      <Row label="Interaction">
        <div className="tog-row">
          <Toggle on={p.orbit !== false} title="Drag to rotate on the live page" onClick={() => prop('orbit', String(p.orbit === false))}>Orbit</Toggle>
          <Toggle on={p.parallax === true} title="Camera follows the pointer" onClick={() => prop('parallax', String(p.parallax !== true))}>Parallax</Toggle>
          <Toggle on={p.floor === true} title="Grid floor" onClick={() => prop('floor', String(p.floor !== true))}>Floor</Toggle>
        </div>
      </Row>
    </Section>
  );
}

/** Compact version in the inspector; the full workspace is the 3D Studio. */
export function SceneSection({ node, opts }: { node: RNode; opts: { colors: Opt[] } }) {
  useEditor((s) => s.version);
  const id = node.id;
  const list = useMemo(() => parseSceneObjects(String(node.props?.objects ?? DEFAULT_OBJECTS)), [node.props?.objects]);
  const write = (next: SceneObject[]) => set(id, `objects=${JSON.stringify(serializeSceneObjects(next))}`, '3D objects');
  return (
    <>
      <Section title="3D scene">
        <div className="btn-row">
          <button className="btn btn-primary" onClick={() => setView('3d')}>Open in 3D Studio</button>
          {SCENE_KIT.slice(0, 4).map((k) => <button key={k.name} className="btn btn-sm-inline" title={`Add ${k.name}`} onClick={() => write([...list, ...parseSceneObjects(k.objects)])}>{k.name}</button>)}
        </div>
        {list.map((o, i) => <ObjectEditor key={i} index={i} o={o} list={list} write={write} opts={opts} />)}
      </Section>
      <SceneOptions node={node} opts={opts} />
    </>
  );
}
