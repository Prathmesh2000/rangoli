/**
 * Library, part 3: 3D scenes and web3 interface components. The wallet and transaction states follow
 * the common dApp UX guidance: every wallet condition is an explicit state, and a transaction moves
 * through visible stages with a link to the block explorer.
 */
import type { RNode } from './model.js';
import type { AnatomyCtx, AnatomyResult, Def } from './library.js';
import { DEFAULT_OBJECTS, parseSceneObjects, type SceneSpec } from './scene3d.js';

const t = (token: string) => ({ token });
const v = (p: string) => `var(--${p.replace(/\./g, '-')})`;
const num = (x: unknown, d: number) => (x !== undefined && x !== '' && Number.isFinite(Number(x)) ? Number(x) : d);
const short = (a: string) => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);
const SAMPLE_ADDRESS = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';

export const WEB3_ANATOMY: Record<string, (n: RNode, variant: Record<string, string>, label: string | undefined, c: AnatomyCtx) => AnatomyResult> = {
  scene3d: (n, _v, label, c) => {
    const p = n.props ?? {};
    const colour = (s: unknown) => (typeof s === 'string' && s ? (c.color?.(s) ?? s) : undefined);
    const objects = parseSceneObjects(String(p.objects ?? DEFAULT_OBJECTS)).map((o) => ({ ...o, color: colour(o.color), emissive: colour(o.emissive), ...(o.icon ? { ...(c.iconPaths?.(String(o.icon)) ?? {}) } : {}), ...(o.asset ? { url: c.assetUrl?.(String(o.asset)) } : {}) }));
    const spec: SceneSpec = {
      objects,
      bg: colour(p.bg) ?? 'transparent',
      light: String(p.light ?? 'studio'),
      cam: num(p.cam, 6),
      fov: num(p.fov, 40),
      orbit: p.orbit !== false,
      autorotate: num(p.autorotate, 0),
      particles: num(p.particles, 0),
      floor: p.floor === true,
      parallax: p.parallax === true,
    };
    return { inner: `<span class="rk-poster">${c.icon('ui/cube', 28)}<span>Loading ${c.esc(label ?? '3D scene')}…</span><small>The 3D view appears here once it loads</small></span><div class="rk-3d" data-scene="${c.esc(JSON.stringify(spec))}"></div>`, attrs: ['role="img"', `aria-label="${c.esc(label ?? '3D scene')}"`] };
  },
  wallet: (n, vr, label, c) => {
    const s = vr.state;
    const addr = short(String(n.props?.address ?? SAMPLE_ADDRESS));
    if (s === 'connecting') return { inner: `<span class="rk-spin"></span>Confirm in wallet…`, attrs: ['aria-busy="true"'] };
    if (s === 'wrong-network') return { inner: `${c.icon('ui/alert', 16)}${c.esc(label ?? 'Switch network')}` };
    if (s === 'connected') {
      const bal = n.props?.balance ? `<span class="rk-bal">${c.esc(String(n.props.balance))}</span>` : '';
      return { inner: `${bal}<span class="rk-dot" aria-hidden></span><span class="rk-addr">${c.esc(addr)}</span>${c.icon('ui/chevron-down', 14)}` };
    }
    return { inner: `${c.icon('ui/wallet', 16)}${c.esc(label ?? 'Connect wallet')}` };
  },
  address: (n, _v, _l, c) => {
    const a = String(n.props?.value ?? SAMPLE_ADDRESS);
    return { inner: `<span class="rk-a" title="${c.esc(a)}">${c.esc(short(a))}</span><span class="rk-copy" aria-label="Copy address">${c.icon('ui/copy', 14)}</span>` };
  },
  txstatus: (n, vr, label, c) => {
    const s = vr.state ?? 'pending';
    const copy: Record<string, [string, string]> = {
      preparing: ['Preparing transaction…', ''],
      confirm: ['Confirm in your wallet', 'Waiting for your signature'],
      submitted: ['Transaction sent', 'Waiting for the network to pick it up'],
      pending: ['Confirming…', `${n.props?.confirmations ?? '1/3'} confirmations`],
      success: ['Transaction confirmed', ''],
      failed: ['Transaction failed', String(n.props?.reason ?? 'You don’t have enough to cover the network fee.')],
    };
    const [title, sub] = copy[s] ?? copy.pending!;
    const icon = s === 'success' ? c.icon('ui/check', 16) : s === 'failed' ? c.icon('ui/alert', 16) : '<span class="rk-spin"></span>';
    const hash = n.props?.hash ? String(n.props.hash) : ['submitted', 'pending', 'success', 'failed'].includes(s) ? '0x9f3c1b7a4e2d8f60' : '';
    return {
      inner: `<span class="rk-ic rk-${s}">${icon}</span><span class="rk-body"><b>${c.esc(title)}</b>${label ? `<span>${c.esc(label)}</span>` : ''}${sub ? `<span>${c.esc(sub)}</span>` : ''}${hash ? `<a class="rk-link" href="#">View on explorer ${c.esc(short(hash))} ${c.icon('ui/external', 12)}</a>` : ''}</span>`,
      attrs: ['role="status"'],
    };
  },
};

export const WEB3_LIBRARY: Record<string, Def> = {
  Scene3D: {
    id: 'Scene3D', name: 'Scene3D', tag: 'div', role: 'img', labelProp: 'label', anatomy: 'scene3d',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'none' }, size: { w: { kind: 'fill' }, h: { kind: 'fixed', v: 360 } }, style: { radius: t('radius.card'), clip: true } }],
    doc: {
      category: 'Media',
      description: 'Real-time 3D (three.js). objects="shape key=value | …". Shapes: box sphere torus torusknot cone cylinder capsule plane ring icosahedron octahedron dodecahedron coin gem blob lathe text extrude model. Keys: x y z rx ry rz s sx sy sz color emissive glow mat(matte plastic metal chrome gold glass neon clay toon) metal rough opacity glass wire map(url) spin axis float orbit pulse copies radius stepx stepy; extrude: icon= depth bevel; text: text=HELLO_WORLD depth; lathe: profile=x,y;x,y; blob: noise; model: url.',
      props: {
        objects: { type: 'string', default: DEFAULT_OBJECTS, description: 'objects, | separated' },
        light: { type: 'string', default: 'studio', description: 'studio | soft | neon | dramatic' },
        bg: { type: 'string', default: 'transparent', description: 'colour or transparent' },
        cam: { type: 'number', default: 6, description: 'camera distance' },
        fov: { type: 'number', default: 40, description: 'field of view' },
        orbit: { type: 'boolean', default: true, description: 'drag to rotate on the live page' },
        autorotate: { type: 'number', default: 0, description: 'orbit speed; 0 = off' },
        particles: { type: 'number', default: 0, description: 'floating points (max 4000)' },
        floor: { type: 'boolean', default: false, description: 'grid floor' },
        parallax: { type: 'boolean', default: false, description: 'camera follows the pointer' },
      },
      example: '@Scene3D h320 light=neon particles=300 objects="torusknot color=primary.400 metal=.9 rough=.15 spin=.5 float=1" "Rotating knot"',
    },
  },
  WalletButton: {
    id: 'WalletButton', name: 'WalletButton', tag: 'button', role: 'action', labelProp: 'label', anatomy: 'wallet',
    axes: { state: ['disconnected', 'connecting', 'wrong-network', 'connected'] }, defaults: { state: 'disconnected' },
    styles: [
      { when: {}, layout: { mode: 'row', gap: t('space.2'), align: 'center', justify: 'center', padding: [0, t('space.4'), 0, t('space.4')] }, size: { h: { kind: 'fixed', v: t('size.control.md') }, w: { kind: 'hug' } }, style: { radius: t('radius.control'), textStyle: t('textStyle.label'), fill: [t('color.action.primary')], color: t('color.text.onPrimary'), shadow: t('shadow.control') } },
      { when: { state: 'connected' }, style: { fill: [t('color.bg.subtle')], color: t('color.text.primary') } },
      { when: { state: 'wrong-network' }, style: { fill: [t('color.status.error.bg')], color: t('color.status.error.fg') } },
    ],
    doc: { category: 'Web3', description: 'Every wallet condition has its own state, so people always know what to do next.', props: { address: { type: 'string', description: 'wallet address (shown shortened)' }, balance: { type: 'string', description: 'e.g. 1.24 ETH' } }, example: '@WalletButton state=connected balance="1.24 ETH"' },
  },
  Address: {
    id: 'Address', name: 'Address', tag: 'span', role: 'text', labelProp: 'label', anatomy: 'address',
    axes: {}, defaults: {},
    styles: [{ when: {}, layout: { mode: 'row', gap: t('space.1'), align: 'center' }, style: { textStyle: t('textStyle.code'), color: t('color.text.primary') } }],
    doc: { category: 'Web3', description: 'Wallet or contract address, shortened, with copy.', noLabel: true, props: { value: { type: 'string', description: '0x… or a name' } }, example: '@Address value=0x71C7656EC7ab88b098defB751B7401B5f6d8976F' },
  },
  TxStatus: {
    id: 'TxStatus', name: 'TxStatus', tag: 'div', role: 'status', labelProp: 'detail', anatomy: 'txstatus',
    axes: { state: ['preparing', 'confirm', 'submitted', 'pending', 'success', 'failed'] }, defaults: { state: 'pending' },
    styles: [{ when: {}, layout: { mode: 'row', gap: t('space.3'), padding: [t('space.3'), t('space.3'), t('space.3'), t('space.3')] }, size: { w: { kind: 'fill' } }, style: { fill: [t('color.bg.surface')], stroke: { paint: t('color.border.default'), width: 1, align: 'inside' }, radius: t('radius.card'), textStyle: t('textStyle.body-sm'), color: t('color.text.secondary') } }],
    doc: { category: 'Web3', description: 'One transaction through its stages, with an explorer link and a plain-language failure reason.', props: { hash: { type: 'string', description: 'transaction hash' }, confirmations: { type: 'string', default: '1/3', description: 'pending progress' }, reason: { type: 'string', description: 'plain-language failure' } }, example: '@TxStatus state=pending confirmations="2/3" "Swap 1 ETH for 3,200 USDC"' },
  },
};

export const WEB3_CSS: Record<string, string> = {
  Scene3D: `.rc-Scene3D{position:relative;background:${v('color.bg.subtle')}}.rc-Scene3D .rk-3d{position:absolute;inset:0}.rc-Scene3D .rk-poster{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:${v('color.text.secondary')};font:var(--textStyle-caption)}.rc-Scene3D .rk-3d[data-ready]{background:transparent}.rc-Scene3D:has(.rk-3d[data-ready]){background:transparent}.rc-Scene3D:has(.rk-3d[data-ready]) .rk-poster{display:none}`,
  WalletButton: `.rc-WalletButton{cursor:pointer;border:0;white-space:nowrap}.rc-WalletButton .rk-bal{padding-right:8px;border-right:1px solid ${v('color.border.strong')};font-variant-numeric:tabular-nums}.rc-WalletButton .rk-dot{width:8px;height:8px;border-radius:50%;background:${v('color.status.success.fg')}}.rc-WalletButton .rk-addr{font-family:${v('font.family.mono')}}`,
  Address: `.rc-Address .rk-copy{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:4px;color:${v('color.text.secondary')};cursor:pointer}.rc-Address .rk-copy:hover{background:${v('color.bg.subtle')}}`,
  TxStatus: `.rc-TxStatus .rk-ic{display:grid;place-items:center;width:28px;height:28px;border-radius:50%;flex-shrink:0;background:${v('color.status.info.bg')};color:${v('color.status.info.fg')}}.rc-TxStatus .rk-success{background:${v('color.status.success.bg')};color:${v('color.status.success.fg')}}.rc-TxStatus .rk-failed{background:${v('color.status.error.bg')};color:${v('color.status.error.fg')}}.rc-TxStatus .rk-body{display:flex;flex-direction:column;gap:2px;min-width:0}.rc-TxStatus b{color:${v('color.text.primary')};font-weight:600}.rc-TxStatus .rk-link{display:inline-flex;align-items:center;gap:4px;color:${v('color.text.link')};text-decoration:none}`,
};
