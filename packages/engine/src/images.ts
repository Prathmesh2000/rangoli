/**
 * Image Studio model (SPEC §12, Phase 6): assets (content-addressed files + metadata),
 * non-destructive edit recipes, image lint, and composition templates.
 * Binary work (decode/encode/rasterize) happens in the server; the engine stays pure.
 */
export type ImageFormat = 'png' | 'webp' | 'jpeg';

export type EditOp =
  | { op: 'crop'; x: number; y: number; w: number; h: number }
  | { op: 'resize'; w: number; h?: number }
  | { op: 'rotate'; deg: 90 | 180 | 270 }
  | { op: 'flip'; axis: 'h' | 'v' }
  | { op: 'adjust'; brightness?: number; contrast?: number; saturation?: number };

export interface AssetMeta {
  id: string;
  name: string;
  /** file name inside assets/ (hash + extension) */
  file: string;
  mime: string;
  w: number;
  h: number;
  bytes: number;
  alt?: string;
  source: 'upload' | 'edit' | 'compose';
  /** edit: original asset id · compose: frame id */
  from?: string;
  ops?: EditOp[];
  format?: ImageFormat;
  quality?: number;
  scale?: number;
  /** tiny blurred preview (data URI) for loading states */
  placeholder?: string;
  time: number;
}

export const MIME: Record<string, string> = { png: 'image/png', webp: 'image/webp', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', avif: 'image/avif' };
export const EXT: Record<string, string> = Object.fromEntries(Object.entries(MIME).filter(([k]) => k !== 'jpg').map(([k, v]) => [v, k]));

export function findAsset(assets: Record<string, AssetMeta> | undefined, ref: string): AssetMeta | undefined {
  if (!assets) return undefined;
  return assets[ref] ?? Object.values(assets).find((a) => a.name === ref || a.file === ref);
}

/** Validate + normalize an edit recipe; throws a readable error. */
export function validateOps(ops: EditOp[], w: number, h: number): { w: number; h: number } {
  let cw = w, ch = h;
  for (const o of ops) {
    switch (o.op) {
      case 'crop':
        if (o.w <= 0 || o.h <= 0 || o.x < 0 || o.y < 0 || o.x + o.w > cw || o.y + o.h > ch) throw new Error(`crop ${o.x},${o.y} ${o.w}×${o.h} is outside the ${cw}×${ch} image`);
        cw = o.w; ch = o.h;
        break;
      case 'resize': {
        if (o.w <= 0 || (o.h !== undefined && o.h <= 0) || o.w > 8192) throw new Error('resize must be 1–8192 px');
        const nh = o.h ?? Math.round((o.w / cw) * ch);
        cw = Math.round(o.w); ch = Math.round(nh);
        break;
      }
      case 'rotate':
        if (![90, 180, 270].includes(o.deg)) throw new Error('rotate supports 90, 180, 270');
        if (o.deg !== 180) [cw, ch] = [ch, cw];
        break;
      case 'flip':
        if (o.axis !== 'h' && o.axis !== 'v') throw new Error('flip axis must be h or v');
        break;
      case 'adjust':
        for (const k of ['brightness', 'contrast', 'saturation'] as const) {
          const v = o[k];
          if (v !== undefined && (v < 0 || v > 3)) throw new Error(`${k} must be 0–3 (1 = unchanged)`);
        }
        break;
      default:
        throw new Error(`Unknown edit op ${(o as { op: string }).op}`);
    }
  }
  return { w: cw, h: ch };
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------------------------------------------------------------- composition templates

/**
 * Starting points for composed images. They are ordinary frames (role:image), so they stay
 * editable, lintable and themeable — not AI pictures. Agents fill in real content.
 */
export const IMAGE_TEMPLATES: Record<string, { description: string; size: string; rdl: (title: string) => string }> = {
  'social-card': {
    description: 'Open Graph / link preview, 1200×630',
    size: '1200×630',
    // seen as a small thumbnail in feeds: one big idea, large type, few elements
    rdl: (t) => `SocialCard col w1200 h630 p16 between fill:surface role:image name:"Social card"
  Brand row gap3 center
    Mark w44 h44 fill:primary.600 r3 middle
      Icon icon:check w28 h28 color:white
    Text size:30 weight:600 "${t}"
  Body col gap5 maxw960
    Text size:68 weight:700 "Catch flaky tests before your users do."
    Text size:30 muted "Runs, suites and results — in one calm place."
  Footer row gap3 center
    Line w48 h4 fill:primary.600 rfull
    Text size:24 muted "yourcompany.com"`,
  },
  'empty-state': {
    description: 'Empty-state illustration, 320×200, built from icons and shapes',
    size: '320×200',
    rdl: () => `EmptyArt col w320 h200 middle fill:canvas r4 role:image name:"Empty state art"
  Stack none w160 h120
    Back at:20,20 w120 h84 fill:subtle stroke:border r4
    Front at:40,36 w120 h84 fill:surface stroke:border r4 col p3 gap2
      Line1 w72 h8 fill:subtle rfull
      Line2 w96 h8 fill:subtle rfull
      Line3 w56 h8 fill:subtle rfull
    Badge at:124,8 w32 h32 fill:primary.50 rfull middle
      Icon icon:search w18 h18 color:primary.600`,
  },
  banner: {
    description: 'Wide banner / header image, 1440×320',
    size: '1440×320',
    // images are exported once, so they use fixed ramp colours (not light/dark semantic tokens)
    // product-specific motif (a stylised run list), not a decorative blob
    rdl: (t) => `Banner row w1440 h320 px16 between center fill:neutral.900 role:image name:"Banner"
  Copy col gap4 maxw720
    Text size:52 weight:700 color:white "${t}"
    Text size:22 color:neutral.300 "One sentence that says what changed and why it matters."
  Runs col gap2 w440 p5 fill:neutral.800 r4
    Run1 row gap3 center p3 fill:neutral.900 r3
      Icon icon:check w18 h18 color:success.300
      Bar1 w220 h8 fill:neutral.700 rfull
      Pill1 w56 h8 fill:success.400 rfull
    Run2 row gap3 center p3 fill:neutral.900 r3
      Icon icon:close w18 h18 color:error.300
      Bar2 w180 h8 fill:neutral.700 rfull
      Pill2 w56 h8 fill:error.400 rfull
    Run3 row gap3 center p3 fill:neutral.900 r3
      Icon icon:retry w18 h18 color:warning.300
      Bar3 w200 h8 fill:neutral.700 rfull
      Pill3 w56 h8 fill:warning.400 rfull`,
  },
};

// ---------------------------------------------------------------- lint

export interface ImageIssue {
  code: string;
  severity: 'P0' | 'P1' | 'P2' | 'P3';
  node: string;
  message: string;
  fix?: string;
}
