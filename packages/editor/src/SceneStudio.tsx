import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_OBJECTS, SCENE_KIT, mountScene3D, parseSceneObjects, renderFragment, serializeSceneObjects, tokensToCss, type RNode, type SceneObject, type SceneSpec } from '@rangoli/engine';
import { tokenOptions } from './helpers';
import { Row, Section, TextInput, Toggle, setFlags as set } from './controls';
import { ObjectEditor, SceneOptions, addShapeOptions } from './Scene3DPanel';
import { api, canEdit, getState, rdl, select, toast, useEditor } from './store';
import { loadThree } from './three';

type Saved = Record<string, Record<string, string>>;
const savedOf = (): Saved => (getState().doc?.data.tokens as { $extensions?: { rangoli?: { scenes?: Saved } } } | undefined)?.$extensions?.rangoli?.scenes ?? {};
const specOf = (id: string): SceneSpec | undefined => {
  const doc = getState().doc!;
  const m = /data-scene="([^"]*)"/.exec(renderFragment(doc, { roots: [id], assetBase: api('/assets/') }).html);
  if (!m) return undefined;
  const t = document.createElement('textarea');
  t.innerHTML = m[1]!;
  return JSON.parse(t.value) as SceneSpec;
};

export function SceneStudio() {
  useEditor((s) => s.version);
  const doc = getState().doc;
  const selection = useEditor((s) => s.selection);
  const scenes = useMemo(() => (doc ? Object.values(doc.page().nodes).filter((n) => n.component === 'Scene3D') : []), [doc, doc?.page().nodes]);
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const sel = scenes.find((s) => selection.includes(s.id));
    if (sel && sel.id !== id) setId(sel.id);
    else if (!id || !scenes.some((s) => s.id === id)) setId(scenes[0]?.id ?? null);
  }, [scenes, selection, id]);
  const node = scenes.find((s) => s.id === id);
  const newScene = async () => {
    const res = await rdl('@Scene3D w800 h520 light=studio objects="torusknot color=primary.500 mat=chrome"', 'new 3D scene');
    if (res?.created[0]) { setId(res.created[0]); select([res.created[0]]); }
  };
  if (!doc) return null;
  return (
    <div className="studio">
      <aside className="studio-left">
        <section className="section">
          <div className="btn-row" style={{ marginTop: 0 }}>{canEdit() && <button className="btn btn-primary" onClick={() => void newScene()}>New 3D scene</button>}</div>
          {scenes.length > 1 && (
            <Row label="Scene"><select className="input" aria-label="Scene" value={id ?? ''} onChange={(e) => setId(e.target.value)}>{scenes.map((s) => <option key={s.id} value={s.id}>{s.name} · #{s.id}</option>)}</select></Row>
          )}
        </section>
        {node && <Kit node={node} />}
      </aside>
      {node ? <Stage key={node.id} node={node} /> : <main className="studio-center"><div className="panel-empty">Create a 3D scene to begin, or add one from the Add panel.</div></main>}
    </div>
  );
}

function Kit({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const [name, setName] = useState('');
  const saved = useMemo(savedOf, [version]);
  const useKit = (e: { objects: string; light?: string; particles?: number; cam?: number }, add: boolean) => {
    const cur = String(node.props?.objects ?? DEFAULT_OBJECTS);
    void set(node.id, [`objects=${JSON.stringify(add ? `${cur} | ${e.objects}` : e.objects)}`, ...(add ? [] : [`light=${e.light ?? 'studio'}`, `particles=${e.particles ?? 0}`, `cam=${e.cam ?? 6}`])].join(' '), add ? 'add to scene' : 'use preset');
  };
  const save = async () => {
    const p = node.props ?? {};
    const parts = [`objects=${JSON.stringify(String(p.objects ?? DEFAULT_OBJECTS))}`, ...(['light', 'cam', 'particles', 'fov', 'bg'] as const).filter((k) => p[k] !== undefined && p[k] !== '').map((k) => `${k}=${JSON.stringify(String(p[k]))}`)];
    if (await rdl(`sceneset ${JSON.stringify(name.trim())} ${parts.join(' ')}`, `save 3D design ${name}`)) { setName(''); toast('info', 'Saved to My 3D set'); }
  };
  const Tile = ({ e, label }: { e: { objects: string; light?: string; particles?: number; cam?: number }; label: string }) => (
    <div className="kit-tile">
      <button className="kit-main" title={e.objects} onClick={() => useKit(e, false)}>{label}</button>
      <button className="kit-add" title={`Add ${label} to this scene`} aria-label={`Add ${label} to this scene`} onClick={() => useKit(e, true)}>+</button>
    </div>
  );
  return (
    <>
      <section className="section">
        <h3 className="section-title">My 3D set</h3>
        {!Object.keys(saved).length && <p className="hint">Save a design here to reuse it in any scene.</p>}
        <div className="kit-grid">
          {Object.entries(saved).map(([n, o]) => (
            <div key={n} className="kit-tile">
              <button className="kit-main" onClick={() => useKit({ objects: o.objects!, light: o.light, particles: Number(o.particles) || 0, cam: Number(o.cam) || 6 }, false)}>{n}</button>
              <button className="kit-add" aria-label={`Delete ${n}`} title="Delete" onClick={() => void rdl(`sceneset ${JSON.stringify(n)} none`, `delete ${n}`)}>×</button>
            </div>
          ))}
        </div>
        <div className="brand-row">
          <input className="input" placeholder="Name this design" aria-label="Name this 3D design" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button className="btn" disabled={!name.trim()} onClick={() => void save()}>Save</button>
        </div>
      </section>
      <section className="section">
        <h3 className="section-title">Starter kit</h3>
        <p className="hint">Click to start from one, + to add it to this scene. Everything stays editable.</p>
        <div className="kit-grid">{SCENE_KIT.map((k) => <Tile key={k.name} e={k} label={k.name} />)}</div>
      </section>
    </>
  );
}

function Stage({ node }: { node: RNode }) {
  const version = useEditor((s) => s.version);
  const mode = useEditor((s) => s.mode);
  const hostRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const [gizmo, setGizmo] = useState<'translate' | 'rotate' | 'scale'>('translate');
  const [selected, setSelected] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [gridSnap, setGridSnap] = useState(false);
  const state = useRef<{ stop?: (() => void) & { api?: any }; tc?: any; cam?: number[] }>({});
  const src = String(node.props?.objects ?? DEFAULT_OBJECTS);
  const list = useMemo(() => parseSceneObjects(src), [src]);
  const doc = getState().doc!;
  const opts = useMemo(() => tokenOptions(doc, mode), [doc, mode, version]);
  const write = (next: SceneObject[], label: string) => set(node.id, `objects=${JSON.stringify(serializeSceneObjects(next))}`, label);
  const listRef = useRef(list);
  listRef.current = list;
  const selRef = useRef(selected);
  selRef.current = selected;

  const specKey = JSON.stringify(specOf(node.id));
  // CSS variables for token colours live on a hidden element carrying the document's tokens
  useLayoutEffect(() => {
    const host = hostRef.current, tokens = shadowRef.current;
    if (!host || !tokens) return;
    let cancelled = false;
    const spec = specOf(node.id);
    if (!spec) return;
    void loadThree().then((L) => {
      if (cancelled) return;
      const st = state.current;
      if (st.stop?.api) { const c = st.stop.api.camera.position; st.cam = [c.x, c.y, c.z]; }
      st.tc?.dispose?.();
      st.stop?.();
      const stop = mountScene3D(L, host, spec, { interactive: false, studio: true, play: playing } as never);
      st.stop = stop;
      const api = stop.api;
      if (st.cam) api.camera.position.set(st.cam[0], st.cam[1], st.cam[2]);
      const tc = new L.TransformControls(api.camera, api.canvas);
      tc.setMode(gizmo);
      if (gridSnap) { tc.setTranslationSnap(0.25); tc.setRotationSnap(Math.PI / 12); }
      api.scene.add(tc.getHelper());
      tc.addEventListener('dragging-changed', (ev: any) => { if (api.controls) api.controls.enabled = !ev.value; });
      tc.addEventListener('mouseUp', () => {
        const obj = tc.object;
        if (!obj) return;
        const i = obj.userData.index as number;
        const deg = (r: number) => Math.round((r * 180 / Math.PI) * 10) / 10;
        const n3 = (v: number) => Math.round(v * 1000) / 1000;
        const cur = listRef.current;
        const next = cur.map((o, k) => (k === i ? { ...o, x: n3(obj.position.x), y: n3(obj.position.y), z: n3(obj.position.z), rx: deg(obj.rotation.x) || undefined, ry: deg(obj.rotation.y) || undefined, rz: deg(obj.rotation.z) || undefined, ...(Math.abs(obj.scale.x - obj.scale.y) < 1e-3 && Math.abs(obj.scale.y - obj.scale.z) < 1e-3 ? { s: n3(obj.scale.x) } : { sx: n3(obj.scale.x), sy: n3(obj.scale.y), sz: n3(obj.scale.z) }) } : o));
        void set(node.id, `objects=${JSON.stringify(serializeSceneObjects(next))}`, 'transform object');
      });
      st.tc = tc;
      const target = api.items.find((it: any) => it.index === selRef.current);
      if (target) tc.attach(target.obj);
      host.setAttribute('data-studio', 'ready');
    }).catch(() => toast('error', '3D could not start. Reload the page and try again.'));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, playing, gridSnap]);
  useEffect(() => () => { state.current.tc?.dispose?.(); state.current.stop?.(); }, []);
  useEffect(() => { state.current.tc?.setMode?.(gizmo); }, [gizmo]);
  useEffect(() => {
    const st = state.current;
    if (!st.tc || !st.stop?.api) return;
    const target = st.stop.api.items.find((it: any) => it.index === selected);
    if (target) st.tc.attach(target.obj); else st.tc.detach();
  }, [selected]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return;
      const k = e.key.toLowerCase();
      if (k === 'w') setGizmo('translate');
      if (k === 'e') setGizmo('rotate');
      if (k === 'r') setGizmo('scale');
      if ((e.key === 'Delete' || e.key === 'Backspace') && listRef.current[selRef.current]) { e.preventDefault(); void write(listRef.current.filter((_, i) => i !== selRef.current), 'delete object'); setSelected(0); }
      if ((e.ctrlKey || e.metaKey) && k === 'd' && listRef.current[selRef.current]) { e.preventDefault(); const o = listRef.current[selRef.current]!; void write([...listRef.current, { ...o, x: ((o.x as number) ?? 0) + 0.5 }], 'duplicate object'); setSelected(listRef.current.length); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // click an object in the viewport to select it
  const down = useRef<[number, number] | null>(null);
  const onUp = (e: React.PointerEvent) => {
    const st = state.current;
    const d = down.current;
    if (!d || !st.stop?.api || Math.hypot(e.clientX - d[0], e.clientY - d[1]) > 4 || st.tc?.dragging) return;
    const api = st.stop.api, { THREE } = api;
    const r = api.canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), api.camera);
    const hit = ray.intersectObjects(api.items.map((it: any) => it.obj), true)[0];
    if (!hit) return;
    let o = hit.object;
    while (o && o.userData.index === undefined) o = o.parent;
    if (o) setSelected(o.userData.index);
  };
  const cur = list[selected];
  return (
    <>
      <main className="studio-center vs-center">
        <div className="vs-top">
          <div className="seg" role="radiogroup" aria-label="Transform mode">
            {([['translate', 'Move'], ['rotate', 'Rotate'], ['scale', 'Scale']] as const).map(([m, l]) => <button key={m} role="radio" aria-checked={gizmo === m} className="seg-item" title={`${l} (${{ translate: 'W', rotate: 'E', scale: 'R' }[m]})`} onClick={() => setGizmo(m)}>{l}</button>)}
          </div>
          <Toggle on={gridSnap} title="Snap to 0.25 and 15°" onClick={() => setGridSnap(!gridSnap)}>Snap</Toggle>
          <Toggle on={playing} title="Preview spin, float, orbit and pulse" onClick={() => setPlaying(!playing)}>{playing ? 'Pause' : 'Play'}</Toggle>
          <span className="hint">Drag to orbit · scroll to zoom · click an object to select</span>
        </div>
        <div className="s3-stage" ref={shadowRef} style={{ colorScheme: 'normal' }}>
          <TokenScope mode={mode} />
          <div className="s3-view" ref={hostRef} onPointerDown={(e) => { down.current = [e.clientX, e.clientY]; }} onPointerUp={onUp} />
        </div>
      </main>
      <aside className="studio-right">
        <div className="props">
          <div className="inspector-head"><div className="inspector-title">{node.name}</div><div className="inspector-sub">{list.length} objects · #{node.id}</div></div>
          <Section title="Objects">
            <div className="s3-list" role="listbox" aria-label="Objects">
              {list.map((o, i) => <button key={i} role="option" aria-selected={i === selected} className="s3-row" onClick={() => setSelected(i)}>{String(o.name ?? o.shape)}{o.copies ? ` ×${o.copies}` : ''}</button>)}
            </div>
            <select className="input" aria-label="Add a shape" value="" onChange={(e) => { if (e.target.value) { void write([...list, { shape: e.target.value, color: 'primary.500', rough: 0.3, ...(e.target.value === 'model' ? { url: 'https://modelviewer.dev/shared-assets/models/Astronaut.glb' } : {}), ...(e.target.value === 'extrude' ? { icon: 'star', depth: 0.4 } : e.target.value === 'text' ? { text: 'Text', depth: 0.3 } : {}) }], 'add object'); setSelected(list.length); } }}>
              <option value="">Add a shape…</option>
              {addShapeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Section>
          {cur && <ObjectEditor key={selected} index={selected} o={cur} list={list} write={(n) => write(n, 'edit object')} opts={opts} />}
          <SceneOptions node={node} opts={opts} />
          <Section title="Use it"><p className="hint">This scene is a layer on your page. Run shows it live, Export ships it with the page.</p><TextInput value={String(node.props?.label ?? '')} label="Scene description" placeholder="Describe it for screen readers" onCommit={(v) => set(node.id, `label=${JSON.stringify(v)}`, 'description')} /></Section>
        </div>
      </aside>
    </>
  );
}

/** Exposes the document's colour tokens to the viewport as CSS variables. */
function TokenScope({ mode }: { mode: string }) {
  const version = useEditor((s) => s.version);
  const ref = useRef<HTMLStyleElement>(null);
  useLayoutEffect(() => {
    if (ref.current) ref.current.textContent = tokensToCss(getState().doc!.data.tokens).replace(/:root\b/g, '.s3-stage').replace(/\[data-mode="([^"]+)"\]/g, '.s3-stage[data-mode="$1"]');
    ref.current?.parentElement?.setAttribute('data-mode', mode);
  }, [version, mode]);
  return <style ref={ref} />;
}
