/**
 * Pixel work for Image Studio: probe (header parsing), non-destructive edits, encoding, placeholders, frame → image export.
 * Decoding and encoding go through the Renderer port (no native image library).
 */
import { renderCss, renderFragment, validateOps, type AssetMeta, type EditOp, type ImageFormat, type RangoliDocument } from '@rangoli/engine';
import { renderer } from './render/index.js';
import { probe } from './render/probe.js';

export { probe };

const dataUri = (buf: Buffer, mime: string) => `data:${mime};base64,${buf.toString('base64')}`;

/** Run a canvas pipeline in the browser. Returns the encoded image. */
export async function editImage(buf: Buffer, mime: string, ops: EditOp[], format: ImageFormat, quality = 82): Promise<{ buf: Buffer; w: number; h: number }> {
  const src = probe(buf, mime);
  validateOps(ops, src.w, src.h);
  return renderer().edit({ image: buf, mime, ops, format, quality });
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
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}
body{margin:0;background:transparent}#c{display:inline-block}[data-rid],*{animation:none!important;transition:none!important}</style></head><body><div id="c">${frag.html}</div></body></html>`;
  const png = await renderer().shot({ html, viewport: { width: 1600, height: 1200 }, scale, selector: '#c > *', omitBackground: true, prepare: { kind: 'decodeImages' } });
  const { w, h } = probe(png, 'image/png');
  if (format === 'png') return { buf: png, w, h };
  return editImage(png, 'image/png', [], format, 88);
}
