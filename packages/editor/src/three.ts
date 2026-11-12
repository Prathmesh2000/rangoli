import FONT_URL from 'three/examples/fonts/helvetiker_bold.typeface.json?url';

let libs: Promise<any> | null = null;

/** three.js and its helpers load on first use, so documents without 3D never pay for them. */
export function loadThree(): Promise<any> {
  return (libs ??= Promise.all([
    import('three'), import('three/examples/jsm/controls/OrbitControls.js'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/environments/RoomEnvironment.js'),
    import('three/examples/jsm/loaders/SVGLoader.js'), import('three/examples/jsm/loaders/FontLoader.js'), import('three/examples/jsm/geometries/TextGeometry.js'), import('three/examples/jsm/controls/TransformControls.js'),
  ]).then(([THREE, o, g, r, s, f, t, c]) => ({ THREE, OrbitControls: o.OrbitControls, GLTFLoader: g.GLTFLoader, RoomEnvironment: r.RoomEnvironment, SVGLoader: s.SVGLoader, FontLoader: f.FontLoader, TextGeometry: t.TextGeometry, TransformControls: c.TransformControls, FONT_URL })));
}
