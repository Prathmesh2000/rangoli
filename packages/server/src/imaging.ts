/**
 * Pixel work for Image Studio, done in the system browser's canvas (no native image library):
 * probe (header parsing), non-destructive edits, encoding, placeholders, frame → image export.
 */
import { renderCss, renderFragment, validateOps, type AssetMeta, type EditOp, type ImageFormat, type RangoliDocument } from '@rangoli/engine';
import { browser } from './shots.js';

/** Width/height from file headers (PNG, JPEG, WebP, GIF, SVG). */
export function probe(buf: Buffer, mime: string): { w: number; h: number } {
  if (mime === 'image/png' && buf.length > 24 && buf.toString('ascii', 1, 4) === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (mime === 'image/gif' && buf.length > 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  if (mime === 'image/jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]!;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + len;
    }
  }
  if (mime === 'image/webp' && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    if (chunk === 'VP8L') {
      const b = buf.readUInt32LE(21);
      return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
    }
    if (chunk === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
  }
  if (mime === 'image/svg+xml') {
    const s = buf.toString('utf8', 0, Math.min(buf.length, 4000));
    const w = /\bwidth="(\d+(?:\.\d+)?)/.exec(s)?.[1], h = /\bheight="(\d+(?:\.\d+)?)/.exec(s)?.[1];
    if (w && h) return { w: Math.round(+w), h: Math.round(+h) };
    const vb = /viewBox="[\d.\s-]*?(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/.exec(s);
    if (vb) return { w: Math.round(+vb[1]!), h: Math.round(+vb[2]!) };
  }
  throw new Error(`Cannot read dimensions of this ${mime} file`);
}

const dataUri = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;

/** Run a canvas pipeline in the browser. Returns the encoded image. */
export async function editImage(buf: Buffer, mime: string, ops: EditOp[], format: ImageFormat, quality = 82): Promise<{ buf: Buffer; w: number; h: number }> {
  const src = probe(buf, mime);
  validateOps(ops, src.w, src.h);
  const b = await browser();
  const p = await b.newPage({ viewport: { width: 800, height: 600 } });
  try {
    await p.setContent('<!doctype html><body></body>');
    const out = await p.evaluate(
      async (a: { uri: string; ops: EditOp[]; type: string; q: number }) => {
        const img = new Image();
        img.src = a.uri;
        await img.decode();
        let c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        c.getContext('2d')!.drawImage(img, 0, 0);
        const next = (w: number, h: number, draw: (x: CanvasRenderingContext2D, prev: HTMLCanvasElement) => void) => {
          const n = document.createElement('canvas');
          n.width = Math.max(1, Math.round(w));
          n.height = Math.max(1, Math.round(h));
          const x = n.getContext('2d')!;
          x.imageSmoothingQuality = 'high';
          draw(x, c);
          c = n;
        };
        for (const o of a.ops) {
          if (o.op === 'crop') next(o.w, o.h, (x, prev) => x.drawImage(prev, o.x, o.y, o.w, o.h, 0, 0, o.w, o.h));
          else if (o.op === 'resize') {
            const h = o.h ?? (o.w / c.width) * c.height;
            // step down by halves for clean downscaling
            while (c.width / 2 >= o.w * 1.01) next(c.width / 2, c.height / 2, (x, prev) => x.drawImage(prev, 0, 0, prev.width / 2, prev.height / 2));
            next(o.w, h, (x, prev) => x.drawImage(prev, 0, 0, o.w, h));
          } else if (o.op === 'rotate') {
            const swap = o.deg !== 180;
            next(swap ? c.height : c.width, swap ? c.width : c.height, (x, prev) => {
              x.translate(x.canvas.width / 2, x.canvas.height / 2);
              x.rotate((o.deg * Math.PI) / 180);
              x.drawImage(prev, -prev.width / 2, -prev.height / 2);
            });
          } else if (o.op === 'flip') next(c.width, c.height, (x, prev) => {
            if (o.axis === 'h') { x.translate(prev.width, 0); x.scale(-1, 1); } else { x.translate(0, prev.height); x.scale(1, -1); }
            x.drawImage(prev, 0, 0);
          });
          else if (o.op === 'adjust') next(c.width, c.height, (x, prev) => {
            x.filter = `brightness(${o.brightness ?? 1}) contrast(${o.contrast ?? 1}) saturate(${o.saturation ?? 1})`;
            x.drawImage(prev, 0, 0);
          });
        }
        if (a.type === 'image/jpeg') next(c.width, c.height, (x, prev) => { x.fillStyle = '#fff'; x.fillRect(0, 0, prev.width, prev.height); x.drawImage(prev, 0, 0); });
        return { uri: c.toDataURL(a.type, a.q / 100), w: c.width, h: c.height };
      },
      { uri: dataUri(buf, mime), ops, type: `image/${format}`, q: quality },
    );
    const b64 = out.uri.slice(out.uri.indexOf(',') + 1);
    if (!out.uri.startsWith(`data:image/${format}`)) throw new Error(`This browser cannot encode ${format}`);
    return { buf: Buffer.from(b64, 'base64'), w: out.w, h: out.h };
  } finally {
    await p.close();
  }
}

/** Tiny blurred preview (16px wide WebP) as a data URI — for loading states. */
export async function placeholder(buf: Buffer, mime: string): Promise<string> {
  const { w } = probe(buf, mime);
  const r = await editImage(buf, mime, w > 16 ? [{ op: 'resize', w: 16 }] : [], 'webp', 50);
  return dataUri(r.buf, 'image/webp');
}

/** Render a frame (composition) to an image at 1x/2x/3x. */
export async function composeImage(doc: RangoliDocument, frameId: string, format: ImageFormat, scale: number, assetUrl: (m: AssetMeta) => string): Promise<{ buf: Buffer; w: number; h: number }> {
  if (!doc.findNode(frameId)) throw new Error(`#${frameId} not found`);
  const frag = renderFragment(doc, { roots: [frameId], assetUrl });
  const css = renderCss(doc, frag.css, frag.usedComponents);
  const b = await browser();
  const p = await b.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: scale });
  try {
    await p.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;background:transparent}#c{display:inline-block}[data-rid],*{animation:none!important;transition:none!important}</style></head><body><div id="c">${frag.html}</div></body></html>`);
    await p.evaluate(() => Promise.all(Array.from(document.querySelectorAll('img')).map((i) => i.decode().catch(() => undefined))), undefined);
    const png = await (p as unknown as { locator(s: string): { screenshot(o?: object): Promise<Buffer> } }).locator('#c > *').screenshot({ omitBackground: true });
    const { w, h } = probe(png, 'image/png');
    if (format === 'png') return { buf: png, w, h };
    return editImage(png, 'image/png', [], format, 88);
  } finally {
    await p.close();
  }
}
