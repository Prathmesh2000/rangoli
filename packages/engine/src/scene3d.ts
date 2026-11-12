/**
 * 3D scenes (three.js). A scene is plain data on a @Scene3D layer, written in a small text form:
 *
 *   @Scene3D w640 h400 light=neon orbit=true objects="torusknot color=primary.400 metal=.9 rough=.15 spin=.4 | coin x=2 color=#f5c542"
 *
 * mountScene3D is deliberately self-contained (no imports, no outer references): the editor calls it
 * directly and exports embed its source, so a scene looks the same everywhere.
 */

// Standalone exported pages only (scene3dModule). The editor bundles three itself, so keep this version equal to the one in packages/editor/package.json.
export const THREE_VERSION = '0.170.0';
const ESM = `https://esm.sh/three@${THREE_VERSION}`;
export const THREE_URLS = {
  three: ESM,
  orbit: `${ESM}/examples/jsm/controls/OrbitControls.js`,
  gltf: `${ESM}/examples/jsm/loaders/GLTFLoader.js`,
  room: `${ESM}/examples/jsm/environments/RoomEnvironment.js`,
  svg: `${ESM}/examples/jsm/loaders/SVGLoader.js`,
  font: `${ESM}/examples/jsm/loaders/FontLoader.js`,
  textGeo: `${ESM}/examples/jsm/geometries/TextGeometry.js`,
  transform: `${ESM}/examples/jsm/controls/TransformControls.js`,
};
export const THREE_FONT = `https://cdn.jsdelivr.net/npm/three@${THREE_VERSION}/examples/fonts/helvetiker_bold.typeface.json`;

/** A starting kit: every entry is just objects you can change, recolour, extend or save as your own. */
export const SCENE_KIT: { name: string; objects: string; light?: string; particles?: number; cam?: number }[] = [
  { name: 'Knot', objects: 'torusknot color=primary.500 mat=chrome spin=.4' },
  { name: 'Gem', objects: 'gem color=primary.300 metal=.5 rough=.05 glass=.4 spin=.5 float=1', light: 'neon', particles: 300 },
  { name: 'Token', objects: 'coin mat=gold spin=.8 float=1 | ring s=1.5 color=primary.400 mat=neon rx=75 spin=.3', light: 'dramatic' },
  { name: 'Coin stack', objects: 'coin mat=gold rx=90 copies=6 stepy=.24 y=-.7', light: 'studio', cam: 7 },
  { name: 'Orbit', objects: 'sphere s=.9 color=primary.500 mat=plastic | sphere s=.22 x=2.4 mat=chrome orbit=.8 | sphere s=.16 x=3 color=primary.300 mat=neon orbit=.5', light: 'neon', particles: 500, cam: 8 },
  { name: 'Planet', objects: 'sphere color=primary.600 mat=matte spin=.15 | ring s=1.6 rx=70 color=primary.300 mat=metal', light: 'dramatic', particles: 600, cam: 7 },
  { name: 'Blob', objects: 'blob color=primary.400 mat=chrome spin=.25 float=1', light: 'neon' },
  { name: 'Glass orb', objects: 'sphere color=#ffffff mat=glass float=1 | icosahedron s=.4 color=primary.400 mat=neon spin=.8' },
  { name: 'Cube ring', objects: 'box s=.32 copies=12 radius=2.2 color=primary.400 mat=plastic spin=.6', light: 'studio', cam: 7 },
  { name: 'Node network', objects: 'sphere s=.2 copies=10 radius=2 color=primary.300 mat=neon pulse=1 | torus s=2 color=primary.600 wire spin=.2', light: 'neon', cam: 7 },
  { name: 'Shield', objects: 'extrude icon=shield color=primary.500 mat=metal depth=.5 spin=.5', light: 'studio' },
  { name: 'Wallet', objects: 'extrude icon=wallet color=primary.400 mat=gold depth=.45 spin=.5', light: 'dramatic' },
  { name: '3D text', objects: 'text text=WEB3 color=primary.400 mat=chrome depth=.35', light: 'neon', cam: 7 },
  { name: 'Vase', objects: 'lathe color=primary.300 mat=clay spin=.4' },
  { name: 'Podium', objects: 'cylinder s=1.5 sy=.25 y=-1.2 color=primary.800 mat=matte | gem s=.8 y=.5 color=primary.300 mat=glass spin=.5 float=1', light: 'studio', cam: 7 },
];

export const SCENE_SHAPES = ['box', 'sphere', 'torus', 'torusknot', 'cone', 'cylinder', 'capsule', 'plane', 'ring', 'icosahedron', 'octahedron', 'dodecahedron', 'coin', 'gem', 'blob', 'extrude', 'text', 'lathe', 'model'] as const;
export const SCENE_LIGHTS = ['studio', 'soft', 'neon', 'dramatic'] as const;

const NUM_KEYS = ['x', 'y', 'z', 'rx', 'ry', 'rz', 's', 'sx', 'sy', 'sz', 'metal', 'rough', 'opacity', 'glass', 'glow', 'spin', 'float', 'depth', 'bevel', 'noise', 'copies', 'radius', 'stepx', 'stepy', 'orbit', 'pulse'] as const;
/** Ready-made surfaces: colour stays yours, the finish comes from the preset. */
export const SCENE_MATERIALS = ['matte', 'plastic', 'metal', 'chrome', 'gold', 'glass', 'neon', 'clay', 'toon'] as const;
export interface SceneObject {
  shape: string;
  color?: string;
  emissive?: string;
  wire?: boolean;
  url?: string;
  spinAxis?: string;
  [key: string]: unknown;
}
export interface SceneSpec {
  objects: SceneObject[];
  bg?: string;
  light: string;
  cam: number;
  fov: number;
  orbit: boolean;
  autorotate: number;
  particles: number;
  floor: boolean;
  parallax: boolean;
}

export const DEFAULT_OBJECTS = 'torusknot color=primary.500 metal=.85 rough=.2 spin=.4';

/** "torus color=primary.400 x=1 | sphere s=2" → objects. Unknown shapes and non-https models are dropped. */
export function parseSceneObjects(src: string): SceneObject[] {
  const out: SceneObject[] = [];
  for (const part of src.split('|')) {
    const [shape, ...rest] = part.trim().split(/\s+/);
    if (!shape || !(SCENE_SHAPES as readonly string[]).includes(shape)) continue;
    const o: SceneObject = { shape };
    for (const kv of rest) {
      const i = kv.indexOf('=');
      const k = i < 0 ? kv : kv.slice(0, i), v = i < 0 ? 'true' : kv.slice(i + 1);
      if ((NUM_KEYS as readonly string[]).includes(k)) { if (Number.isFinite(Number(v))) o[k] = Number(v); }
      else if (k === 'color' || k === 'emissive') o[k] = v;
      else if (k === 'wire') o.wire = v !== 'false';
      else if (k === 'axis' && /^[xyz]$/.test(v)) o.spinAxis = v;
      else if ((k === 'url' || k === 'map') && /^https:\/\/[^\s"'<>]+$/.test(v)) o[k] = v;
      else if (k === 'mat' && (SCENE_MATERIALS as readonly string[]).includes(v)) o.mat = v;
      else if (k === 'name' && /^[\w-]{1,40}$/.test(v)) o.name = v;
      else if (k === 'asset' && /^[a-f0-9]{12}$/.test(v)) o.asset = v;
      else if (k === 'icon' && /^[\w~.-]+(\/[\w~.-]+)?$/.test(v)) o.icon = v;
      else if (k === 'text' && v.length <= 60) o.text = v.replace(/_/g, ' ');
      else if (k === 'profile' && /^[\d.,;-]+$/.test(v)) o.profile = v;
    }
    if ((shape === 'model' && !o.url && !o.asset) || (shape === 'extrude' && !o.icon)) continue;
    out.push(o);
  }
  return out;
}

export function serializeSceneObjects(list: SceneObject[]): string {
  return list.map((o) => {
    const bits = [o.shape];
    for (const [k, v] of Object.entries(o)) {
      if (k === 'shape' || v === undefined || v === '') continue;
      if (k === 'spinAxis') bits.push(`axis=${v}`);
      else if (k === 'wire') { if (v) bits.push('wire'); }
      else if (k === 'paths' || k === 'grid') continue;
      else if (k === 'text') bits.push(`text=${String(v).replace(/ /g, '_')}`);
      else bits.push(`${k}=${v}`);
    }
    return bits.join(' ');
  }).join(' | ');
}

export function mountScene3D(L: any, el: HTMLElement, spec: SceneSpec, opts: { interactive: boolean; studio?: boolean; play?: boolean }): (() => void) & { api?: any } {
  const THREE = L.THREE;
  const cs = getComputedStyle(el);
  const col = (c: string | undefined, d: string) => {
    let v = c || d;
    const m = /^var\((--[\w-]+)\)$/.exec(v);
    if (m) v = cs.getPropertyValue(m[1]!).trim() || d;
    return new THREE.Color(v);
  };
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const canvas = renderer.domElement;
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  el.appendChild(canvas);
  const scene = new THREE.Scene();
  if (spec.bg && spec.bg !== 'transparent') scene.background = col(spec.bg, '#000');
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new L.RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  const camera = new THREE.PerspectiveCamera(spec.fov, 1, 0.1, 500);
  camera.position.set(0, 0, spec.cam);

  const light = spec.light;
  scene.environmentIntensity = light === 'dramatic' ? 0.25 : light === 'neon' ? 0.35 : light === 'soft' ? 0.9 : 0.6;
  const add = (l: any, x: number, y: number, z: number) => { l.position.set(x, y, z); scene.add(l); };
  if (light === 'neon') {
    add(new THREE.PointLight(0x22e6a8, 60), -4, 2, 3);
    add(new THREE.PointLight(0x8b5cf6, 60), 4, -2, 3);
    add(new THREE.PointLight(0x38bdf8, 30), 0, 4, -3);
  } else if (light === 'dramatic') {
    add(new THREE.DirectionalLight(0xffffff, 3), 4, 6, 3);
    add(new THREE.DirectionalLight(0x6688ff, 0.6), -5, -1, -2);
  } else {
    add(new THREE.DirectionalLight(0xffffff, light === 'soft' ? 0.8 : 1.6), 3, 5, 4);
    add(new THREE.DirectionalLight(0xffffff, 0.5), -4, 2, 2);
  }

  const geo = (s: string) => {
    switch (s) {
      case 'box': return new THREE.BoxGeometry(1.5, 1.5, 1.5);
      case 'sphere': return new THREE.SphereGeometry(1, 48, 32);
      case 'torus': return new THREE.TorusGeometry(1, 0.38, 32, 96);
      case 'torusknot': return new THREE.TorusKnotGeometry(0.85, 0.28, 220, 32);
      case 'cone': return new THREE.ConeGeometry(1, 1.9, 48);
      case 'cylinder': return new THREE.CylinderGeometry(0.9, 0.9, 1.7, 48);
      case 'capsule': return new THREE.CapsuleGeometry(0.65, 1, 12, 32);
      case 'plane': return new THREE.PlaneGeometry(3, 3);
      case 'ring': return new THREE.RingGeometry(0.65, 1.25, 64);
      case 'icosahedron': return new THREE.IcosahedronGeometry(1.15, 0);
      case 'octahedron': return new THREE.OctahedronGeometry(1.2, 0);
      case 'dodecahedron': return new THREE.DodecahedronGeometry(1.1, 0);
      case 'coin': { const g = new THREE.CylinderGeometry(1.1, 1.1, 0.2, 72); g.rotateX(Math.PI / 2); return g; }
      case 'gem': { const g = new THREE.OctahedronGeometry(1.1, 0); g.scale(1, 1.35, 1); return g; }
      default: return new THREE.BoxGeometry(1, 1, 1);
    }
  };
  /** Material finish: a preset sets the look, explicit values on the object still win. */
  const FINISH: Record<string, any> = {
    matte: { metal: 0, rough: 0.95 }, plastic: { metal: 0, rough: 0.35 }, metal: { metal: 1, rough: 0.35 }, chrome: { metal: 1, rough: 0.06 },
    gold: { metal: 1, rough: 0.22, color: '#f5c542' }, glass: { metal: 0, rough: 0.03, glass: 1 }, neon: { metal: 0, rough: 0.4, glow: 2.5 }, clay: { metal: 0, rough: 1 },
  };
  const material = (o0: any) => {
    const o = { ...(FINISH[o0.mat] ?? {}), ...o0 };
    const glass = o.glass ?? 0, opacity = o.opacity ?? 1;
    if (o.mat === 'toon') return new THREE.MeshToonMaterial({ color: col(o.color, '#8b8b95') });
    const m = new THREE.MeshPhysicalMaterial({
      color: col(o.color, '#8b8b95'), metalness: o.metal ?? 0.1, roughness: o.rough ?? 0.4,
      emissive: col(o.emissive ?? o.color, '#000000'), emissiveIntensity: o.glow ?? 0,
      wireframe: !!o.wire, transparent: opacity < 1, opacity, transmission: glass, thickness: glass ? 1.2 : 0, ior: 1.45, clearcoat: glass ? 1 : 0.2,
      side: o.shape === 'plane' || o.shape === 'ring' ? THREE.DoubleSide : THREE.FrontSide,
    });
    if (o.map) new THREE.TextureLoader().load(o.map, (t: any) => { t.colorSpace = THREE.SRGBColorSpace; m.map = t; m.needsUpdate = true; invalidate(); });
    return m;
  };
  const blob = (noise: number) => {
    const g = new THREE.IcosahedronGeometry(1.2, 32);
    const p = g.attributes.position, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const n = Math.sin(v.x * 2.1 + 1.3) * Math.cos(v.y * 2.7) + Math.sin(v.z * 2.3 + v.y) * 0.6;
      v.multiplyScalar(1 + n * 0.22 * noise);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  };
  const lathe = (profile: string | undefined) => {
    const pts = (profile || '0,-1;0.9,-1;0.5,0;0.8,1;0,1').split(';').map((p) => { const [a, b] = p.split(',').map(Number); return new THREE.Vector2(a, b); });
    return new THREE.LatheGeometry(pts, 64);
  };
  /** Extrude an icon: filled shapes become solids, strokes become tubes, so any drawn icon works in 3D. */
  const extrudeIcon = (o: any) => {
    const group = new THREE.Group();
    const grid = o.grid || 24, k = 3 / grid;
    const depth = o.depth ?? 0.4, bevel = o.bevel ?? 0.04;
    const mat = material(o);
    disposables.push(mat);
    for (const p of o.paths ?? []) {
      const parsed = new L.SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${p.d}"/></svg>`).paths[0];
      if (!parsed) continue;
      if (p.fill) {
        for (const sh of parsed.toShapes(true)) {
          const g = new THREE.ExtrudeGeometry(sh, { depth: depth / k, bevelEnabled: bevel > 0, bevelSize: bevel / k, bevelThickness: bevel / k, bevelSegments: 4, curveSegments: 24 });
          disposables.push(g);
          group.add(new THREE.Mesh(g, mat));
        }
      } else {
        for (const sub of parsed.subPaths) {
          const pts = sub.getSpacedPoints(Math.max(24, Math.round(sub.getLength() * 4))).map((q: any) => new THREE.Vector3(q.x, q.y, depth / k / 2));
          const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0.05), pts.length * 2, ((p.w ?? o.stroke ?? 1.5) / 2) * (1 + depth * 0.6), 10, false);
          disposables.push(g);
          group.add(new THREE.Mesh(g, mat));
        }
      }
    }
    group.scale.set(k, -k, k);
    group.position.set(-grid * k / 2, grid * k / 2, -depth / 2);
    const holder = new THREE.Group();
    holder.add(group);
    return holder;
  };
  const textObject = (o: any, done: (obj: any) => void) => {
    new L.FontLoader().load(L.FONT_URL, (font: any) => {
      const g = new L.TextGeometry(o.text ?? 'Text', { font, size: 0.9, depth: o.depth ?? 0.3, curveSegments: 12, bevelEnabled: (o.bevel ?? 0.02) > 0, bevelSize: o.bevel ?? 0.02, bevelThickness: o.bevel ?? 0.02, bevelSegments: 3 });
      g.center();
      const m = material(o);
      disposables.push(g, m);
      done(new THREE.Mesh(g, m));
    });
  };
  const items: any[] = [];
  const disposables: any[] = [];
  const place = (obj: any, o: any, idx = 0) => {
    obj.userData.index = idx;
    obj.position.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    obj.rotation.set(((o.rx ?? 0) * Math.PI) / 180, ((o.ry ?? 0) * Math.PI) / 180, ((o.rz ?? 0) * Math.PI) / 180);
    const s = o.s ?? 1;
    obj.scale.set(o.sx ?? s, o.sy ?? s, o.sz ?? s);
    scene.add(obj);
    items.push({ obj, o, y: o.y ?? 0, phase: items.length * 1.3, x: o.x ?? 0, z: o.z ?? 0, s, index: idx });
  };
  let frames = 0;
  const invalidate = () => { frames = Math.max(frames, 2); };
  spec.objects.forEach((o0, idx) => {
    // copies=8 radius=2 makes a ring; copies=5 stepx=1.2 stepy=0 makes a row
    const n = Math.max(1, Math.min(200, (o0.copies as number) ?? 1));
    for (let c = 0; c < n; c++) {
      const a = (c / n) * Math.PI * 2, r = (o0.radius as number) ?? 0;
      const o: any = n === 1 ? o0 : { ...o0, x: ((o0.x as number) ?? 0) + r * Math.cos(a) + c * ((o0.stepx as number) ?? 0), y: ((o0.y as number) ?? 0) + r * Math.sin(a) + c * ((o0.stepy as number) ?? 0) };
      if (o.shape === 'model') { new L.GLTFLoader().load(o.url, (g: any) => { place(g.scene, o, idx); invalidate(); }, null, (e: any) => console.warn('Could not load the 3D model', o.url, e?.message ?? e)); continue; }
      if (o.shape === 'extrude') { place(extrudeIcon(o), o, idx); continue; }
      if (o.shape === 'text') { textObject(o, (mesh) => { place(mesh, o, idx); invalidate(); }); continue; }
      const g = o.shape === 'blob' ? blob(o.noise ?? 1) : o.shape === 'lathe' ? lathe(o.profile) : geo(o.shape);
      const m = material(o);
      disposables.push(g, m);
      place(new THREE.Mesh(g, m), o, idx);
    }
  });
  let points: any;
  if (spec.particles > 0) {
    const n = Math.min(spec.particles, 4000);
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) pos[i] = (Math.random() - 0.5) * 22;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const m = new THREE.PointsMaterial({ size: 0.04, color: new THREE.Color(cs.getPropertyValue('--color-text-secondary').trim() || '#99a'), transparent: true, opacity: 0.8 });
    points = new THREE.Points(g, m);
    scene.add(points);
    disposables.push(g, m);
  }
  if (spec.floor) {
    const grid = new THREE.GridHelper(24, 24, col('var(--color-border-strong)', '#555'), col('var(--color-border-default)', '#333'));
    grid.position.y = -2;
    scene.add(grid);
  }
  let controls: any;
  if ((opts.interactive && spec.orbit) || opts.studio) {
    controls = new L.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.autoRotate = spec.autorotate > 0;
    controls.autoRotateSpeed = spec.autorotate;
  }
  let w = 0, h = 0;
  const resize = () => {
    const nw = el.clientWidth || 1, nh = el.clientHeight || 1;
    if (nw === w && nh === h) return;
    w = nw; h = nh;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(el);
  resize();
  const px = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    const r = el.getBoundingClientRect();
    px.x = (e.clientX - r.left) / r.width - 0.5;
    px.y = (e.clientY - r.top) / r.height - 0.5;
  };
  if (spec.parallax && opts.interactive) window.addEventListener('pointermove', onMove);
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches || (opts.studio && !opts.play);
  let visible = true;
  const io = new IntersectionObserver((e) => { visible = e.some((x) => x.isIntersecting); });
  io.observe(el);
  const clock = new THREE.Clock();
  let raf = 0;
  const animates = opts.studio || !still && (items.some((i) => i.o.spin || i.o.float || i.o.orbit || i.o.pulse) || !!points || spec.parallax || !!controls);
  const tick = () => {
    raf = requestAnimationFrame(tick);
    if (!visible) return;
    if (!animates && frames <= 0) return;
    frames--;
    const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
    if (!still) {
      for (const it of items) {
        if (it.o.spin) it.obj.rotation[it.o.spinAxis ?? 'y'] += it.o.spin * dt;
        if (it.o.float) it.obj.position.y = it.y + Math.sin(t * 1.1 + it.phase) * 0.18 * it.o.float;
        if (it.o.orbit) { const a = t * it.o.orbit + it.phase, r = Math.hypot(it.x, it.z) || 2; it.obj.position.x = r * Math.cos(a); it.obj.position.z = r * Math.sin(a); }
        if (it.o.pulse) { const v = it.s * (1 + Math.sin(t * 2 + it.phase) * 0.08 * it.o.pulse); it.obj.scale.setScalar(v); }
      }
      if (points) points.rotation.y += dt * 0.02;
      if (spec.parallax) { camera.position.x += (px.x * 1.5 - camera.position.x) * 0.06; camera.position.y += (-px.y * 1.5 - camera.position.y) * 0.06; camera.lookAt(0, 0, 0); }
    }
    controls?.update();
    renderer.render(scene, camera);
    el.setAttribute('data-ready', '1');
  };
  frames = 3;
  tick();
  const stop: any = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    window.removeEventListener('pointermove', onMove);
    controls?.dispose();
    for (const d of disposables) d.dispose();
    envTex.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    canvas.remove();
  };
  stop.api = { THREE, scene, camera, renderer, items, canvas, invalidate, get controls() { return controls; } };
  return stop;
}

/** Inline module for standalone pages: finds every .rk-3d and mounts it. */
export function scene3dModule(interactive = true): string {
  return `import * as THREE from '${THREE_URLS.three}';
import { OrbitControls } from '${THREE_URLS.orbit}';
import { GLTFLoader } from '${THREE_URLS.gltf}';
import { RoomEnvironment } from '${THREE_URLS.room}';
import { SVGLoader } from '${THREE_URLS.svg}';
import { FontLoader } from '${THREE_URLS.font}';
import { TextGeometry } from '${THREE_URLS.textGeo}';
const mount = ${mountScene3D.toString()};
document.querySelectorAll('.rk-3d').forEach((el) => { try { mount({ THREE, OrbitControls, GLTFLoader, RoomEnvironment, SVGLoader, FontLoader, TextGeometry, FONT_URL: '${THREE_FONT}' }, el, JSON.parse(el.dataset.scene), { interactive: ${interactive} }); } catch (e) { console.error(e); } });`;
}
